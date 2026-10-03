/**
 * `terragucci init`: set one repo up. It reads terragucci.yml when there is
 * one, detects what the file leaves out, writes the pipeline, and writes
 * terragucci.yml only when a choice it was given on the command line differs
 * from what it would detect. Run twice, the second run changes nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { emitYAML } from "@intentius/chant/yaml";
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
import { applyLayers, detectBinary, detectForge, detectVersion, findRoots } from "./detect";
import { DEFAULT_VERSIONS, MARKER, renderPipeline } from "./render";

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
}

export interface FileChange {
  path: string;
  status: "created" | "updated" | "unchanged";
  content: string;
}

export interface InitResult {
  roots: string[];
  layers: string[][];
  binary: { value: Binary; reason: string };
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

  const roots = findRoots(repo, settings.roots);
  if (roots.length === 0) {
    throw new ConfigError(
      settings.roots
        ? `no directory matches roots ${JSON.stringify(settings.roots)}`
        : "found no roots: no directory has Terraform files with a backend or a provider block",
    );
  }
  const layers = applyLayers(repo, roots);

  const detectedBinary = detectBinary(repo, roots);
  const binary = settings.binary
    ? { value: settings.binary, reason: "terragucci.yml" }
    : options.binary
      ? { value: options.binary, reason: "--binary" }
      : detectedBinary;

  const pinned = detectVersion(repo, roots);
  const version = settings.version
    ? { value: settings.version, reason: "terragucci.yml" }
    : pinned
      ? { value: pinned, reason: "required_version" }
      : { value: DEFAULT_VERSIONS[binary.value] ?? "", reason: "the default" };

  const detectedForge = detectForge(repo);
  const forgeChoice = settings.forge
    ? { value: settings.forge, reason: options.settings ? "the project" : "terragucci.yml" }
    : options.forge
      ? { value: options.forge, reason: "--forge" }
      : detectedForge;
  if (!forgeChoice) {
    throw new ConfigError("cannot tell which forge this repo is on; pass --forge github, gitlab or forgejo");
  }

  const pipeline = renderPipeline({ forge: forgeChoice.value, binary: binary.value, version: version.value, layers, env: settings.env });
  const pipelinePath = join(repo, pipeline.path);
  if (existsSync(pipelinePath) && !options.force && !readFileSync(pipelinePath, "utf-8").startsWith(MARKER)) {
    throw new ConfigError(`${pipeline.path} exists and terragucci did not write it; move it aside or pass --force`);
  }
  const files: FileChange[] = [plan(pipelinePath, pipeline.content)];

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

  const notes: string[] = [];
  if (settings.drift) notes.push("drift is scheduled, but tf-drift is not built yet, so the pipeline has no drift job");
  if (settings.waves?.canary?.length) notes.push("waves.canary is set; gated waves are not built yet, so every root applies in dependency order");
  if (settings.runtime === "fountain") notes.push("runtime fountain is not built yet; the pipeline runs on the forge");
  if (settings.reports) notes.push("reports is set; the plan report is not built yet");

  if (!options.dryRun) {
    for (const f of files) {
      if (f.status === "unchanged") continue;
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content);
    }
  }
  return { roots, layers, binary, version, forge: forgeChoice, files, notes, configNote };
}

/** What `init` prints. */
export function describeInit(repo: string, r: InitResult, dryRun = false): string {
  const verb = (s: FileChange["status"]): string =>
    s === "unchanged" ? "unchanged" : dryRun ? (s === "created" ? "would write" : "would update") : s === "created" ? "wrote" : "updated";
  const lines = [
    `found ${r.roots.length} root${r.roots.length === 1 ? "" : "s"} in ${r.layers.length} layer${r.layers.length === 1 ? "" : "s"}, ` +
      `${r.binary.value} ${r.version.value} (${r.binary.reason}), forge ${r.forge.value} (${r.forge.reason})`,
    ...r.files.map((f) => `${verb(f.status)} ${relative(repo, f.path)}`),
    r.configNote,
    ...r.notes.map((n) => `note: ${n}`),
  ];
  return lines.join("\n");
}
