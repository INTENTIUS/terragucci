/**
 * `terragucci state export <root> [--version <id>]`: one version of a root's
 * state, downloaded to the machine of the person who runs it, once someone
 * else approved it, and recorded on `chant/lifecycle` with who exported what.
 *
 * The export goes only to the person running it, never to a job artifact or
 * the reports bucket. A state holds every secret its resources hold. A job's
 * artifact is readable by everyone with read access to the repo (everyone at
 * all on a public one) for the artifact's retention, which would hand the
 * state to far more people than can read the bucket. Run locally, the state
 * reaches only the person whose own cloud identity the bucket already lets
 * read it; what terragucci adds is the approval and the record.
 *
 * The export is chant's (chant#4804): the terraform lexicon's
 * `terraformStateExport` reads the root's versions (s3 version ids, gcs
 * generations, azurerm versions or snapshots, GitLab serials) and core's
 * `exportStateVersion` asks with a gated request at gate `<root>` of op
 * `tf-state-export`, spends the approval of someone other than the
 * requester, writes the version mode 0600 to a new private directory (never
 * inside a git working tree, never over a file, never in a CI job), and
 * records the version id and a digest of the bytes in the request's
 * `finished` line. terragucci prepares the root (an init in a data dir of the
 * export's own, a Terragrunt unit through Terragrunt, a workspace a root
 * names), reads its approval rules, and words the command and the messages.
 * The `done.jsonl` lines older releases wrote stay readable by `terragucci
 * audit`; nothing writes them now.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terraformStateExport } from "@intentius/chant-lexicon-terraform/state-ops";
import { actorOf } from "@intentius/chant/actor";
import type { StoreFetch } from "@intentius/chant/object-store";
import { approvalRule } from "./approval";
import { ConfigError, findConfig, loadConfig, resolveRepo } from "./config";
import { detectShape } from "./shape";
import { refusal, runBinary, unitPlace, type BinaryExec, type MigrateOptions } from "./migrate";
import { opMessage, requestRules } from "./gated-request";

export const EXPORT_OP = "tf-state-export";
export const EXPORT_LEDGER = `_gates/${EXPORT_OP}.jsonl`;
/** Beside the ledger: the line older releases wrote for each export, which `terragucci audit` still reads. */
export const EXPORT_DONE = `_gates/${EXPORT_OP}/done.jsonl`;
/** How long a request waits for its approval. */
const REQUEST_HOURS = 48;

/** The command that approves an export request. */
export const exportApproveCommand = (root: string, digest: string, sealed = false): string => `terragucci approve export ${root} --plan ${digest}${sealed ? " --sign" : ""}`;

export interface ExportOptions {
  root: string;
  /** The version to export. Default: the one the bucket holds now. */
  version?: string;
  /** Where the file goes; outside the repo. Default: a new private directory in the system's temp dir. */
  out?: string;
  /** Who asks. Default: git's user.name, else user.email. */
  actor?: string;
  binary?: string;
  config?: string;
  env?: NodeJS.ProcessEnv;
  exec?: BinaryExec;
  /** How a Terragrunt unit is prepared (MigrateOptions.terragrunt). */
  terragrunt?: MigrateOptions["terragrunt"];
  fetch?: StoreFetch;
  now?: string;
  log?: (line: string) => void;
}

export interface ExportResult {
  /** 0 written, 3 waiting for an approval, 1 failed. */
  code: number;
  digest?: string;
  command?: string;
  file?: string;
}

/**
 * Ask for, or with an approval write, one version of a root's state. Throws
 * ConfigError for a root, backend or version it cannot export.
 */
export async function exportState(repo: string, options: ExportOptions): Promise<ExportResult> {
  const log = options.log ?? ((l: string) => console.log(l));
  const env = options.env ?? process.env;
  const exec = options.exec ?? runBinary;
  const now = options.now ?? new Date().toISOString();
  const root = options.root.replace(/\/+$/, "");
  if (!root) throw new ConfigError("state export takes the root whose state to export: terragucci state export <root> [--version <id>]");
  const configPath = options.config ?? findConfig(repo);
  const settings = configPath ? resolveRepo(await loadConfig(configPath)) : undefined;
  const shape = detectShape(repo, settings ?? resolveRepo({}));
  // A unit an explicit stack generates is generated first, as a wave generates it.
  await shape.prepareRoots({ roots: [root], ...(options.terragrunt?.path ? { terragrunt: options.terragrunt.path } : {}), ...(options.terragrunt?.exec ? { exec: options.terragrunt.exec } : {}) });
  const why = refusal(repo, root);
  if (why) throw new ConfigError(`state export: ${why}`);
  const unit = existsSync(join(repo, root, "terragrunt.hcl"));
  const by = options.actor || actorOf({ env, repo, forge: false, gitKeys: ["user.name", "user.email"], login: false, fallback: "" });
  if (!by) throw new ConfigError("state export names who asks: set git's user.name, or pass --actor <name>");
  const binary = options.binary ?? settings?.binary ?? shape.binary([root]).value;

  const rule = await approvalRule(repo, { at: "HEAD", ...(configPath ? { config: configPath } : {}) });
  const sealed = rule.mode === "sealed";
  // The root is initialised in a data dir of the export's own, so the checkout's .terraform is left alone. A
  // Terragrunt unit is what Terragrunt makes of its remote_state: Terragrunt inits it where it runs the binary, as a
  // migration prepares it. A root that names its workspace (an Atmos instance) inits in default; its state is its
  // own workspace's. chant then reads the backend that init recorded.
  const data = mkdtempSync(join(tmpdir(), "terragucci-export-data-"));
  let result: Awaited<ReturnType<typeof terraformStateExport>>;
  try {
    let dir: string;
    let rootEnv: NodeJS.ProcessEnv;
    if (unit) {
      const place = await unitPlace(repo, root, binary, env, data, options.terragrunt);
      dir = place.dir;
      rootEnv = place.env;
    } else {
      const benv = { ...env, TF_DATA_DIR: data };
      dir = join(repo, root);
      const init = await exec(binary, ["init", "-input=false", "-no-color"], dir, shape.rootInit(root, benv)?.init ?? benv);
      if (init.code !== 0) throw new ConfigError(`init in ${root} failed: ${init.out.trim().split("\n").slice(-4).join(" ").slice(0, 400)}`);
      rootEnv = shape.rootEnv(root, benv);
    }
    result = await terraformStateExport({
      root,
      binary,
      dir,
      env: rootEnv,
      exec,
      init: false,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      by,
      ...(options.version ? { version: options.version } : {}),
      ...(options.out ? { out: options.out } : {}),
      words: { op: EXPORT_OP, approveCommand: (subject: string, digest: string) => exportApproveCommand(subject, digest, sealed), fileName: (subject: string, version: string) => `${subject.replace(/[^\w.-]+/g, "_")}.${version.replace(/[^\w.-]+/g, "_")}.tfstate`, tmpPrefix: "terragucci-export-" },
      rules: requestRules(rule),
      cwd: repo,
      ...(rule.base ? { base: rule.base } : {}),
      expiry: `${REQUEST_HOURS}h`,
      now,
    });
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`state export: ${(e as Error).message}`);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
  switch (result.status) {
    case "written":
      log(`state export: wrote ${result.file}: ${root}'s state, ${result.location} version ${result.version}, approved by ${result.approvedBy}`);
      log(`state export: recorded on chant/lifecycle in _gates/${EXPORT_OP}/applied.jsonl; delete the file when you are done with it`);
      return { code: result.exit, digest: result.digest, file: result.file };
    case "failed":
      throw new ConfigError(`state export: ${opMessage(result.error)}`);
    case "spent":
      log(`state export: request ${result.digest} for ${root} version ${result.version} was exported already; an export asks again once the request expires`);
      return { code: result.exit, digest: result.digest };
    case "refused":
      log(`state export: an approval does not count: ${result.reason}`);
    // falls through: the request still waits for another approver
    case "waiting":
      log(`state export: ${by} asks for ${root}'s state, ${result.location} version ${result.version}; request ${result.digest}`);
      log("someone other than you approves it with:");
      log(`  ${result.command}`);
      log("then run this command again to download it.");
      return { code: result.exit, digest: result.digest, command: result.command };
  }
}
