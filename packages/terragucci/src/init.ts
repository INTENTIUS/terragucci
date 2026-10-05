/**
 * `terragucci init`: set one repo up. It reads terragucci.yml when there is
 * one, detects what the file leaves out, writes the pipeline, and writes
 * terragucci.yml only when a choice it was given on the command line differs
 * from what it would detect. Run twice, the second run changes nothing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { emitYAML } from "@intentius/chant/yaml";
import { applyWaves, waveGate } from "./apply";
import {
  ConfigError,
  findConfig,
  loadConfig,
  resolveRepo,
  type Binary,
  type ForgeName,
  type ProjectSettings,
  type ResolvedSettings,
} from "./config";
import { applyLayers, detectBinary, detectForge, detectVersion, findRootsWithReasons, type RootReason } from "./detect";
import { imageFor, imageReference, terragruntImage, TOOL_VERSIONS, type ImageRef } from "./images";
import { dashboardSettings, renderDashboards, writtenByTerragucci } from "./dashboards";
import { reportsBase } from "./report/store";
import { MARKER, RenderError, renderPipeline, type PipelineInput } from "./render";
import { terragruntInstalls } from "./render-terragrunt";
import { detectTerragrunt, discoverUnits, parallelism, pinnedTerragrunt, unitWaves } from "./terragrunt";

export interface InitOptions {
  /** Choices from the command line; each overrides detection, and is saved to terragucci.yml. */
  forge?: ForgeName;
  binary?: Binary;
  /** Overwrite a pipeline file terragucci did not write. */
  force?: boolean;
  /** Settings to use instead of reading terragucci.yml: a control repo's project. */
  settings?: ResolvedSettings;
  /** Compute everything but write nothing. */
  dryRun?: boolean;
  /** The `terragrunt` executable discovery runs. Default: `TERRAGUCCI_TERRAGRUNT`, then `terragrunt` on the path. */
  terragrunt?: string;
  /** The repo's name, for a new chant.workspace.json. Default: the origin remote's last path segment, then the directory's name. */
  name?: string;
}

/** What `init` found in a Terragrunt repo. */
export interface TerragruntFound {
  /** The marker that turned Terragrunt mode on, or terragucci.yml's block. */
  reason: string;
  version: { value: string; reason: string };
  parallelism: { value: number; reason: string };
  /** How the units were found: Terragrunt's discovery, or a walk for terragrunt.hcl files. */
  source: string;
  /** Directories with a terragrunt.stack.hcl. */
  stacks: string[];
}

export interface FileChange {
  path: string;
  status: "created" | "updated" | "unchanged";
  content: string;
}

export interface InitResult {
  roots: string[];
  /** Why each root was found. */
  rootReasons: RootReason[];
  layers: string[][];
  /** Set when the repo is a Terragrunt repo: `roots` are its units and `layers` its waves. */
  terragrunt?: TerragruntFound;
  binary: { value: Binary; reason: string };
  image?: string;
  version: { value: string; reason: string };
  forge: { value: ForgeName; reason: string };
  files: FileChange[];
  /** Settings the pipeline does not act on yet, with why. */
  notes: string[];
  configNote: string;
}

function plan(path: string, content: string): FileChange {
  if (!existsSync(path)) return { path, status: "created", content };
  return { path, status: readFileSync(path, "utf-8") === content ? "unchanged" : "updated", content };
}

export async function init(repo: string, options: InitOptions = {}): Promise<InitResult> {
  const configPath = options.settings ? undefined : findConfig(repo);
  const settings: ResolvedSettings = options.settings ?? resolveRepo(configPath ? await loadConfig(configPath) : {});

  const notes: string[] = [];
  const detectedTg = detectTerragrunt(repo);
  if (settings.terragrunt && !detectedTg) {
    throw new ConfigError("terragucci.yml has a terragrunt block, but the repo has no root.hcl, terragrunt.hcl or terragrunt.stack.hcl");
  }
  const tgMode = detectedTg !== undefined;

  // In Terragrunt mode the binary is what Terragrunt calls, and the units carry no .tf files to read it from.
  const detectedBinary = detectBinary(repo, []);
  const binary = settings.binary
    ? { value: settings.binary, reason: "terragucci.yml" }
    : options.binary
      ? { value: options.binary, reason: "--binary" }
      : detectedBinary;

  let rootReasons: RootReason[];
  let layers: string[][];
  let terragrunt: TerragruntFound | undefined;
  if (detectedTg) {
    // A unit is a root, so the plain rule (a backend or a provider block) is off: modules are never roots.
    const tgSettings = settings.terragrunt ?? {};
    if (settings.roots) notes.push("roots is ignored for a Terragrunt repo; use terragrunt.exclude");
    const found = await discoverUnits(repo, { exclude: tgSettings.exclude, binary: binary.value, ...(options.terragrunt ? { terragrunt: options.terragrunt } : {}) });
    notes.push(...found.notes);
    if (found.units.length === 0) {
      throw new ConfigError(`found no Terragrunt units (${detectedTg.reason} turned Terragrunt mode on): no directory outside catalog/ holds a terragrunt.hcl`);
    }
    if (detectedTg.stacks.length > 0) {
      notes.push(`explicit stacks are not run yet, so ${detectedTg.stacks.join(", ")} is left out`);
    }
    rootReasons = found.units.map((u) => ({ root: u.path, reason: found.source === "terragrunt find" ? "terragrunt find" : "terragrunt.hcl" }));
    try {
      layers = unitWaves(found.units, settings.waves?.canary);
    } catch (e) {
      throw new ConfigError((e as Error).message);
    }
    const pinnedTg = pinnedTerragrunt(repo);
    terragrunt = {
      reason: detectedTg.reason,
      version: tgSettings.version
        ? { value: tgSettings.version, reason: "terragucci.yml" }
        : pinnedTg
          ? { value: pinnedTg, reason: "terragrunt_version_constraint" }
          : { value: TOOL_VERSIONS.terragrunt, reason: "the image" },
      parallelism: parallelism(repo, tgSettings),
      source: found.source,
      stacks: detectedTg.stacks,
    };
  } else {
    rootReasons = findRootsWithReasons(repo, settings.roots);
    if (rootReasons.length === 0) {
      throw new ConfigError(
        settings.roots
          ? `no directory matches roots ${JSON.stringify(settings.roots)}`
          : "found no roots: no directory has Terraform files with a backend or a provider block",
      );
    }
    layers = applyLayers(repo, rootReasons.map((r) => r.root));
  }
  const roots = rootReasons.map((r) => r.root);
  // detectBinary looked at no roots above; a plain repo's .tofu files still say tofu.
  if (!tgMode && !settings.binary && !options.binary) Object.assign(binary, detectBinary(repo, roots));

  const pinned = tgMode ? undefined : detectVersion(repo, roots);
  const version = settings.version
    ? { value: settings.version, reason: "terragucci.yml" }
    : pinned
      ? { value: pinned, reason: "required_version" }
      : { value: (TOOL_VERSIONS as Record<string, string>)[binary.value] ?? "", reason: "the image" };

  const detectedForge = detectForge(repo);
  const forgeChoice = settings.forge
    ? { value: settings.forge, reason: options.settings ? "the project" : "terragucci.yml" }
    : options.forge
      ? { value: options.forge, reason: "--forge" }
      : detectedForge;
  if (!forgeChoice) {
    throw new ConfigError("cannot tell which forge this repo is on; pass --forge github, gitlab or forgejo");
  }

  let ref: ImageRef | undefined;
  let tgInput: PipelineInput["terragrunt"];
  if (terragrunt) {
    if (binary.value !== "tofu" && binary.value !== "terraform") {
      throw new RenderError(`Terragrunt runs tofu or terraform in terragucci's pipeline; ${binary.value} is not supported with Terragrunt yet`);
    }
    ref = terragruntImage();
    tgInput = {
      version: terragrunt.version.value,
      parallelism: terragrunt.parallelism.value,
      exclude: settings.terragrunt?.exclude ?? [],
      ...(settings.terragrunt?.credentials ? { credentials: settings.terragrunt.credentials } : {}),
      installs: terragruntInstalls(binary.value, version.value, terragrunt.version.value, TOOL_VERSIONS),
    };
  } else {
    ref = imageFor(binary.value);
  }
  if (!ref) throw new RenderError(`terragucci has no CI image for ${binary.value} yet; set binary to tofu or terraform`);
  const carried = (TOOL_VERSIONS as Record<string, string>)[binary.value];
  const pipeline = renderPipeline({
    forge: forgeChoice.value,
    binary: binary.value,
    version: version.value,
    image: imageReference(ref),
    install: !tgInput && version.value !== carried ? { binary: binary.value, version: version.value } : undefined,
    ...(tgInput ? { terragrunt: tgInput } : {}),
    layers,
    env: settings.env,
    oidc: settings.oidc,
    tokenEnv: settings.token_env,
    ...(settings.decide?.token_env ? { decideTokenEnv: settings.decide.token_env } : {}),
    ...(settings.telemetry?.headers_secret ? { headersSecret: settings.telemetry.headers_secret } : {}),
    ...(settings.modules?.publish ? { publish: true } : {}),
    ...(settings.reports ? { reports: settings.reports } : {}),
    ...(settings.drift ? { drift: settings.drift } : {}),
    ...(!tgInput && settings.waves?.canary?.length ? { canary: settings.waves.canary } : {}),
    ...(!tgInput ? { gate: settings.gate } : {}),
    ...(settings.respond ? { respond: settings.respond } : {}),
  });
  const pipelinePath = join(repo, pipeline.path);
  if (existsSync(pipelinePath) && !options.force && !readFileSync(pipelinePath, "utf-8").startsWith(MARKER)) {
    throw new ConfigError(`${pipeline.path} exists and terragucci did not write it; move it aside or pass --force`);
  }
  const files: FileChange[] = [plan(pipelinePath, pipeline.content)];

  // Dashboards and alert rules, next to the pipeline, when terragucci.yml asks for them.
  const dashboards = dashboardSettings(settings.dashboards);
  if (dashboards) {
    for (const f of renderDashboards(dashboards, { ...(reportsBase(settings.reports) ? { reports: reportsBase(settings.reports) } : {}) })) {
      const path = join(repo, f.path);
      if (existsSync(path) && !options.force && !writtenByTerragucci(f.path, readFileSync(path, "utf-8"))) {
        throw new ConfigError(`${f.path} exists and terragucci did not write it; move it aside, set dashboards.dir, or pass --force`);
      }
      files.push(plan(path, f.content));
    }
  }

  // Every tf-apply wave gate needs a sealed approval (chant approve --sign).
  if (!tgMode) files.push(declaration(repo, applyWaves(layers, settings.waves?.canary).length, options.name));

  // A command-line choice is saved when detection would not reach it on its own,
  // so the next run, and the next person, gets the same pipeline.
  let configNote = configPath ? `using ${relative(repo, configPath)}` : "no terragucci.yml needed (defaults fit)";
  if (!options.settings) {
    const save: ProjectSettings = {};
    if (options.forge && !settings.forge && options.forge !== detectedForge?.value) save.forge = options.forge;
    if (options.binary && !settings.binary && options.binary !== detectedBinary.value) save.binary = options.binary;
    if (Object.keys(save).length) {
      if (configPath) {
        throw new ConfigError(`add ${Object.entries(save).map(([k, v]) => `${k}: ${v}`).join(", ")} to ${relative(repo, configPath)}`);
      }
      const path = join(repo, "terragucci.yml");
      files.push(plan(path, `${emitYAML(save, 0).trim()}\n`));
      configNote = `terragucci.yml records ${Object.keys(save).join(" and ")}, which detection cannot find`;
    }
  }

  if (settings.drift && forgeChoice.value === "gitlab") {
    notes.push(`drift is set: add a pipeline schedule with the cron ${settings.drift} under CI/CD > Schedules, and give ${settings.token_env ?? "GITLAB_TOKEN"} the api scope so the drift issue can be kept`);
  }
  if (settings.waves?.canary?.length && terragrunt) {
    notes.push("waves.canary is set; the canary units apply first, then the rest; Terragrunt waves apply one after another with no approval between them");
  }
  if (settings.runtime === "fountain") notes.push("runtime fountain is not built yet; the pipeline runs on the forge");
  if (settings.reports) notes.push("reports is set; the plan report is not built yet");

  if (!options.dryRun) {
    for (const f of files) {
      if (f.status === "unchanged") continue;
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content);
    }
  }
  return { roots, rootReasons, layers, ...(terragrunt ? { terragrunt } : {}), binary, image: imageReference(ref), version, forge: forgeChoice, files, notes, configNote };
}

/** The chant release that reads `identity`. */
const IDENTITY_READER = "0.102.0";

/**
 * chant.workspace.json with each wave gate under `identity.gates`, so chant
 * and the apply job count only an approval sealed by a key the signers file
 * at base lists. An existing declaration keeps everything it has; init only
 * adds the gates it lacks.
 */
function declaration(repo: string, waves: number, name?: string): FileChange {
  const path = join(repo, "chant.workspace.json");
  let decl: Record<string, unknown>;
  const before = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
  if (before !== undefined) {
    try {
      decl = JSON.parse(before);
    } catch {
      throw new ConfigError("chant.workspace.json is not valid JSON, so init cannot add the tf-apply gates to it");
    }
  } else {
    decl = { name: workspaceName(repo, name), schema: 1, minReader: IDENTITY_READER, members: [] };
  }
  let changed = before === undefined;
  const [major = 0, minor = 0] = String(decl.minReader).split(".").map(Number);
  if (typeof decl.minReader !== "string" || (major === 0 && minor < 102)) {
    decl.minReader = IDENTITY_READER;
    changed = true;
  }
  const identity = (decl.identity ??= {}) as { gates?: Record<string, unknown> };
  const gates = (identity.gates ??= {});
  for (let k = 1; k <= waves; k++) {
    if (gates[waveGate(k)] !== undefined) continue;
    gates[waveGate(k)] = {};
    changed = true;
  }
  // A declaration that already lists every gate is left as it is written.
  return plan(path, changed ? `${JSON.stringify(decl, null, 2)}\n` : before!);
}

/** A declaration name: lowercase letters, digits and hyphens, at most 40. */
function workspaceName(repo: string, name?: string): string {
  let raw = name;
  if (!raw) {
    try {
      raw = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/\.git$/, "").split(/[/:]/).pop();
    } catch {
      /* no git, or no origin */
    }
  }
  const clean = (raw || basename(repo)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
  return clean || "infra";
}

/** What `init` prints. */
export function describeInit(repo: string, r: InitResult, dryRun = false): string {
  const verb = (s: FileChange["status"]): string =>
    s === "unchanged" ? "unchanged" : dryRun ? (s === "created" ? "would write" : "would update") : s === "created" ? "wrote" : "updated";
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
  const tg = r.terragrunt;
  const lines = [
    tg
      ? `found Terragrunt (${tg.reason}): ${plural(r.roots.length, "unit")} in ${plural(r.layers.length, "wave")} from ${tg.source}, ` +
        `terragrunt ${tg.version.value} (${tg.version.reason}) calling ${r.binary.value} ${r.version.value} (${r.binary.reason}), ` +
        `parallelism ${tg.parallelism.value} (${tg.parallelism.reason}), forge ${r.forge.value} (${r.forge.reason})`
      : `found ${plural(r.roots.length, "root")} in ${plural(r.layers.length, "layer")}, ` +
        `${r.binary.value} ${r.version.value} (${r.binary.reason}), forge ${r.forge.value} (${r.forge.reason})`,
    ...r.files.map((f) => `${verb(f.status)} ${relative(repo, f.path)}`),
    r.configNote,
    ...r.notes.map((n) => `note: ${n}`),
  ];
  return lines.join("\n");
}

/** The `--json` form of an init result: paths relative to the repo, file content in full. */
export function initJson(repo: string, r: InitResult, dryRun: boolean): Record<string, unknown> {
  return {
    dryRun,
    roots: r.rootReasons.map(({ root, reason }) => ({ path: root, reason })),
    layers: r.layers,
    ...(r.terragrunt ? { terragrunt: r.terragrunt } : {}),
    binary: r.binary,
    version: r.version,
    forge: r.forge,
    image: r.image,
    files: r.files.map((f) => ({ path: relative(repo, f.path), status: f.status, content: f.content })),
    notes: r.notes,
    configNote: r.configNote,
  };
}
