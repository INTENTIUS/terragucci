/**
 * `terragucci init`: set one repo up. It reads terragucci.yml when there is
 * one, detects what the file leaves out, writes the pipeline, and writes
 * terragucci.yml only when a choice it was given on the command line differs
 * from what it would detect. `--gate` is the one choice it also writes into
 * an existing config. Run twice, the second run changes nothing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { emitYAML, parseYAMLDocument } from "@intentius/chant/yaml";
import { applyWaves, waveGate } from "./apply";
import { CHANT_CONFIG, chantConfigText, chantConfigWrittenByTerragucci } from "./chant-config";
import { waveCallArgv, wavesSpecText, wavesStepSpec } from "./chant-waves";
import { MIGRATIONS_DIR } from "./migrate";
import { declaredGates } from "./approval";
import { SIGNERS_PATH } from "./seal";
import {
  approvalModeOf,
  ConfigError,
  COST_KEY_SECRET,
  EPHEMERAL_SWEEP,
  FORGE_ENVIRONMENT_NOT_FORGEJO,
  normalizeGate,
  gitlabPrApplyProblems,
  gitlabPublishToken,
  findConfig,
  ownJobsProblems,
  loadConfig,
  BUILT_IN,
  imageMirror,
  imageName,
  PROJECT_FILE_KEYS,
  resolveRepo,
  responseTo,
  type Approval,
  type Binary,
  type ForgeName,
  type Gate,
  type ProjectSettings,
  type ResolvedSettings,
} from "./config";
import { detectBinary, detectForge, detectVersion, estateOf, liveRoots, type RootReason } from "./detect";
import { recordStoreOf } from "./cdf-records";
import { bucketLines, checkStoreBucket, readLiveSetup, setupLine } from "./live-setup";
import type { PolicyExec } from "./report/policy";
import { BINARY, detectShape, refuseProblems } from "./shape";
import { imageFor, imageReference, terragruntImage, TOOL_VERSIONS, type ImageRef } from "./images";
import { dashboardFiles } from "./dashboards/files";
import { dashboardSettings, writtenByTerragucci } from "./dashboards/settings";
import { reportsBase } from "./report/store";
import { agentCommentInput, agentDriftInput } from "./agent-comment";
import { REVIEW_PATHS, reviewInput } from "./review-agent";
import { GL_ROOT_FILE, gitlabCi } from "./gitlab-ci";
import { resolveControl } from "./control-repo";
import { EPHEMERAL_PATHS, MARKER, RenderError, renderPipeline, RESUME_PATHS, resumeCron, ROLLOUT_PATHS, type PipelineInput } from "./render";
import { COMPONENTS_PATH, componentsDecl, componentsJson, componentsWrittenByTerragucci } from "./components-decl";
import { terragruntInstalls } from "./render-terragrunt";
import { pinnedTool, rootPin, VERSION_FILES, versionFileRelease, versionGlobs } from "./pins";
import { ATMOS_VERSION } from "./atmos";
import { TERRAMATE_VERSION } from "./terramate";
import { parallelism, pinnedTerragrunt } from "./terragrunt";
import { unitTerragruntPin } from "./unit-pins";
import { withEnvironmentRoles } from "./environments";
import { chantCheckHooks, chantCiControl, chantCiProduct } from "./chant-next";
import { declarationFile, namesCheckHooks, PRE_COMMIT_CONFIG, withoutPreCommitHook, withPreCommitHook } from "./pre-commit";
import { applyGroups } from "./cloud-identity";

export interface InitOptions {
  /** Choices from the command line; each overrides detection, and is saved to terragucci.yml. */
  forge?: ForgeName;
  binary?: Binary;
  /** `--approval`: what counts as a waiting wave's approval. */
  approval?: Approval;
  /** `--gate`: when a wave waits for an approval. Written into terragucci.yml; one that differs from the config's needs `force`. */
  gate?: Gate;
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
  /** The `atmos` executable `atmos describe stacks` runs. Default: `TERRAGUCCI_ATMOS`, then `atmos` on the path. */
  atmos?: string;
  /** The `terramate` executable that lists the stacks. Default: `TERRAGUCCI_TERRAMATE`, then `terramate` on the path. */
  terramate?: string;
  /** The repo's name, for a new chant.workspace.json. Default: the origin remote's last path segment, then the directory's name. */
  name?: string;
  /** How `choudoufu live-check -json` runs for each live root's record store. Default: the binary on the path. */
  liveExec?: PolicyExec;
  /** `--no-bucket-check`: print each live root's record store, and read none of its bucket's settings. */
  bucketCheck?: boolean;
  /** The environment the bucket check takes its region, endpoint and keys from. Default: the process's. */
  env?: NodeJS.ProcessEnv;
}

/** A live root's record store and estate, as choudoufu resolved them, and what chant's bucket check found. */
export interface LiveRecords {
  root: string;
  /** The line init prints: where the records go and the estate. */
  line: string;
  /** Where the answer came from: choudoufu's live-check, or the live block's text when the installed choudoufu prints none. */
  from: "choudoufu" | "live block";
  /** The bucket check's lines: a correct bucket, each setting that fails with its fix, or why it was not checked. */
  bucket: string[];
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

/** What `init` found in an Atmos repo. */
export interface AtmosFound {
  /** The marker that turned Atmos mode on. */
  reason: string;
  /** The Atmos release the jobs install. */
  version: string;
}

/** What `init` found in a Terramate repo. */
export interface TerramateFound {
  /** The marker that turned Terramate mode on. */
  reason: string;
  /** The Terramate release the jobs install. */
  version: string;
  /** Stacks that hold no Terraform, so are no roots. */
  skipped: string[];
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
  /** Set when the repo is an Atmos repo: `roots` are its instances (`<stack>/<component>`) and `layers` their waves. */
  atmos?: AtmosFound;
  /** Set when the repo is a Terramate repo: `roots` are its stacks and `layers` the waves of their order. */
  terramate?: TerramateFound;
  binary: { value: Binary; reason: string };
  image?: string;
  version: { value: string; reason: string };
  /** Roots that run a version of their own, and where each pins it. */
  pins: RootVersion[];
  forge: { value: ForgeName; reason: string };
  /** Under choudoufu: each live root's record store and estate, and its bucket check. */
  records: LiveRecords[];
  files: FileChange[];
  /** Settings the pipeline does not act on yet, with why. */
  notes: string[];
  configNote: string;
}

/** A root that pins its own version, and where. */
export interface RootVersion {
  root: string;
  /** The tool pinned, when it is not the binary: `terragrunt` for a unit's terragrunt_version_constraint. */
  tool?: string;
  version: string;
  source: string;
}

function plan(path: string, content: string): FileChange {
  if (!existsSync(path)) return { path, status: "created", content };
  return { path, status: readFileSync(path, "utf-8") === content ? "unchanged" : "updated", content };
}

/** `own_jobs`: the map itself, or the map the repo's YAML file at that path holds. */
export function ownJobs(repo: string, v: NonNullable<ProjectSettings["own_jobs"]>): Record<string, Record<string, unknown>> {
  if (typeof v !== "string") return v;
  const path = join(repo, v);
  if (!existsSync(path)) throw new ConfigError(`own_jobs names ${v}, which the repo does not have`);
  let doc: unknown;
  try {
    doc = parseYAMLDocument(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new ConfigError(`own_jobs: ${v} is not YAML (${(e as Error).message})`);
  }
  const problems = typeof doc === "string" ? [`own_jobs (${v}) must be a map of job name to job`] : ownJobsProblems(doc, `own_jobs (${v})`);
  if (problems.length > 0) throw new ConfigError(problems.join("; "));
  return doc as Record<string, Record<string, unknown>>;
}

export async function init(repo: string, options: InitOptions = {}): Promise<InitResult> {
  const configPath = options.settings ? undefined : findConfig(repo);
  const loaded = configPath ? await loadConfig(configPath) : undefined;
  const resolved: ResolvedSettings = options.settings ?? resolveRepo(loaded ?? {});
  // --gate: the config's gate key, when it sets one, changes only with --force.
  const configGate = normalizeGate(loaded?.gate);
  if (options.gate && configGate && options.gate !== configGate && !options.force) {
    throw new ConfigError(`--gate ${options.gate} differs from ${relative(repo, configPath!)}, which sets gate: ${configGate}; pass --force to write gate: ${options.gate} into it, or drop --gate`);
  }
  const settings: ResolvedSettings = options.gate ? { ...resolved, gate: options.gate } : resolved;

  const notes: string[] = [];
  // The repo's shape decides everything below, and its refusals come first, as config check gives them.
  const shape = detectShape(repo, settings);
  refuseProblems(shape);
  const tgMode = shape.kind === "terragrunt";

  // In Terragrunt mode the binary is what Terragrunt calls, and the units carry no .tf files to read it from.
  const detectedBinary = detectBinary(repo, []);
  const binary = settings.binary
    ? { value: settings.binary, reason: "terragucci.yml" }
    : options.binary
      ? { value: options.binary, reason: "--binary" }
      : detectedBinary;

  const found = await shape.discover({
    binary: binary.value,
    ...(options.terragrunt ? { terragrunt: options.terragrunt } : {}),
    ...(options.atmos ? { atmos: options.atmos } : {}),
    ...(options.terramate ? { terramate: options.terramate } : {}),
  });
  notes.push(...found.notes);
  const rootReasons: RootReason[] = found.roots;
  const layers: string[][] = found.layers;
  let terragrunt: TerragruntFound | undefined;
  let atmos: AtmosFound | undefined;
  let terramate: TerramateFound | undefined;
  if (shape.kind === "atmos") {
    atmos = { reason: shape.reason, version: settings.atmos?.version ?? ATMOS_VERSION };
  } else if (shape.kind === "terramate") {
    terramate = { reason: shape.reason, version: TERRAMATE_VERSION, skipped: found.skipped ?? [] };
  } else if (shape.terragrunt) {
    const tgSettings = settings.terragrunt ?? {};
    if (shape.terragrunt.stacks.length > 0) {
      notes.push(`explicit stacks: ${shape.terragrunt.stacks.join(", ")}; terragrunt stack generate wrote their units, and every job generates them again before discovery`);
    }
    const pinnedTg = pinnedTerragrunt(repo);
    terragrunt = {
      reason: shape.reason,
      version: tgSettings.version
        ? { value: tgSettings.version, reason: "terragucci.yml" }
        : pinnedTg
          ? { value: pinnedTg, reason: "terragrunt_version_constraint" }
          : { value: TOOL_VERSIONS.terragrunt, reason: "the image" },
      parallelism: parallelism(repo, tgSettings),
      source: found.source ?? "terragrunt.hcl files",
      stacks: shape.terragrunt.stacks,
    };
  }
  const roots = rootReasons.map((r) => r.root);
  // detectBinary looked at no roots above; a plain repo's .tofu files still say tofu, and an Atmos instance's are its component's.
  if (!tgMode && !settings.binary && !options.binary) Object.assign(binary, shape.binary(roots));

  // Under choudoufu each live root keeps its backend block, and choudoufu derives the record store from it (choudoufu#2293):
  // init writes no record_store, prints what choudoufu resolved, and checks the bucket with chant's shared check.
  const records = binary.value === "choudoufu" ? await liveRecords(repo, liveRoots(repo, roots), options) : [];

  // A choudoufu root's required_version pins the OpenTofu language it forks, not a choudoufu release.
  const pinned = tgMode || !BINARY[binary.value].releaseInRequiredVersion ? undefined : detectVersion(repo, roots);
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
  // A Terragrunt unit pins its binary the same ways, and its Terragrunt release with an exact terragrunt_version_constraint;
  // the stage installs each in the job and runs the unit's wave as one run --all per pair of releases.
  const pins: RootVersion[] = [];
  for (const root of roots) {
    const pin = rootPin(repo, root, binary.value, settings.version);
    if (pin && pin.version !== version.value) pins.push({ root, ...pin });
    const tgPin = tgMode ? unitTerragruntPin(repo, root) : undefined;
    if (tgPin && tgPin !== terragrunt?.version.value) pins.push({ root, tool: "terragrunt", version: tgPin, source: "terragrunt_version_constraint" });
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
  const configured = approvalModeOf(settings.approval);
  const approval: { value: Approval; explicit: boolean } = configured
    ? { value: configured, explicit: true }
    : options.approval
      ? { value: options.approval, explicit: true }
      : { value: detectedApproval, explicit: false };

  let ref: ImageRef;
  let tgInput: PipelineInput["terragrunt"];
  if (terragrunt) {
    // Terragrunt calls the binary through TG_TF_PATH. tofu and terraform run in the Terragrunt image; choudoufu runs in its own
    // image, which carries no Terragrunt, so the jobs install the Terragrunt release beside it.
    ref = binary.value === "choudoufu" ? imageFor("choudoufu") : terragruntImage();
    tgInput = {
      version: terragrunt.version.value,
      parallelism: terragrunt.parallelism.value,
      exclude: settings.terragrunt?.exclude ?? [],
      ...(shape.terragrunt && shape.terragrunt.stacks.length > 0 ? { stacks: true } : {}),
      ...(settings.generate ? { generate: true } : {}),
      // sources: the check job checks each unit's sources before its validate fetches them.
      ...(settings.sources ? { sources: true } : {}),
      // image.mirror: the check job checks the image's provider mirror covers every lock file.
      ...(imageMirror(settings.image) ? { mirror: true } : {}),
      ...(settings.terragrunt?.credentials ? { credentials: settings.terragrunt.credentials } : {}),
      installs: terragruntInstalls(binary.value, version.value, terragrunt.version.value, binary.value === "choudoufu" ? { choudoufu: TOOL_VERSIONS.choudoufu } : { tofu: TOOL_VERSIONS.tofu, terragrunt: TOOL_VERSIONS.terragrunt }),
    };
  } else {
    ref = imageFor(binary.value);
  }
  // One apply job per identity (./cloud-identity.ts), for plain roots: environments, or roles by glob that tell roots apart.
  const groups = tgInput ? undefined : applyGroups(settings, layers.flat());
  if (groups && forgeChoice.value === "forgejo") {
    const named = Object.entries(settings.environments ?? {}).filter(([, e]) => e.forge_environment !== undefined).map(([n]) => n);
    if (named.length) throw new ConfigError(named.map((n) => `environments.${n}.forge_environment: ${FORGE_ENVIRONMENT_NOT_FORGEJO}`).join("; "));
  }
  const carried = (TOOL_VERSIONS as Record<string, string>)[binary.value];
  // The rollout job: when rollouts names a schedule and respond.rollout is not off.
  const rollouts = settings.rollouts && responseTo(settings, "rollout") !== "off" ? settings.rollouts : undefined;
  // chant's control repo (chant#4568), loaded before the control settings are resolved, so the dispatch step and the read checkout are chant's when it is there.
  if (settings.control) await chantCiControl();
  const control = settings.control ? resolveControl(settings.control, options.name ?? basename(resolve(repo))) : undefined;
  // check.pre_commit: tf-check runs the repo's pre-commit hooks as a chant check hook (./pre-commit.ts). The check
  // job also runs check-hooks when the declaration already names check hooks of its own.
  const preCommitOn = settings.check?.pre_commit === true;
  const chantHooks = await chantCheckHooks();
  const declFile = declarationFile(repo) ?? declPath;
  const declText = existsSync(declFile) ? readFileSync(declFile, "utf-8") : undefined;
  const checkHooksInput = preCommitOn || (chantHooks && namesCheckHooks(declText)) ? { checkHooks: { preCommit: preCommitOn } } : {};
  // chant's product pipeline (chant#4550), when the installed chant has it: the pipeline takes terragucci's words through it.
  const ciProduct = await chantCiProduct();
  // terragucci#1303: a plain repo's apply on chant's terraform-apply step. Each root is a terraform.roots entry of chant.config.ts,
  // and the step's spec is written once beside the pipeline, where each wave job reads its rules at base.
  const plainRoots = !tgMode && !atmos && !terramate;
  const stepSpec = plainRoots
    ? wavesSpecText(wavesStepSpec({
        waves: applyWaves(layers, settings.waves?.canary),
        gate: normalizeGate(settings.gate) ?? "on-destructive",
        approval: approval.value === "sealed" ? "sealed" : "ledger",
        call: waveCallArgv,
        migrations: existsSync(join(repo, MIGRATIONS_DIR)),
        ...(settings.apply?.point ? { point: settings.apply.point } : {}),
      }))
    : undefined;
  const pipeline = renderPipeline({
    ...checkHooksInput,
    ...(stepSpec ? { wavesSpec: stepSpec } : {}),
    ...(ciProduct ? { ciProduct } : {}),
    forge: forgeChoice.value,
    binary: binary.value,
    version: version.value,
    // image: the repo's own, built FROM terragucci's, so the jobs still carry terragucci and the binary.
    image: imageName(settings.image) ?? imageReference(ref),
    ...(settings.image ? { imageFromConfig: true } : {}),
    install: !tgInput && version.value !== carried ? { binary: binary.value, version: version.value } : undefined,
    ...(pins.length > 0 ? { rootPins: true } : {}),
    ...(settings.parallelism !== undefined && !tgInput ? { parallelism: settings.parallelism } : {}),
    ...(settings.generate && !tgInput ? { generate: true } : {}),
    // sources: tf-check checks each root's sources before its init.
    ...(settings.sources && !tgInput ? { sources: true } : {}),
    // image.mirror: tf-check checks the image's provider mirror covers every lock file (./image-recipe.ts).
    ...(imageMirror(settings.image) && !tgInput ? { mirror: true } : {}),
    ...(tgInput ? { terragrunt: tgInput } : {}),
    layers,
    env: settings.env,
    // Each environment's identities ride the roles by root glob (./environments.ts); with no environments, oidc as it is.
    oidc: withEnvironmentRoles(settings.oidc, settings.environments),
    ...(groups ? { applyGroups: groups } : {}),
    tokenEnv: settings.token_env,
    ...(settings.decide?.token_env ? { decideTokenEnv: settings.decide.token_env } : {}),
    ...(settings.telemetry?.headers_secret ? { headersSecret: settings.telemetry.headers_secret } : {}),
    ...(settings.modules?.publish || settings.modules?.registry
      ? { publish: true, ...(settings.modules.attest ? { attest: true } : {}), ...(settings.modules.registry?.bucket ? { publishBucket: settings.modules.registry.bucket } : {}), ...(gitlabPublishToken(settings.modules) ? { publishGitlabToken: gitlabPublishToken(settings.modules)! } : {}) }
      : {}),
    ...(settings.reports ? { reports: settings.reports } : {}),
    ...(settings.drift ? { drift: settings.drift } : {}),
    ...(rollouts ? { rollouts } : {}),
    // control: after the last apply, a job tells the control repo (./control-repo.ts). The member is this repo's name in the control repo's workspace.
    ...(control ? { control } : {}),
    // Every job runs the shape's prepare before it reads the roots; an Atmos repo's jobs install Atmos for it.
    ...(shape.prepare ? { synth: shape.prepare } : {}),
    ...(atmos ? { atmos: { version: atmos.version } } : {}),
    ...(terramate ? { terramate: { version: terramate.version } } : {}),
    ...(settings.notify ? { notify: settings.notify } : {}),
    ...(settings.cost ? { cost: { keySecret: (settings.cost !== true && settings.cost.key_secret) || COST_KEY_SECRET, install: settings.cost === true || !settings.cost.command, ...(settings.cost !== true && settings.cost.approve_above !== undefined ? { approveAbove: true } : {}) } } : {}),
    ...(settings.comments ? { comments: settings.comments } : {}),
    ...(settings.gitlab?.token ? { gitlabToken: settings.gitlab.token } : {}),
    ...(!tgInput && !atmos && !terramate && settings.waves?.canary?.length ? { canary: settings.waves.canary } : {}),
    ...(settings.waves?.jobs && settings.waves.jobs > 1 ? { waveJobs: settings.waves.jobs } : {}),
    gate: settings.gate,
    // A repo's own config carries its approval key, read at base; a control repo's project has none, so the pipeline carries it.
    ...(approvalModeOf(options.settings?.approval) ? { approval: approvalModeOf(options.settings?.approval) } : {}),
    ...(approval.value === "pr-review" ? { prReview: true } : {}),
    ...(settings.agent?.login ? { agentLogin: settings.agent.login } : {}),
    ...(settings.respond ? { respond: settings.respond } : {}),
    ...(settings.policy ? { policy: true } : {}),
    ...(agentCommentInput(settings) ? { agentComment: agentCommentInput(settings) } : {}),
    ...(agentDriftInput(settings) ? { agentDrift: agentDriftInput(settings) } : {}),
    ...(settings.atlantis_comments ? { atlantisComments: true } : {}),
    ...(reviewInput(settings) ? { review: reviewInput(settings) } : {}),
    ...(settings.apply?.resume ? { resume: settings.apply.resume } : {}),
    ...(settings.apply?.when === "pull-request" ? { applyWhen: "pull-request" as const, ...(settings.apply.merge ? { applyMerge: settings.apply.merge } : {}), ...(settings.apply.merge_token_env ? { applyMergeTokenEnv: settings.apply.merge_token_env } : {}), ...(settings.apply.requires ? { applyRequires: settings.apply.requires } : {}) } : {}),
    ...(settings.locks === "plan" ? { locksPlan: true } : {}),
    ...(settings.apply?.branches && Object.keys(settings.apply.branches).length > 0 ? { applyBranches: settings.apply.branches } : {}),
    ...(settings.own_jobs !== undefined ? { ownJobs: ownJobs(repo, settings.own_jobs) } : {}),
    ...(settings.ephemeral ? { ephemeral: { sweep: settings.ephemeral.sweep ?? EPHEMERAL_SWEEP } } : {}),
    ...(settings.runner !== undefined ? { runner: settings.runner } : {}),
    ...(settings.pass !== undefined ? { pass: settings.pass } : {}),
  });
  const pipelinePath = join(repo, pipeline.path);
  if (existsSync(pipelinePath) && !options.force && !readFileSync(pipelinePath, "utf-8").startsWith(MARKER)) {
    throw new ConfigError(`${pipeline.path} exists and terragucci did not write it; move it aside or pass --force`);
  }
  const rolloutRel = forgeChoice.value === "gitlab" ? undefined : ROLLOUT_PATHS[forgeChoice.value];
  const reviewRel = forgeChoice.value === "gitlab" ? undefined : REVIEW_PATHS[forgeChoice.value];
  const ephemeralRel = forgeChoice.value === "gitlab" ? undefined : EPHEMERAL_PATHS[forgeChoice.value];
  const resumeRel = forgeChoice.value === "gitlab" ? undefined : RESUME_PATHS[forgeChoice.value];
  const files: FileChange[] = [plan(pipelinePath, pipeline.content)];
  for (const f of pipeline.extra ?? []) {
    const path = join(repo, f.path);
    // The rollout, review, ephemeral and resume workflows, like the pipeline, overwrite only a file terragucci wrote.
    if ((f.path === rolloutRel || f.path === reviewRel || f.path === ephemeralRel || f.path === resumeRel) && existsSync(path) && !options.force && !readFileSync(path, "utf-8").startsWith(MARKER)) throw new ConfigError(`${f.path} exists and terragucci did not write it; move it aside or pass --force`);
    files.push(plan(path, f.content));
  }
  // chant.config.ts: every root as a terraform.roots entry, so chant's step names it (terragucci#1303). A file terragucci did not write stays.
  if (plainRoots) {
    const configFile = join(repo, CHANT_CONFIG);
    const mine = !existsSync(configFile) || chantConfigWrittenByTerragucci(readFileSync(configFile, "utf-8"));
    if (mine) files.push(plan(configFile, chantConfigText(roots, binary.value === "tofu" || binary.value === "terraform" ? binary.value : undefined)));
    else notes.push(`${CHANT_CONFIG} is the repo's own, so terragucci left it; a wave applies through chant's terraform-apply step once it names every root under terraform.roots`);
  }
  // terragucci.components.json at the repo's root: the roots as chant components by wave, under the jobs that apply them, for behold.
  // Its waves are the pipeline's: a plain repo's cut by waves.canary, a Terragrunt, Atmos or Terramate repo's layers as the shape cut them.
  const componentsPath = join(repo, COMPONENTS_PATH);
  if (existsSync(componentsPath) && !options.force && !componentsWrittenByTerragucci(readFileSync(componentsPath, "utf-8"))) {
    throw new ConfigError(`${COMPONENTS_PATH} exists and terragucci did not write it; move it aside or pass --force`);
  }
  // A rollout, review, ephemeral or resume workflow an earlier init wrote goes when the config stops asking for it.
  for (const rel of [rolloutRel, reviewRel, ephemeralRel, resumeRel]) {
    if (!rel || (pipeline.extra ?? []).some((f) => f.path === rel) || options.settings) continue;
    const path = join(repo, rel);
    if (existsSync(path) && readFileSync(path, "utf-8").startsWith(MARKER)) files.push({ path, status: "removed", content: "" });
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
  const decl = declaration(repo, tgMode || atmos || terramate ? layers.length : applyWaves(layers, settings.waves?.canary).length, approval.value === "sealed" ? "seal" : approval.explicit ? "unseal" : "leave", options.name);
  if (decl) files.push(decl);
  // The preset's hook goes into ci.hooks.check with chant's writer when the installed chant reads that moment; turned
  // off, the hook an earlier init wrote goes. On a chant without the moment, check-hooks runs the preset itself.
  const declSoFar = decl?.content ?? declText;
  const hooked = preCommitOn && chantHooks
    ? withPreCommitHook(chantHooks, basename(declFile), declSoFar ?? `${JSON.stringify({ name: workspaceName(repo, options.name), schema: 1, minReader: chantHooks.CI_CHECK_HOOK_FLOOR, members: [] }, null, 2)}\n`, binary.value)
    : !preCommitOn && declSoFar !== undefined && !declFile.endsWith(".jsonc") ? withoutPreCommitHook(declSoFar) : undefined;
  if (hooked !== undefined) {
    const change = plan(declFile, hooked);
    const at = files.findIndex((f) => f.path === declFile);
    if (at >= 0) files[at] = change;
    else files.push(change);
  }
  if (preCommitOn && !chantHooks) notes.push(`check.pre_commit is on, and the installed chant has no ci.hooks.check moment, so init writes no check hook and tf-check runs ${PRE_COMMIT_CONFIG}'s hooks itself`);
  if (!preCommitOn && existsSync(join(repo, PRE_COMMIT_CONFIG))) {
    notes.push(`tip: ${PRE_COMMIT_CONFIG} is here; set check.pre_commit: true in terragucci.yml and tf-check runs its hooks over each change, with PCT_TFPATH set to ${binary.value} and terraform_fmt skipped (the job's image needs pre-commit and the tools the file names)`);
  }
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
    if (options.approval && configured && options.approval !== configured) notes.push(`--approval ${options.approval} is ignored: ${relative(repo, configPath ?? "terragucci.yml")} sets approval: ${configured}`);
  }
  let configNote = configPath ? `using ${relative(repo, configPath)}` : "no terragucci.yml needed (defaults fit)";
  if (!options.settings) {
    const save: ProjectSettings = {};
    if (options.forge && !settings.forge && options.forge !== detectedForge?.value) save.forge = options.forge;
    if (options.binary && !settings.binary && options.binary !== detectedBinary.value) save.binary = options.binary;
    if (options.approval && !configured && options.approval !== detectedApproval) save.approval = options.approval;
    if (Object.keys(save).length && configPath) {
      throw new ConfigError(`${relative(repo, configPath)} exists and init does not edit it; add ${Object.entries(save).map(([k, v]) => `${k}: ${v}`).join(", ")} to it`);
    }
    // --gate is written even when it names the default, so the config says what the pipeline does.
    const gate = options.gate && options.gate !== configGate ? options.gate : undefined;
    if (gate && configPath) {
      files.push(plan(configPath, withGate(repo, configPath, gate)));
      configNote = `${relative(repo, configPath)} records gate: ${gate}`;
    } else if (Object.keys(save).length || gate) {
      const path = join(repo, "terragucci.yml");
      const detected = Object.keys(save);
      files.push(plan(path, `${emitYAML({ ...save, ...(gate ? { gate } : {}) }, 0).trim()}\n`));
      configNote = detected.length
        ? `terragucci.yml records ${detected.join(" and ")}, which detection cannot find${gate ? `, and gate: ${gate}` : ""}`
        : `terragucci.yml records gate: ${gate}`;
    }
  }

  if (settings.drift && forgeChoice.value === "gitlab") {
    notes.push(`drift is set: add a pipeline schedule with the cron ${settings.drift} under CI/CD > Schedules, and give ${settings.token_env ?? "GITLAB_TOKEN"} the api scope so the drift issue can be kept`);
  }
  if (rollouts && forgeChoice.value === "gitlab") {
    notes.push(`rollouts is set: add a pipeline schedule with the cron ${rollouts} and the variable TERRAGUCCI_SCHEDULE set to rollouts under CI/CD > Schedules, and give ${settings.token_env ?? "GITLAB_TOKEN"} the api and write_repository scopes so the rollout job can push a wave's branch and open its merge request`);
  }
  if (control) {
    notes.push(`control is set: give this repo a ${control.tokenEnv} secret, a token that may dispatch to ${control.repo} and do nothing else; its apply on the default branch then runs ${control.member}'s dependents there with the Op ${control.op}`);
  }
  if (settings.rollouts && !rollouts) notes.push("rollouts is set and respond.rollout is off, so no rollout job is written");
  if (settings.comments && forgeChoice.value === "gitlab") {
    notes.push(`comments is set: add a pipeline schedule with the cron ${settings.comments} and the variable TERRAGUCCI_SCHEDULE set to comments under CI/CD > Schedules, and give ${settings.token_env ?? "GITLAB_TOKEN"} the api scope and the Developer role so the comments job can answer notes and start pipelines`);
  }
  if (settings.apply?.resume && forgeChoice.value === "gitlab") {
    notes.push(`apply.resume is set: add a pipeline schedule with the cron ${resumeCron(settings.apply.resume)} and the variable TERRAGUCCI_SCHEDULE set to resume under CI/CD > Schedules, so the resume job applies a wave once its approval is recorded`);
  }
  if (settings.ephemeral && forgeChoice.value === "gitlab") {
    notes.push(`ephemeral is set: add a pipeline schedule with the cron ${resumeCron(settings.ephemeral.sweep ?? EPHEMERAL_SWEEP)} and the variable TERRAGUCCI_SCHEDULE set to ephemeral under CI/CD > Schedules, so the sweep destroys each copy whose TTL passed or whose merge request closed`);
  }
  if (settings.gitlab?.token === "protected" && forgeChoice.value === "gitlab") {
    // A pipeline is built from its branch's own files, so any variable that is not protected reaches a merge request's code.
    const token = settings.token_env ?? "GITLAB_TOKEN";
    notes.push(`gitlab.token is protected: under Settings > CI/CD > Variables, edit ${token} and tick Protect variable and Mask variable, and keep the default branch protected; merge request and branch pipelines then never see the token, the plan job stops if it does, the comments job posts the plan notes, and no fmt job commits formatting`);
  }
  if (settings.waves?.canary?.length && terramate) {
    notes.push("waves.canary is set; the canary stacks' layers apply first, then the layers of the rest, each wave behind its gate");
  }
  if (settings.waves?.canary?.length && atmos) {
    notes.push("waves.canary is set; the canary instances' layers apply first, then the layers of the rest, each wave behind its gate");
  }
  if (settings.waves?.canary?.length && terragrunt) {
    notes.push("waves.canary is set; the canary units' layers apply first, then the layers of the rest, each wave behind its gate");
  }

  // Last in the list, after every file the pipeline needs.
  const components = componentsDecl({
    waves: tgMode || atmos || terramate ? layers : applyWaves(layers, settings.waves?.canary),
    order: found.order,
    ...(atmos ? { dirOf: (r: string) => shape.sourceOf(r) } : {}),
    pipeline: { path: pipeline.path, forge: forgeChoice.value, applyJobs: pipeline.applyJobs },
  });
  files.push(plan(componentsPath, componentsJson(components)));

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
  return { roots, rootReasons, layers, ...(terragrunt ? { terragrunt } : {}), ...(atmos ? { atmos } : {}), ...(terramate ? { terramate } : {}), binary, image: imageName(settings.image) ?? imageReference(ref), version, pins, forge: forgeChoice, records, files, notes, configNote };
}

/**
 * Each live root's record store and estate: what `choudoufu live-check -json`
 * resolves, else the live block's own text, and chant's bucket check on the
 * store (./live-setup.ts). A Terragrunt unit holds no .tf files until
 * Terragrunt writes its working directory, so it is not among the live roots
 * here; choudoufu prints its store at each of the unit's runs.
 */
async function liveRecords(repo: string, roots: string[], options: InitOptions): Promise<LiveRecords[]> {
  const env = options.env ?? process.env;
  const out: LiveRecords[] = [];
  for (const root of roots) {
    const dir = join(repo, root);
    const setup = await readLiveSetup(dir, { ...(options.liveExec ? { exec: options.liveExec } : {}) });
    if (!setup) {
      const estate = estateOf(dir).estate;
      const store = estate ? recordStoreOf(dir, estate) : undefined;
      const where = !store ? "no record store read" : store.kind === "s3" ? `records in s3 bucket "${store.bucket}" under ${store.prefix}` : store.kind === "local" ? `records in the local directory ${relative(dir, store.dir) || "."} under ${store.prefix}` : `records in a ${store.name} store`;
      out.push({ root, from: "live block", line: `${root}: ${where} (from its live block: choudoufu live-check printed no resolved store, from an older release or a root it could not read); ${estate ? `estate "${estate}"` : "no estate named"}`, bucket: [] });
      continue;
    }
    const bucket = options.bucketCheck === false || !setup.store ? [] : bucketLines(root, await checkStoreBucket(dir, setup.store, env));
    out.push({ root, from: "choudoufu", line: setupLine(root, setup), bucket });
  }
  return out;
}

/**
 * The config file's text with its top-level `gate` set to `gate`: the line
 * replaced when there is one, added at the end when not, the rest kept as it
 * is. A terragucci.ts is code, so init names the change instead.
 */
function withGate(repo: string, path: string, gate: Gate): string {
  const name = relative(repo, path);
  if (path.endsWith(".ts")) throw new ConfigError(`${name} is code and init does not edit it; set gate: "${gate}" in it`);
  const text = readFileSync(path, "utf-8");
  if (path.endsWith(".json")) return `${JSON.stringify({ ...(JSON.parse(text) as Record<string, unknown>), gate }, null, 2)}\n`;
  const line = /^gate[ \t]*:.*$/m;
  const out = line.test(text) ? text.replace(line, `gate: ${gate}`) : `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}gate: ${gate}\n`;
  // A gate in a form the line edit cannot reach, such as a flow-style map, is left to the person.
  let doc: unknown;
  try {
    doc = parseYAMLDocument(out);
  } catch {
    doc = undefined;
  }
  if (doc === null || typeof doc !== "object" || normalizeGate((doc as Record<string, unknown>).gate) !== gate) {
    throw new ConfigError(`init cannot set the gate in ${name}; set gate: ${gate} in it`);
  }
  return out;
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
export function workspaceName(repo: string, name?: string): string {
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
    r.terramate
      ? `found Terramate (${r.terramate.reason}): ${plural(r.roots.length, "stack")} in ${plural(r.layers.length, "wave")} from terramate list and the stacks' order, ` +
        `terramate ${r.terramate.version}, ${r.binary.value} ${r.version.value} (${r.binary.reason}), forge ${r.forge.value} (${r.forge.reason})`
      : r.atmos
      ? `found Atmos (${r.atmos.reason}): ${plural(r.roots.length, "instance")} in ${plural(r.layers.length, "wave")} from atmos describe stacks, ` +
        `atmos ${r.atmos.version} calling ${r.binary.value} ${r.version.value} (${r.binary.reason}), forge ${r.forge.value} (${r.forge.reason})`
      : tg
      ? `found Terragrunt (${tg.reason}): ${plural(r.roots.length, "unit")} in ${plural(r.layers.length, "wave")} from ${tg.source}, ` +
        `terragrunt ${tg.version.value} (${tg.version.reason}) calling ${r.binary.value} ${r.version.value} (${r.binary.reason}), ` +
        `parallelism ${tg.parallelism.value} (${tg.parallelism.reason}), forge ${r.forge.value} (${r.forge.reason})`
      : `found ${plural(r.roots.length, "root")} in ${plural(r.layers.length, "layer")}, ` +
        `${r.binary.value} ${r.version.value} (${r.binary.reason}), forge ${r.forge.value} (${r.forge.reason})`,
    ...(r.pins.length > 0 ? [`${plural(r.pins.length, "root")} ${r.pins.length === 1 ? "pins its" : "pin their"} own version: ${r.pins.map((p) => `${p.root} ${p.tool ?? r.binary.value} ${p.version} (${p.source})`).join(", ")}`] : []),
    ...r.records.flatMap((x) => [`records: ${x.line}`, ...x.bucket.map((b) => `bucket: ${b}`)]),
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
    ...(r.atmos ? { atmos: r.atmos } : {}),
    ...(r.terramate ? { terramate: r.terramate } : {}),
    binary: r.binary,
    version: r.version,
    ...(r.pins.length > 0 ? { pins: r.pins } : {}),
    forge: r.forge,
    ...(r.records.length > 0 ? { records: r.records } : {}),
    image: r.image,
    files: r.files.map((f) => ({ path: relative(repo, f.path), status: f.status, content: f.content })),
    notes: r.notes,
    configNote: r.configNote,
  };
}
