/**
 * `terragucci init`: set one repo up. It reads terragucci.yml when there is
 * one, detects what the file leaves out, writes the pipeline, and writes
 * terragucci.yml only when a choice it was given on the command line differs
 * from what it would detect. Run twice, the second run changes nothing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { emitYAML } from "@intentius/chant/yaml";
import { applyWaves, waveGate } from "./apply";
import { declaredGates } from "./approval";
import { SIGNERS_PATH } from "./seal";
import {
  ConfigError,
  COST_KEY_SECRET,
  gitlabPrApplyProblems,
  findConfig,
  loadConfig,
  BUILT_IN,
  PROJECT_FILE_KEYS,
  resolveRepo,
  responseTo,
  type Approval,
  type Binary,
  type ForgeName,
  type ProjectSettings,
  type ResolvedSettings,
} from "./config";
import { applyLayers, detectBinary, detectForge, detectVersion, findRootsWithReasons, type RootReason } from "./detect";
import { STEPS_NOT_TERRAGRUNT } from "./steps";
import { TERRAGRUNT_GENERATE } from "./generate-config";
import { imageFor, imageReference, terragruntImage, TOOL_VERSIONS, type ImageRef } from "./images";
import { dashboardFiles } from "./dashboards/files";
import { dashboardSettings, writtenByTerragucci } from "./dashboards/settings";
import { reportsBase } from "./report/store";
import { agentCommentInput } from "./agent-comment";
import { reviewInput } from "./review-agent";
import { GL_ROOT_FILE, gitlabCi } from "./gitlab-ci";
import { MARKER, RenderError, renderPipeline, ROLLOUT_PATHS, type PipelineInput } from "./render";
import { migrationFiles } from "./migrate";
import { terragruntInstalls } from "./render-terragrunt";
import { pinnedTool, rootPin, VERSION_FILES, versionFileRelease, versionGlobs } from "./pins";
import { detectTerragrunt, discoverUnits, parallelism, pinnedTerragrunt, unitWaves } from "./terragrunt";

export interface InitOptions {
  /** Choices from the command line; each overrides detection, and is saved to terragucci.yml. */
  forge?: ForgeName;
  binary?: Binary;
  /** `--approval`: what counts as a waiting wave's approval. */
  approval?: Approval;
  /** `--signer <principal>`: under approval: sealed, write the first signers line from `git config user.signingkey`. */
  signer?: string;
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
  /** `removed`: a file an earlier init wrote, which the config no longer asks for. */
  status: "created" | "updated" | "unchanged" | "removed";
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
  /** Roots that run a version of their own, and where each pins it. */
  pins: RootVersion[];
  forge: { value: ForgeName; reason: string };
  files: FileChange[];
  /** Settings the pipeline does not act on yet, with why. */
  notes: string[];
  configNote: string;
}

/** A root that pins its own version, and where. */
export interface RootVersion {
  root: string;
  version: string;
  source: string;
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
    if (settings.cost) throw new ConfigError("cost estimates read each root's plan from tf-plan, and a Terragrunt repo plans its units with run --all; remove cost");
    if (settings.synth) throw new ConfigError("synth is for roots a command writes, such as CDK Terrain's stacks; a Terragrunt repo's units are its own, so remove synth");
    if (settings.steps?.length) throw new ConfigError(STEPS_NOT_TERRAGRUNT);
    if (settings.generate) throw new ConfigError(TERRAGRUNT_GENERATE);
    const found = await discoverUnits(repo, { exclude: tgSettings.exclude, binary: binary.value, ...(options.terragrunt ? { terragrunt: options.terragrunt } : {}) });
    notes.push(...found.notes);
    if (found.units.length === 0) {
      throw new ConfigError(`found no Terragrunt units (${detectedTg.reason} turned Terragrunt mode on): no directory outside catalog/ holds a terragrunt.hcl`);
    }
    if (detectedTg.stacks.length > 0) {
      notes.push(`explicit stacks (terragrunt.stack.hcl) are not supported, so ${detectedTg.stacks.join(", ")} is left out`);
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
        (settings.roots
          ? `no directory matches roots ${JSON.stringify(settings.roots)}`
          : "found no roots: no directory has Terraform files with a backend or a provider block") +
          // The pipeline names the roots init finds, so a synthesized root must be on disk when init runs.
          (settings.synth ? `; run the synth command (${settings.synth}) first, then init` : ""),
      );
    }
    layers = applyLayers(repo, rootReasons.map((r) => r.root));
  }
  const roots = rootReasons.map((r) => r.root);
  // detectBinary looked at no roots above; a plain repo's .tofu files still say tofu.
  if (!tgMode && !settings.binary && !options.binary) Object.assign(binary, detectBinary(repo, roots));

  if (tgMode && versionGlobs(settings.version)) {
    throw new ConfigError("version as a map pins plain roots by glob; a Terragrunt repo runs one release of its binary for every unit, so give version one release");
  }
  // A choudoufu root's required_version pins the OpenTofu language it forks, not a choudoufu release.
  const pinned = tgMode || binary.value === "choudoufu" ? undefined : detectVersion(repo, roots);
  // The repo's own .opentofu-version or .terraform-version, for the binary it names.
  const fileTool = tgMode ? undefined : pinnedTool(binary.value);
  const versionFile = fileTool ? join(repo, VERSION_FILES[fileTool]) : undefined;
  const filed = versionFile && existsSync(versionFile) ? versionFileRelease(readFileSync(versionFile, "utf-8")) : undefined;
  const version = typeof settings.version === "string"
    ? { value: settings.version, reason: "terragucci.yml" }
    : filed && fileTool
      ? { value: filed, reason: VERSION_FILES[fileTool] }
      : pinned
        ? { value: pinned, reason: "required_version" }
        : { value: (TOOL_VERSIONS as Record<string, string>)[binary.value] ?? "", reason: "the image" };
  // Roots that pin a version of their own, other than the one every job runs: each runs its own, installed in the job.
  const pins: RootVersion[] = [];
  if (!tgMode) {
    for (const root of roots) {
      const pin = rootPin(repo, root, binary.value, settings.version);
      if (pin && pin.version !== version.value) pins.push({ root, ...pin });
    }
  }

  const detectedForge = detectForge(repo);
  const forgeChoice = settings.forge
    ? { value: settings.forge, reason: options.settings ? "the project" : "terragucci.yml" }
    : options.forge
      ? { value: options.forge, reason: "--forge" }
      : detectedForge;
  if (!forgeChoice) {
    throw new ConfigError("cannot tell which forge this repo is on; pass --forge github, gitlab or forgejo");
  }

  if (forgeChoice.value === "gitlab") {
    const missing = gitlabPrApplyProblems(settings as unknown as Record<string, unknown>, "config");
    if (missing.length) throw new ConfigError(missing.join("; "));
  }

  // The approval mode: the config's key, then --approval; a declaration that already seals its gates keeps them sealed.
  const declPath = join(repo, "chant.workspace.json");
  const declared = declaredGates(existsSync(declPath) ? readFileSync(declPath, "utf-8") : undefined) > 0;
  const detectedApproval: Approval = declared ? "sealed" : "ledger";
  const approval: { value: Approval; explicit: boolean } = settings.approval
    ? { value: settings.approval, explicit: true }
    : options.approval
      ? { value: options.approval, explicit: true }
      : { value: detectedApproval, explicit: false };

  let ref: ImageRef;
  let tgInput: PipelineInput["terragrunt"];
  if (terragrunt) {
    if (binary.value !== "tofu" && binary.value !== "terraform") {
      throw new RenderError(`Terragrunt runs tofu or terraform in terragucci's pipeline; ${binary.value} is not supported with Terragrunt`);
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
  const carried = (TOOL_VERSIONS as Record<string, string>)[binary.value];
  // The rollout job: when rollouts names a schedule and respond.rollout is not off.
  const rollouts = settings.rollouts && responseTo(settings, "rollout") !== "off" ? settings.rollouts : undefined;
  const pipeline = renderPipeline({
    forge: forgeChoice.value,
    binary: binary.value,
    version: version.value,
    // image: the repo's own, built FROM terragucci's, so the jobs still carry terragucci and the binary.
    image: settings.image ?? imageReference(ref),
    ...(settings.image ? { imageFromConfig: true } : {}),
    install: !tgInput && version.value !== carried ? { binary: binary.value, version: version.value } : undefined,
    ...(pins.length > 0 ? { rootPins: true } : {}),
    ...(settings.generate && !tgInput ? { generate: true } : {}),
    ...(tgInput ? { terragrunt: tgInput } : {}),
    layers,
    env: settings.env,
    oidc: settings.oidc,
    tokenEnv: settings.token_env,
    ...(settings.decide?.token_env ? { decideTokenEnv: settings.decide.token_env } : {}),
    ...(settings.telemetry?.headers_secret ? { headersSecret: settings.telemetry.headers_secret } : {}),
    ...(settings.modules?.publish ? { publish: true, ...(settings.modules.attest ? { attest: true } : {}) } : {}),
    ...(settings.reports ? { reports: settings.reports } : {}),
    ...(settings.drift ? { drift: settings.drift } : {}),
    ...(rollouts ? { rollouts } : {}),
    ...(settings.synth ? { synth: settings.synth } : {}),
    ...(settings.notify ? { notify: settings.notify } : {}),
    ...(settings.cost ? { cost: { keySecret: (settings.cost !== true && settings.cost.key_secret) || COST_KEY_SECRET, install: settings.cost === true || !settings.cost.command, ...(settings.cost !== true && settings.cost.approve_above !== undefined ? { approveAbove: true } : {}) } } : {}),
    ...(settings.comments ? { comments: settings.comments } : {}),
    ...(settings.gitlab?.token ? { gitlabToken: settings.gitlab.token } : {}),
    ...(!tgInput && settings.waves?.canary?.length ? { canary: settings.waves.canary } : {}),
    ...(settings.waves?.jobs && settings.waves.jobs > 1 ? { waveJobs: settings.waves.jobs } : {}),
    gate: settings.gate,
    // A repo's own config carries its approval key, read at base; a control repo's project has none, so the pipeline carries it.
    ...(options.settings?.approval ? { approval: options.settings.approval } : {}),
    ...(approval.value === "pr-review" ? { prReview: true } : {}),
    ...(settings.respond ? { respond: settings.respond } : {}),
    ...(settings.policy ? { policy: true } : {}),
    ...(agentCommentInput(settings) ? { agentComment: agentCommentInput(settings) } : {}),
    ...(settings.atlantis_comments ? { atlantisComments: true } : {}),
    ...(reviewInput(settings) ? { review: reviewInput(settings) } : {}),
    ...(settings.apply?.resume ? { resume: settings.apply.resume } : {}),
    ...(migrationFiles(repo).length > 0 ? { migrations: true } : {}),
    ...(settings.apply?.when === "pull-request" ? { applyWhen: "pull-request" as const, ...(settings.apply.merge ? { applyMerge: settings.apply.merge } : {}), ...(settings.apply.merge_token_env ? { applyMergeTokenEnv: settings.apply.merge_token_env } : {}), ...(settings.apply.requires ? { applyRequires: settings.apply.requires } : {}) } : {}),
    ...(settings.locks === "plan" ? { locksPlan: true } : {}),
  });
  const pipelinePath = join(repo, pipeline.path);
  if (existsSync(pipelinePath) && !options.force && !readFileSync(pipelinePath, "utf-8").startsWith(MARKER)) {
    throw new ConfigError(`${pipeline.path} exists and terragucci did not write it; move it aside or pass --force`);
  }
  const rolloutRel = forgeChoice.value === "gitlab" ? undefined : ROLLOUT_PATHS[forgeChoice.value];
  const files: FileChange[] = [plan(pipelinePath, pipeline.content)];
  for (const f of pipeline.extra ?? []) {
    const path = join(repo, f.path);
    // The rollout workflow, like the pipeline, overwrites only a file terragucci wrote.
    if (f.path === rolloutRel && existsSync(path) && !options.force && !readFileSync(path, "utf-8").startsWith(MARKER)) throw new ConfigError(`${f.path} exists and terragucci did not write it; move it aside or pass --force`);
    files.push(plan(path, f.content));
  }
  // A rollout workflow an earlier init wrote goes when the config stops asking for it.
  if (rolloutRel && !(pipeline.extra ?? []).some((f) => f.path === rolloutRel) && !options.settings) {
    const rolloutPath = join(repo, rolloutRel);
    if (existsSync(rolloutPath) && readFileSync(rolloutPath, "utf-8").startsWith(MARKER)) files.push({ path: rolloutPath, status: "removed", content: "" });
  }
  // On GitLab the repo's own .gitlab-ci.yml includes the pipeline; its jobs stay.
  if (forgeChoice.value === "gitlab") {
    const root = join(repo, GL_ROOT_FILE);
    files.push(plan(root, gitlabCi(existsSync(root) ? readFileSync(root, "utf-8") : undefined, pipeline.content)));
  }

  // Dashboards and alert rules, next to the pipeline, when terragucci.yml asks for them.
  const dashboards = dashboardSettings(settings.dashboards);
  if (dashboards) {
    for (const f of dashboardFiles(dashboards, { ...(reportsBase(settings.reports) ? { reports: reportsBase(settings.reports) } : {}) })) {
      const path = join(repo, f.path);
      if (existsSync(path) && !options.force && !writtenByTerragucci(f.path, readFileSync(path, "utf-8"))) {
        throw new ConfigError(`${f.path} exists and terragucci did not write it; move it aside, set dashboards.dir, or pass --force`);
      }
      files.push(plan(path, f.content));
    }
  }

  // Under approval: sealed every tf-apply wave gate is listed, so chant approve asks for --sign. A Terragrunt repo's layers are its waves.
  const decl = declaration(repo, tgMode ? layers.length : applyWaves(layers, settings.waves?.canary).length, approval.value === "sealed" ? "seal" : approval.explicit ? "unseal" : "leave", options.name);
  if (decl) files.push(decl);
  // Under sealed, the first signers line can come from the person's own git signing key.
  if (approval.value === "sealed") {
    const signersPath = join(repo, SIGNERS_PATH);
    if (existsSync(signersPath)) {
      if (options.signer) notes.push(`${SIGNERS_PATH} exists and init does not edit it; add ${options.signer} to it by hand`);
    } else if (options.signer) {
      files.push(plan(signersPath, signerLine(repo, options.signer)));
      notes.push(`${SIGNERS_PATH} lists ${options.signer}; merge it in a reviewed pull request before the first wave waits`);
    } else {
      notes.push(`approval: sealed counts only approvals sealed by a key ${SIGNERS_PATH} lists, and there is none yet; terragucci init --signer <your principal> writes it from git config user.signingkey`);
    }
  }

  // A control repo's project reads policy and reports from its own terragucci.yml, so the control repo's keys are written there.
  if (options.settings) {
    const projectFile = await projectConfigFile(repo, options.settings);
    if (projectFile) files.push(projectFile);
  }

  // A command-line choice is saved when detection would not reach it on its own,
  // so the next run, and the next person, gets the same pipeline.
  if (!options.settings) {
    // A key the config sets decides; say so when a flag disagrees, rather than ignore it.
    if (options.forge && settings.forge && options.forge !== settings.forge) notes.push(`--forge ${options.forge} is ignored: ${relative(repo, configPath ?? "terragucci.yml")} sets forge: ${settings.forge}`);
    if (options.binary && settings.binary && options.binary !== settings.binary) notes.push(`--binary ${options.binary} is ignored: ${relative(repo, configPath ?? "terragucci.yml")} sets binary: ${settings.binary}`);
    if (options.approval && settings.approval && options.approval !== settings.approval) notes.push(`--approval ${options.approval} is ignored: ${relative(repo, configPath ?? "terragucci.yml")} sets approval: ${settings.approval}`);
  }
  let configNote = configPath ? `using ${relative(repo, configPath)}` : "no terragucci.yml needed (defaults fit)";
  if (!options.settings) {
    const save: ProjectSettings = {};
    if (options.forge && !settings.forge && options.forge !== detectedForge?.value) save.forge = options.forge;
    if (options.binary && !settings.binary && options.binary !== detectedBinary.value) save.binary = options.binary;
    if (options.approval && !settings.approval && options.approval !== detectedApproval) save.approval = options.approval;
    if (Object.keys(save).length) {
      if (configPath) {
        throw new ConfigError(`${relative(repo, configPath)} exists and init does not edit it; add ${Object.entries(save).map(([k, v]) => `${k}: ${v}`).join(", ")} to it`);
      }
      const path = join(repo, "terragucci.yml");
      files.push(plan(path, `${emitYAML(save, 0).trim()}\n`));
      configNote = `terragucci.yml records ${Object.keys(save).join(" and ")}, which detection cannot find`;
    }
  }

  if (settings.drift && forgeChoice.value === "gitlab") {
    notes.push(`drift is set: add a pipeline schedule with the cron ${settings.drift} under CI/CD > Schedules, and give ${settings.token_env ?? "GITLAB_TOKEN"} the api scope so the drift issue can be kept`);
  }
  if (rollouts && forgeChoice.value === "gitlab") {
    notes.push(`rollouts is set: add a pipeline schedule with the cron ${rollouts} and the variable TERRAGUCCI_SCHEDULE set to rollouts under CI/CD > Schedules, and give ${settings.token_env ?? "GITLAB_TOKEN"} the api and write_repository scopes so the rollout job can push a wave's branch and open its merge request`);
  }
  if (settings.rollouts && !rollouts) notes.push("rollouts is set and respond.rollout is off, so no rollout job is written");
  if (settings.comments && forgeChoice.value === "gitlab") {
    notes.push(`comments is set: add a pipeline schedule with the cron ${settings.comments} and the variable TERRAGUCCI_SCHEDULE set to comments under CI/CD > Schedules, and give ${settings.token_env ?? "GITLAB_TOKEN"} the api scope and the Developer role so the comments job can answer notes and start pipelines`);
  }
  if (settings.gitlab?.token === "protected" && forgeChoice.value === "gitlab") {
    // A pipeline is built from its branch's own files, so any variable that is not protected reaches a merge request's code.
    const token = settings.token_env ?? "GITLAB_TOKEN";
    notes.push(`gitlab.token is protected: under Settings > CI/CD > Variables, edit ${token} and tick Protect variable and Mask variable, and keep the default branch protected; merge request and branch pipelines then never see the token, the plan job stops if it does, the comments job posts the plan notes, and no fmt job commits formatting`);
  }
  if (settings.waves?.canary?.length && terragrunt) {
    notes.push("waves.canary is set; the canary units' layers apply first, then the layers of the rest, each wave behind its gate");
  }

  if (!options.dryRun) {
    for (const f of files) {
      if (f.status === "unchanged") continue;
      if (f.status === "removed") {
        unlinkSync(f.path);
        continue;
      }
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content);
    }
  }
  return { roots, rootReasons, layers, ...(terragrunt ? { terragrunt } : {}), binary, image: settings.image ?? imageReference(ref), version, pins, forge: forgeChoice, files, notes, configNote };
}

/** The first line of the terragucci.yml a control repo writes into a project, so a later run knows it may rewrite it. */
export const PROJECT_CONFIG_HEADER = "# terragucci reconcile writes this file from the control repo's terragucci.yml; edit that file, not this one.";

/** Two values as data, keys in any order. */
function sameData(a: unknown, b: unknown): boolean {
  const sorted = (v: unknown): unknown =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sorted(a ?? null)) === JSON.stringify(sorted(b ?? null));
}

/** A key's value as a project's jobs see it: absent when it is the built-in one, which they fall back to. */
function carriedValue(settings: ResolvedSettings, k: (typeof PROJECT_FILE_KEYS)[number]): unknown {
  const v = settings[k];
  return v === undefined || sameData(v, (BUILT_IN as ProjectSettings)[k]) ? undefined : v;
}

/**
 * The project's terragucci.yml, for a control repo's project. The project's
 * jobs read the keys PROJECT_FILE_KEYS names from the project's own config
 * (`policy` and `approval` at the base), and no pipeline flag carries them, so
 * the control repo's values are written there, and rewritten while the file is
 * the one terragucci wrote. A config of the project's own must already carry
 * the same values; otherwise the project fails with what to change.
 */
async function projectConfigFile(repo: string, settings: ResolvedSettings): Promise<FileChange | undefined> {
  const found = findConfig(repo);
  const path = join(repo, "terragucci.yml");
  const ours = found === path && readFileSync(path, "utf-8").startsWith(PROJECT_CONFIG_HEADER);
  const keys = PROJECT_FILE_KEYS.filter((k) => carriedValue(settings, k) !== undefined);
  if (found && !ours) {
    const own = resolveRepo(await loadConfig(found));
    const differ = PROJECT_FILE_KEYS.filter((k) => !sameData(carriedValue(own, k), carriedValue(settings, k)));
    if (differ.length === 0) return undefined;
    const fix = differ
      .map((k) => (carriedValue(settings, k) !== undefined ? `set its ${k} key to the control repo's (${JSON.stringify(settings[k])})` : `remove its ${k} key`))
      .join(" and ");
    throw new ConfigError(`${relative(repo, found)} exists and terragucci did not write it, and the jobs read ${differ.join(" and ")} from it; ${fix}, or remove the file so the control repo writes it`);
  }
  if (keys.length === 0 && !ours) return undefined;
  const body = keys.length ? emitYAML(Object.fromEntries(keys.map((k) => [k, settings[k]])), 0).trim() : "{}";
  return plan(path, `${PROJECT_CONFIG_HEADER}\n${body}\n`);
}

/** The chant release that reads `identity`. */
const IDENTITY_READER = "0.102.0";

/**
 * chant.workspace.json under `approval: sealed` (`seal`): each wave gate under
 * `identity.gates`, so chant and the apply job count only an approval sealed
 * by a key the signers file at base lists. An existing declaration keeps
 * everything it has; init only adds the gates it lacks. Under `approval:
 * ledger` set in the config or by --approval (`unseal`), init drops the wave
 * gates an earlier init listed, since chant approve refuses an unsigned
 * approval of a listed gate; with no key and no gates (`leave`) it writes no
 * declaration at all. Undefined: nothing to write.
 */
function declaration(repo: string, waves: number, want: "seal" | "unseal" | "leave", name?: string): FileChange | undefined {
  const path = join(repo, "chant.workspace.json");
  let decl: Record<string, unknown>;
  const before = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
  if (want !== "seal") {
    if (want === "leave" || before === undefined) return undefined;
    try {
      decl = JSON.parse(before);
    } catch {
      throw new ConfigError("chant.workspace.json is not valid JSON, so init cannot drop the tf-apply gates from it");
    }
    const identity = decl.identity as { gates?: Record<string, unknown> } | undefined;
    const waveGates = Object.keys(identity?.gates ?? {}).filter((g) => /^wave-\d+$/.test(g));
    if (waveGates.length === 0) return plan(path, before);
    for (const g of waveGates) delete identity!.gates![g];
    if (Object.keys(identity!.gates!).length === 0) delete identity!.gates;
    if (Object.keys(identity!).length === 0) delete decl.identity;
    return plan(path, `${JSON.stringify(decl, null, 2)}\n`);
  }
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

/**
 * The signers line for `principal` from git's `user.signingkey`: an ssh public
 * key, a `key::` literal, or the path of a key whose `.pub` sits beside it.
 */
export function signerLine(repo: string, principal: string): string {
  if (!/^[^\s,"*?!]+$/.test(principal)) throw new ConfigError(`--signer ${JSON.stringify(principal)} is not a principal; use a name with no spaces, commas, quotes or patterns, such as github:alice`);
  let key = "";
  try {
    key = execFileSync("git", ["-C", repo, "config", "user.signingkey"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    /* unset */
  }
  if (!key) throw new ConfigError("--signer reads git config user.signingkey, which is not set; set it to your ssh key (git config --global user.signingkey ~/.ssh/id_ed25519.pub)");
  let pub = key.replace(/^key::/, "");
  if (!/^(ssh-|sk-|ecdsa-)/.test(pub)) {
    const path = pub.replace(/^~(?=\/)/, process.env.HOME ?? "~");
    const file = path.endsWith(".pub") ? path : `${path}.pub`;
    if (!existsSync(file)) throw new ConfigError(`--signer found user.signingkey ${key}, and no public key at ${file}`);
    pub = readFileSync(file, "utf-8").trim();
  }
  const [type, blob] = pub.split(/\s+/);
  if (!type || !blob || !/^(ssh-(ed25519|rsa)|sk-ssh-ed25519@openssh\.com)$/.test(type)) throw new ConfigError(`--signer needs an ed25519 or RSA ssh key; user.signingkey gives ${type ?? "nothing"}`);
  return `${principal} ${type} ${blob}\n`;
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
    s === "unchanged" ? "unchanged" : dryRun ? (s === "created" ? "would write" : s === "removed" ? "would remove" : "would update") : s === "created" ? "wrote" : s === "removed" ? "removed" : "updated";
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
  const tg = r.terragrunt;
  const lines = [
    tg
      ? `found Terragrunt (${tg.reason}): ${plural(r.roots.length, "unit")} in ${plural(r.layers.length, "wave")} from ${tg.source}, ` +
        `terragrunt ${tg.version.value} (${tg.version.reason}) calling ${r.binary.value} ${r.version.value} (${r.binary.reason}), ` +
        `parallelism ${tg.parallelism.value} (${tg.parallelism.reason}), forge ${r.forge.value} (${r.forge.reason})`
      : `found ${plural(r.roots.length, "root")} in ${plural(r.layers.length, "layer")}, ` +
        `${r.binary.value} ${r.version.value} (${r.binary.reason}), forge ${r.forge.value} (${r.forge.reason})`,
    ...(r.pins.length > 0 ? [`${plural(r.pins.length, "root")} ${r.pins.length === 1 ? "pins its" : "pin their"} own version: ${r.pins.map((p) => `${p.root} ${r.binary.value} ${p.version} (${p.source})`).join(", ")}`] : []),
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
    ...(r.pins.length > 0 ? { pins: r.pins } : {}),
    forge: r.forge,
    image: r.image,
    files: r.files.map((f) => ({ path: relative(repo, f.path), status: f.status, content: f.content })),
    notes: r.notes,
    configNote: r.configNote,
  };
}
