/**
 * Atmos mode: how terragucci tells an Atmos repo, finds its component
 * instances, and writes each one where the plain-root jobs run it.
 *
 * A root is an instance, named `<stack>/<component>`. The instances, their
 * variables, backends, workspaces and `dependencies.components` come from
 * `atmos describe stacks`, so terragucci never evaluates Atmos's imports,
 * inheritance or templates. Abstract and disabled instances are left out.
 *
 * Every job writes the instances before it reads them (`terragucci atmos
 * write`, run as the pipeline's synth): the component's Terraform copied to
 * `<stack>/<component>`, with the varfile, backend and provider override
 * Atmos would generate for it, and the instance's Terraform workspace in
 * `.terragucci-workspace`. The jobs run the binary there with `TF_WORKSPACE`
 * set to it (workspaceEnv in ./backend.ts), so each instance plans and
 * applies its own state, never the `default` workspace's.
 *
 * The waves are the dependency layers of the instances, as Terragrunt units'
 * are: no instance of a wave depends on another instance of it.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { WORKSPACE_FILE } from "./backend";
import { terragruntExec } from "./binary-env";
import { ConfigError } from "./config";
import { unitWaves } from "./terragrunt";

/** The Atmos release the jobs install, checked against the release's SHA256SUMS. */
export const ATMOS_VERSION = "1.230.1";

/** The file that marks an Atmos repo, at its root. */
export const ATMOS_MARKER = "atmos.yaml";

/** The command every job runs before it reads the roots: it writes the instances. */
export const ATMOS_WRITE = "terragucci atmos write";

/** Whether `repo` is an Atmos repo: the reason (the marker's path), or undefined. */
export function detectAtmos(repo: string): string | undefined {
  return existsSync(join(repo, ATMOS_MARKER)) ? ATMOS_MARKER : undefined;
}

/** The synth a repo's jobs run: its own `synth`, else the Atmos write in an Atmos repo. */
export function effectiveSynth(repo: string, synth: string | undefined): string | undefined {
  return synth ?? (detectAtmos(repo) ? ATMOS_WRITE : undefined);
}

/** One deployed instance of a Terraform component in a stack. */
export interface AtmosInstance {
  /** `<stack>/<component>`: the root's name, and where it is written. */
  path: string;
  stack: string;
  component: string;
  /** The Terraform directory the instance runs, from the repo. */
  componentPath: string;
  /** The Terraform workspace Atmos selects for it. */
  workspace: string;
  vars: Record<string, unknown>;
  backendType: string;
  backend: Record<string, unknown>;
  providers: Record<string, unknown>;
  /** The instances it depends on, by path. */
  dependencies: string[];
}

export interface AtmosOptions {
  /** The `atmos` executable. Default: `TERRAGUCCI_ATMOS`, then `atmos` on the path. */
  atmos?: string;
  exec?: TerragruntExec;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const posix = (p: string): string => p.split(sep).join("/");

/** The environment Atmos runs with: no telemetry notice, and only warnings in the log. */
export const ATMOS_ENV = { ATMOS_TELEMETRY_ENABLED: "false", ATMOS_LOGS_LEVEL: "Warning" } as const;

/** `atmos describe stacks` as JSON, run from the repo. */
export async function describeStacks(repo: string, options: AtmosOptions = {}): Promise<Obj> {
  const atmos = options.atmos ?? process.env.TERRAGUCCI_ATMOS ?? "atmos";
  const exec = options.exec ?? terragruntExec;
  let out: Awaited<ReturnType<TerragruntExec>>;
  try {
    out = await exec(atmos, ["describe", "stacks", "--format", "json", "--component-types", "terraform"], { cwd: repo, env: { ...ATMOS_ENV } });
  } catch (e) {
    throw new ConfigError(`atmos describe stacks did not run (${(e as Error).message}); put Atmos ${ATMOS_VERSION} on the path, or set TERRAGUCCI_ATMOS`);
  }
  if (out.code !== 0) {
    const why = (out.stderr || out.stdout).trim().split("\n").filter((l) => l.trim()).slice(0, 12).join("\n");
    throw new ConfigError(
      out.code === null || /ENOENT|not found/.test(why)
        ? `atmos describe stacks did not run (${why.split("\n")[0]}); put Atmos ${ATMOS_VERSION} on the path, or set TERRAGUCCI_ATMOS`
        : `atmos describe stacks failed (exit ${out.code}):\n${why}`,
    );
  }
  try {
    return obj(JSON.parse(out.stdout));
  } catch {
    throw new ConfigError(`atmos describe stacks printed no JSON:\n${out.stdout.slice(0, 400)}`);
  }
}

/** Atmos's context fields, which a dependency may name in place of a stack. */
const CONTEXT = ["namespace", "tenant", "environment", "stage"] as const;

interface RawEdge {
  component: string;
  stack?: string;
  context: Partial<Record<(typeof CONTEXT)[number], string>>;
}

/** The edges a component's `dependencies.components` and `settings.depends_on` name. */
function rawEdges(c: Obj): RawEdge[] {
  const out: RawEdge[] = [];
  const add = (e: Obj): void => {
    const component = str(e.component);
    if (!component) return;
    const context: RawEdge["context"] = {};
    for (const k of CONTEXT) if (str(e[k])) context[k] = e[k] as string;
    out.push({ component, ...(str(e.stack) ? { stack: e.stack as string } : {}), context });
  };
  const deps = obj(c.dependencies).components;
  if (Array.isArray(deps)) for (const e of deps) add(obj(e));
  // Atmos's older form, a map of dependencies by key; still read by Atmos, so read here too.
  for (const e of Object.values(obj(obj(c.settings).depends_on))) add(obj(e));
  return out;
}

/**
 * The instances `atmos describe stacks` lists, sorted by path, each with the
 * instances it depends on. An abstract instance (`metadata.type: abstract`)
 * or a disabled one (`metadata.enabled: false`) is not a root, and an edge to
 * a disabled one holds nothing back. An edge to an instance no stack has is
 * refused: Atmos's order is explicit, so a missing upstream is a mistake.
 */
export function atmosInstances(stacks: Obj): AtmosInstance[] {
  type Found = AtmosInstance & { raw: RawEdge[]; ctx: Obj };
  const found: Found[] = [];
  const disabled = new Set<string>();
  for (const [stack, s] of Object.entries(stacks)) {
    for (const [component, value] of Object.entries(obj(obj(obj(s).components).terraform))) {
      const c = obj(value);
      const meta = obj(c.metadata);
      if (meta.type === "abstract") continue;
      const path = `${stack}/${component}`;
      if (meta.enabled === false) {
        disabled.add(path);
        continue;
      }
      for (const key of ["env", "generate"] as const) {
        if (Object.keys(obj(c[key])).length > 0) {
          throw new ConfigError(`${path} sets ${key}, which terragucci does not carry into the jobs yet; move it into the component's Terraform, or leave the instance out with metadata.enabled: false`);
        }
      }
      const componentPath = str(obj(c.component_info).component_path) ?? `components/terraform/${str(meta.component) ?? str(c.component) ?? component}`;
      found.push({
        path,
        stack,
        component,
        componentPath: posix(componentPath),
        workspace: str(c.workspace) ?? stack,
        vars: obj(c.vars),
        backendType: str(c.backend_type) ?? "",
        backend: obj(c.backend),
        providers: obj(c.providers),
        dependencies: [],
        raw: rawEdges(c),
        ctx: obj(c.vars),
      });
    }
  }
  const byPath = new Map(found.map((f) => [f.path, f]));
  for (const f of found) {
    const deps = new Set<string>();
    for (const e of f.raw) {
      let stack = e.stack;
      if (!stack && Object.keys(e.context).length > 0) {
        // Named by context: the stack whose instance of the component has those values, the rest as the dependent's.
        const want = Object.fromEntries(CONTEXT.map((k) => [k, e.context[k] ?? f.ctx[k]]));
        const hits = found.filter((g) => g.component === e.component && CONTEXT.every((k) => want[k] === undefined || g.ctx[k] === want[k]));
        stack = hits.length === 1 ? hits[0].stack : undefined;
        if (!stack) {
          const where = CONTEXT.filter((k) => want[k] !== undefined).map((k) => `${k} ${String(want[k])}`).join(", ");
          throw new ConfigError(`${f.path} depends on ${e.component} in ${where}, which ${hits.length === 0 ? "no stack has" : `${hits.length} stacks have`}`);
        }
      }
      const target = `${stack ?? f.stack}/${e.component}`;
      if (target === f.path) continue;
      if (disabled.has(target)) continue;
      if (!byPath.has(target)) throw new ConfigError(`${f.path} depends on ${target}, which no stack deploys`);
      deps.add(target);
    }
    f.dependencies = [...deps].sort();
  }
  return found
    .map(({ raw: _r, ctx: _c, ...i }) => i)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The waves the instances apply in: their dependency layers, the canary
 * instances' layers first, each sorted by path. A cycle is refused.
 */
export function instanceWaves(instances: readonly AtmosInstance[], canary: readonly string[] = []): string[][] {
  try {
    return unitWaves(
      instances.map((i) => ({ path: i.path, dependencies: i.dependencies })),
      canary,
    );
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
}

/** What a component directory holds that an instance's copy leaves out: what Atmos, init and an apply leave there. */
function skipped(name: string): boolean {
  return (
    name === ".terraform" ||
    name === "terraform.tfstate.d" ||
    /\.tfstate(\.backup)?$/.test(name) ||
    /\.planfile$/.test(name) ||
    name === "backend.tf.json" ||
    name === "providers_override.tf.json" ||
    name.endsWith(".terraform.tfvars.json")
  );
}

/**
 * Rewrite the local module sources in an instance's copy that reach outside
 * the component, so they reach the same directory from the copy's place.
 * Sources inside the component were copied with it and stay as they are.
 */
export function rewriteSources(text: string, fromDir: string, toDir: string, componentDir: string): string {
  return text.replace(/(\bsource\s*=\s*")(\.\.?\/[^"]*)(")/g, (all, head: string, rel: string, tail: string) => {
    const target = resolve(fromDir, rel);
    const inside = !relative(componentDir, target).startsWith("..");
    if (inside) return all;
    return `${head}${posix(relative(toDir, target))}${tail}`;
  });
}

function copyComponent(src: string, dest: string, componentDir: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    if (skipped(name)) continue;
    const from = join(src, name);
    const to = join(dest, name);
    if (statSync(from).isDirectory()) copyComponent(from, to, componentDir);
    else if (/\.(tf|tofu)$/.test(name)) writeFileSync(to, rewriteSources(readFileSync(from, "utf-8"), src, dest, componentDir));
    else cpSync(from, to);
  }
}

/** The files Atmos generates for an instance, by name: its varfile, backend and provider override. */
export function generatedFiles(i: AtmosInstance): Record<string, string> {
  const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
  const out: Record<string, string> = { "terragucci-atmos.auto.tfvars.json": json(i.vars), [WORKSPACE_FILE]: `${i.workspace}\n` };
  if (i.backendType === "cloud") out["backend.tf.json"] = json({ terraform: { cloud: i.backend } });
  else if (i.backendType) out["backend.tf.json"] = json({ terraform: { backend: { [i.backendType]: i.backend } } });
  if (Object.keys(i.providers).length > 0) out["providers_override.tf.json"] = json({ provider: i.providers });
  return out;
}

/**
 * Write each instance to `<repo>/<stack>/<component>`: the component's
 * Terraform, then the files Atmos would generate for it. A directory written
 * before (it holds `.terragucci-workspace`) is written again, its `.terraform`
 * kept; a directory of the repo's own is refused.
 */
export function writeInstances(repo: string, instances: readonly AtmosInstance[]): void {
  for (const i of instances) {
    const src = join(repo, i.componentPath);
    if (!existsSync(src) || !statSync(src).isDirectory()) throw new ConfigError(`${i.path} runs ${i.componentPath}, which the repo does not have`);
    const dest = join(repo, i.path);
    if (existsSync(dest)) {
      if (!existsSync(join(dest, WORKSPACE_FILE)) && readdirSync(dest).length > 0) {
        throw new ConfigError(`${i.path} is a directory of the repo, and the Atmos instance ${i.component} in stack ${i.stack} is written there; rename one of them`);
      }
      for (const name of readdirSync(dest)) if (name !== ".terraform") rmSync(join(dest, name), { recursive: true, force: true });
    }
    copyComponent(src, dest, resolve(src));
    for (const [name, content] of Object.entries(generatedFiles(i))) writeFileSync(join(dest, name), content);
  }
}

/** `terragucci atmos write`: describe the stacks and write every instance. The lines it prints. */
export async function atmosWrite(repo: string, options: AtmosOptions = {}): Promise<string[]> {
  const instances = atmosInstances(await describeStacks(repo, options));
  if (instances.length === 0) throw new ConfigError("atmos describe stacks lists no Terraform instance that is neither abstract nor disabled");
  writeInstances(repo, instances);
  return instances.map((i) => `${i.path}: ${i.componentPath} in workspace ${i.workspace}`);
}
