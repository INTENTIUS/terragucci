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
 *
 * Describe runs before the job has a cloud credential, so it skips the YAML
 * functions that read state (`!terraform.state`, `!terraform.output`) and
 * stores (`!store`, refused). A var set by `!terraform.state <component>
 * [<stack>] <output>` is a read: its upstream is a dependency, and the stage
 * fills the var from the upstream's outputs once it has credentials
 * (fillReads), holding the instance back while the upstream has no state, as
 * a root that reads an unapplied `terraform_remote_state` is held back. Each
 * instance's edges are written beside it in `.terragucci-atmos.json`, which
 * the stages read for affected selection and for those reads.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { WORKSPACE_FILE, workspaceInit } from "./backend";
import { binaryEnv, terragruntExec } from "./binary-env";
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
  /** The instances it depends on, by path: `dependencies.components`, `settings.depends_on`, and the upstream of each read. */
  dependencies: string[];
  /** The vars it reads from another instance's outputs, which the stage fills in. */
  reads: AtmosRead[];
}

/** A var set by `!terraform.state` or `!terraform.output`: the stage reads it from the upstream's state. */
export interface AtmosRead {
  /** The var it sets. */
  var: string;
  /** The instance whose outputs it reads, by path. */
  upstream: string;
  /** The output, then the keys into its value: `.subnets.private` is `["subnets", "private"]`. */
  output: string[];
  /** The function as describe left it. */
  function: string;
}

/** The file beside each instance naming its edges and its component's directory: `{ component, dependencies, reads }`. */
export const EDGES_FILE = ".terragucci-atmos.json";

/** The same file beside each Terramate stack, which `terragucci terramate generate` writes (./terramate.ts). */
export const TERRAMATE_EDGES_FILE = ".terragucci-terramate.json";

/** The varfile the stage writes with the values of an instance's reads, before it plans. */
export const READS_VARFILE = "terragucci-atmos-reads.auto.tfvars.json";

/** The YAML functions describe skips, since they read state or a store the job has no credential for yet. */
export const SKIPPED_FUNCTIONS = ["terraform.state", "terraform.output", "store", "store.get"] as const;

const FUNCTION = /^!(terraform\.state|terraform\.output|store\.get|store)(\s|$)/;

/** Split a function's arguments on spaces, keeping a quoted one whole, its quotes dropped. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * The read a var's value names, when it is a `!terraform.state` or
 * `!terraform.output` that describe skipped; undefined for any other value.
 * Refused: a store, a function inside a map or a list, and an output
 * expression other than an output name or a path of keys into it.
 */
export function parseRead(path: string, stack: string, name: string, value: unknown): Omit<AtmosRead, "upstream"> & { component: string; stack: string } | undefined {
  if (typeof value !== "string") {
    const nested = (v: unknown): string | undefined =>
      typeof v === "string" ? (FUNCTION.test(v) ? v : undefined) : v && typeof v === "object" ? Object.values(v).map(nested).find((x) => x) : undefined;
    const inner = nested(value);
    if (inner) throw new ConfigError(`${path} sets ${name} with ${inner.split(/\s/)[0]} inside a map or a list; terragucci reads a whole var only, so give the function a var of its own`);
    return undefined;
  }
  const m = value.match(FUNCTION);
  if (!m) return undefined;
  const fn = m[1];
  if (fn === "store" || fn === "store.get") {
    throw new ConfigError(`${path} sets ${name} with !${fn}, which terragucci does not read in the job; output the value from an instance and read it with !terraform.state`);
  }
  const args = splitArgs(value.slice(m[0].length));
  if (args.length !== 2 && args.length !== 3) throw new ConfigError(`${path} sets ${name} with "${value}"; terragucci reads !${fn} <component> [<stack>] <output>`);
  const expr = args[args.length - 1];
  if (!/^\.?[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/.test(expr)) {
    throw new ConfigError(`${path} sets ${name} with "${value}", whose expression ${expr} terragucci does not evaluate; read an output by name or by a path of keys, such as .subnets.private`);
  }
  return { var: name, component: args[0], stack: args.length === 3 ? args[1] : stack, output: expr.replace(/^\./, "").split("."), function: value };
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
    out = await exec(atmos, ["describe", "stacks", "--format", "json", "--component-types", "terraform", ...SKIPPED_FUNCTIONS.flatMap((f) => ["--skip", f])], { cwd: repo, env: { ...ATMOS_ENV } });
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
  type Found = AtmosInstance & { raw: RawEdge[]; ctx: Obj; rawReads: ReturnType<typeof parseRead>[] };
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
      const rawReads = Object.entries(obj(c.vars)).map(([name, v]) => parseRead(path, stack, name, v)).filter((r) => r !== undefined);
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
        reads: [],
        raw: rawEdges(c),
        ctx: obj(c.vars),
        rawReads,
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
    for (const r of f.rawReads) {
      const upstream = `${r!.stack}/${r!.component}`;
      const what = `${f.path} reads ${r!.var} from ${upstream} (${r!.function})`;
      if (upstream === f.path) throw new ConfigError(`${what}, its own state`);
      if (disabled.has(upstream)) throw new ConfigError(`${what}, which is disabled, so nothing ever applies it`);
      if (!byPath.has(upstream)) throw new ConfigError(`${what}, which no stack deploys`);
      // A read is an edge: the instance waits for the upstream it reads.
      deps.add(upstream);
      f.reads.push({ var: r!.var, upstream, output: r!.output, function: r!.function });
    }
    f.dependencies = [...deps].sort();
  }
  return found
    .map(({ raw: _r, ctx: _c, rawReads: _rr, ...i }) => i)
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
  // A read's var is left out: the stage writes it, read from the upstream's state, before it plans.
  const reads = new Set(i.reads.map((r) => r.var));
  const vars = Object.fromEntries(Object.entries(i.vars).filter(([k]) => !reads.has(k)));
  const out: Record<string, string> = {
    "terragucci-atmos.auto.tfvars.json": json(vars),
    [WORKSPACE_FILE]: `${i.workspace}\n`,
    [EDGES_FILE]: json({ component: i.componentPath, dependencies: i.dependencies, reads: i.reads }),
  };
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

/** The edges `terragucci atmos write` left beside the instance at `dir`; undefined for a directory that is no instance. */
export function atmosEdges(dir: string): { component?: string; dependencies: string[]; reads: AtmosRead[] } | undefined {
  // A Terramate stack's edges are in a file of their own, in the same form.
  const file = [join(dir, EDGES_FILE), join(dir, TERRAMATE_EDGES_FILE)].find((f) => existsSync(f));
  if (!file) return undefined;
  try {
    const v = JSON.parse(readFileSync(file, "utf-8")) as { component?: unknown; dependencies?: unknown; reads?: unknown };
    const dependencies = Array.isArray(v.dependencies) ? v.dependencies.filter((d): d is string => typeof d === "string") : [];
    const reads = (Array.isArray(v.reads) ? v.reads : []).filter(
      (r): r is AtmosRead => !!r && typeof r === "object" && typeof (r as AtmosRead).var === "string" && typeof (r as AtmosRead).upstream === "string" && Array.isArray((r as AtmosRead).output),
    );
    return { ...(typeof v.component === "string" ? { component: v.component } : {}), dependencies, reads };
  } catch {
    return undefined;
  }
}

/** For each root that is an Atmos instance, the instances whose state it reads: its reads' upstreams. */
export function atmosStateReads(repo: string, roots: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of roots) {
    const reads = atmosEdges(join(repo, r))?.reads ?? [];
    if (reads.length > 0) out.set(r, new Set(reads.map((x) => x.upstream)));
  }
  return out;
}

/** For each root that is an Atmos instance, every instance it depends on: `dependencies.components` and its reads. */
export function atmosDependencies(repo: string, roots: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of roots) {
    const deps = atmosEdges(join(repo, r))?.dependencies ?? [];
    if (deps.length > 0) out.set(r, new Set(deps));
  }
  return out;
}

/** An upstream's outputs, by name, or why they could not be read. */
export type UpstreamOutputs = { outputs: Record<string, unknown> } | { error: string };

/**
 * The outputs in the state of the instance at `dir`, read with `binary` in
 * its own workspace: init in default, select the workspace, then `output
 * -json`. An instance nothing applied has none. `turn` serialises the init
 * with the job's other inits, which share one provider cache.
 */
export async function upstreamOutputs(binary: string, dir: string, env: NodeJS.ProcessEnv, turn: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn()): Promise<UpstreamOutputs> {
  const run = (args: string[], e: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; err: string }> =>
    new Promise((done) => {
      const child = spawn(binary, [`-chdir=${dir}`, ...args], { env: binaryEnv(e), stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => err.push(d));
      child.on("error", (x) => err.push(Buffer.from(x.message)));
      child.on("close", (code) => done({ code, out: Buffer.concat(out).toString("utf-8"), err: Buffer.concat(err).toString("utf-8") }));
    });
  const tail = (s: string): string => s.trim().split("\n").slice(-6).join("\n");
  const ws = workspaceInit(env, dir);
  const init = await turn(() => run(["init", "-input=false", "-no-color"], ws?.init ?? env));
  if (init.code !== 0) return { error: `init failed: ${tail(init.err || init.out)}` };
  if (ws) {
    const sel = await run(ws.select, ws.selectEnv);
    if (sel.code !== 0) return { error: `workspace select failed: ${tail(sel.err || sel.out)}` };
  }
  const got = await run(["output", "-json", "-no-color"], env);
  if (got.code !== 0) return { error: `output -json failed: ${tail(got.err || got.out)}` };
  try {
    const outputs = obj(JSON.parse(got.out || "{}"));
    return { outputs: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, obj(v).value])) };
  } catch {
    return { error: `output -json printed no JSON: ${tail(got.out)}` };
  }
}

/** The value a read names in its upstream's outputs, or undefined when the outputs do not have it. */
export function readValue(outputs: Record<string, unknown>, output: readonly string[]): { value: unknown } | undefined {
  const [name, ...keys] = output;
  if (!(name in outputs)) return undefined;
  let v: unknown = outputs[name];
  for (const k of keys) {
    if (!v || typeof v !== "object" || Array.isArray(v) || !(k in (v as Obj))) return undefined;
    v = (v as Obj)[k];
  }
  return { value: v };
}

/** What filling an instance's reads came to. */
export interface FilledReads {
  /** The reads whose upstream has no such value yet: the instance waits for these upstreams to apply. */
  waiting: { read: AtmosRead; why: string }[];
  /** Upstreams whose state could not be read at all. */
  errors: string[];
  /** The vars written, by name. */
  filled: string[];
}

/**
 * Fill the reads of the instance at `<repo>/<root>`: read each upstream's
 * outputs once (`outputsOf`, which the caller caches) and write the values to
 * READS_VARFILE. A read whose upstream has no state, or no such output yet,
 * is waiting, and nothing is written: the instance must not plan on a stand-in.
 */
export async function fillReads(repo: string, root: string, outputsOf: (upstream: string) => Promise<UpstreamOutputs>): Promise<FilledReads> {
  const edges = atmosEdges(join(repo, root));
  const result: FilledReads = { waiting: [], errors: [], filled: [] };
  if (!edges || edges.reads.length === 0) return result;
  const values: Record<string, unknown> = {};
  for (const read of edges.reads) {
    const got = await outputsOf(read.upstream);
    if ("error" in got) {
      result.errors.push(`${root} reads ${read.var} from ${read.upstream}, whose state could not be read: ${got.error}`);
      continue;
    }
    const v = readValue(got.outputs, read.output);
    if (!v) {
      const why = Object.keys(got.outputs).length === 0 ? "has no state yet" : `has no output ${read.output.join(".")} yet`;
      result.waiting.push({ read, why });
      continue;
    }
    values[read.var] = v.value;
  }
  if (result.waiting.length === 0 && result.errors.length === 0) {
    writeFileSync(join(repo, root, READS_VARFILE), `${JSON.stringify(values, null, 2)}\n`);
    result.filled = Object.keys(values).sort();
  }
  return result;
}

/**
 * Where each instance keeps its state, as Atmos lays it out, and the
 * instances whose state it reads: what `config check` lists for each role
 * without writing the instances. An s3 backend's state is at
 * `<workspace_key_prefix>/<workspace>/<key>`; another backend's is named by
 * its workspace alone.
 */
export function instanceStates(instances: readonly AtmosInstance[]): { states: Map<string, { bucket?: string; key: string } | undefined>; reads: Map<string, Set<string>> } {
  const states = new Map<string, { bucket?: string; key: string } | undefined>();
  for (const i of instances) {
    const key = str(i.backend.key) ?? "terraform.tfstate";
    if (i.backendType === "s3") states.set(i.path, { ...(str(i.backend.bucket) ? { bucket: i.backend.bucket as string } : {}), key: `${str(i.backend.workspace_key_prefix) ?? i.component}/${i.workspace}/${key}` });
    else states.set(i.path, i.backendType ? { key: `${i.backendType}:${i.workspace}` } : undefined);
  }
  return { states, reads: new Map(instances.map((i) => [i.path, new Set(i.reads.map((r) => r.upstream))])) };
}
