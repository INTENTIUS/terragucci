/**
 * `terragucci import hcp|otf|scalr`: read a platform's workspaces over its
 * API (./tfe.ts for HCP Terraform and OTF, ./scalr.ts for Scalr) and write
 * terragucci.yml, with each note naming a row of the guide "Coming from HCP
 * Terraform, Scalr or OTF" (./platform-guide.ts).
 *
 * A terragucci root is one directory with one state. A workspace becomes a
 * root at the directory a `cloud` block or `remote` backend in the repo names
 * it from, else at its working directory when it is connected to this repo.
 * A directory several workspaces run is listed to split and left out of
 * `roots`. For each root:
 *
 *   terraform version      `version`, a map of root to release when they differ
 *   terraform variables    <root>/terraform.tfvars, when there is none
 *   env variables          `env`, when every workspace that sets one agrees
 *   sensitive variables    their names under `pass.secrets`; values never read
 *   run triggers           `waves.after`, less what the reads already order
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { emitYAML } from "@intentius/chant/yaml";
import { ConfigError, findConfig, RELEASE_VERSION, validateConfig, type ForgeName, type ProjectSettings } from "../config";
import { detectForge, findRoots, rootDependencies, stateOf } from "../detect";
import { Notes, rootOf, wavesAfterOf, type ImportNote } from "./notes";
import { conceptCell, PLATFORM_GUIDE_URL, type ConceptRow } from "./platform-guide";

export const PLATFORM_SOURCES = ["hcp", "otf", "scalr"] as const;
export type PlatformSource = (typeof PLATFORM_SOURCES)[number];

export const PLATFORM_NAMES: Record<PlatformSource, string> = { hcp: "HCP Terraform", otf: "OTF", scalr: "Scalr" };

/** A variable as the platform keeps it. A sensitive one's value is never read. */
export interface PlatformVar {
  key: string;
  value?: string;
  /** `env` covers Scalr's `shell`. */
  category: "terraform" | "env";
  sensitive: boolean;
  hcl: boolean;
  /** Where it is set, as a note key: `workspaces[app].vars.region`, `varsets[shared].vars.region`. */
  at: string;
}

export interface PlatformWorkspace {
  id: string;
  name: string;
  /** The note key, such as `workspaces[acme/app]`. */
  at: string;
  /** Each spelling a `cloud` block's organization may give the owner: an organization's name, a Scalr environment's name and ID. */
  owners: string[];
  workingDirectory?: string;
  /** The VCS repository it runs from, `owner/name`. */
  repo?: string;
  version?: string;
  binary?: "terraform" | "tofu";
  /** Its own variables and its variable sets', its own first. */
  vars: PlatformVar[];
  /** The IDs of the workspaces whose applies start a run of this one; undefined when the API lists none. */
  upstream?: string[];
  autoApply?: boolean;
  executionMode?: string;
}

/** What a reader got from the platform. */
export interface PlatformRead {
  source: PlatformSource;
  host: string;
  /** What was read, for the header and the result: `app.terraform.io/acme`. */
  from: string;
  workspaces: PlatformWorkspace[];
  /** Notes the reader has of its own, such as Scalr's policy groups. */
  notes?: (n: Notes) => void;
}

export interface WorkspaceImportOptions {
  /** This repo as the VCS connection names it, `owner/name`; undefined accepts every connected workspace. */
  repo?: string;
  forge?: ForgeName;
  /** Each root's state address as its code names it (`remote:<host>/<org>/<name>`), to find the directory a CLI-driven workspace runs. */
  codeStates?: ReadonlyMap<string, string>;
  /** The roots' terraform_remote_state reads, which run triggers are read against. */
  reads?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Whether a root already has a terraform.tfvars. */
  hasTfvars?: (root: string) => boolean;
}

export interface WorkspaceConverted {
  settings: ProjectSettings;
  notes: ImportNote[];
  /** terraform.tfvars to write, by root. */
  tfvars: Map<string, string>;
}

/** A tfvars value: an HCL variable as written, any other a quoted string with its templates escaped. */
function tfvarsValue(v: PlatformVar): string {
  const value = v.value ?? "";
  if (v.hcl) return value;
  return JSON.stringify(value).replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{");
}

/** The variable a CI secret holding it must be named: an env variable as is, a Terraform one as TF_VAR_<key>. */
export const secretName = (v: PlatformVar): string => (v.category === "env" ? v.key : `TF_VAR_${v.key}`);

/** Platform settings among env variables: not the code's, so not written. */
const PLATFORM_ENV = /^(TFC_|TFE_|SCALR_|OTF_)/;
const DYNAMIC_CREDENTIALS = /^(TFC|SCALR)_(AWS|GCP|AZURE|VAULT)_|^TFC_.*_(PROVIDER_AUTH|RUN_ROLE_ARN|RUN_SERVICE_ACCOUNT_EMAIL|RUN_CLIENT_ID)$/;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Turn the workspaces read into terragucci settings, the tfvars to write and a note per setting. */
export function convertWorkspaces(read: PlatformRead, o: WorkspaceImportOptions = {}): WorkspaceConverted {
  const notes = new Notes();
  const note = (kind: ImportNote["kind"], key: string, row: ConceptRow, detail?: string) => notes.cell(kind, key, row, conceptCell(row), detail);
  const s: ProjectSettings = {};
  const tfvars = new Map<string, string>();
  const host = read.host.toLowerCase();

  // Each workspace's directory.
  const dirOf = new Map<string, string>();
  for (const w of read.workspaces) {
    const named = w.owners.map((owner) => o.codeStates?.get(`remote:${host}/${owner}/${w.name}`)).find((d) => d !== undefined);
    if (named !== undefined) {
      dirOf.set(w.id, named);
      continue;
    }
    if (!w.repo) {
      note("unmapped", w.at, "Workspace", "no VCS connection, and no `cloud` block or `remote` backend in the repo names it, so its directory is unknown; skipped");
      continue;
    }
    if (o.repo && w.repo.toLowerCase() !== o.repo.toLowerCase()) {
      note("unmapped", w.at, "Workspace", `it runs ${w.repo}, not ${o.repo}; skipped`);
      continue;
    }
    const dir = rootOf(w.workingDirectory ?? "");
    if (dir === undefined) {
      note("unmapped", `${w.at}.working-directory`, "Workspace", `${JSON.stringify(w.workingDirectory)} is not a directory inside the repo; skipped`);
      continue;
    }
    dirOf.set(w.id, dir);
  }
  const byDir = new Map<string, PlatformWorkspace[]>();
  for (const w of read.workspaces) {
    const d = dirOf.get(w.id);
    if (d !== undefined) byDir.set(d, [...(byDir.get(d) ?? []), w]);
  }
  // The roots: directories one workspace runs.
  const rootOfWs = new Map<string, string>();
  const roots: [string, PlatformWorkspace][] = [];
  for (const [dir, ws] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    if (ws.length > 1) {
      note("unmapped", `workspaces[${ws.map((w) => w.name).join(", ")}]`, "Several workspaces on one working directory", `${dir} runs ${plural(ws.length, "workspace", "workspaces")}, and a root is one state: give each its own directory and add it to roots; ${dir} is left out of roots, its variables not copied`);
      continue;
    }
    const w = ws[0];
    rootOfWs.set(w.id, dir);
    roots.push([dir, w]);
    const how = o.codeStates && w.owners.some((owner) => o.codeStates!.get(`remote:${host}/${owner}/${w.name}`) === dir) ? "its cloud block or remote backend" : "its working directory";
    note("mapped", w.at, "Workspace", `roots: ${dir}, from ${how}`);
  }
  if (roots.length) s.roots = roots.map(([d]) => d);

  // Which binary and version.
  const exact = new Map<string, string>();
  for (const [dir, w] of roots) {
    if (!w.version) continue;
    const v = w.version.replace(/^v/, "");
    if (RELEASE_VERSION.test(v)) exact.set(dir, v);
    else note("unmapped", `${w.at}.terraform-version`, "Terraform version per workspace", `${w.version} is not one release, so the root's required_version pin is read instead`);
  }
  const releases = [...new Set(exact.values())];
  const binaries = new Set(roots.map(([, w]) => w.binary).filter((b) => b !== undefined));
  if (binaries.size > 1) {
    const tofu = roots.filter(([, w]) => w.binary === "tofu").map(([d]) => d);
    note("unmapped", "workspaces[].iac-platform", "Terraform version per workspace", `only ${tofu.join(", ")} run OpenTofu, and the pipeline runs one binary; no version written`);
  } else if (releases.length) {
    s.binary = binaries.has("tofu") ? "tofu" : "terraform";
    if (releases.length === 1 && exact.size === roots.length) {
      s.version = releases[0];
      note("mapped", "workspaces[].terraform-version", "Terraform version per workspace", `binary: ${s.binary}, version: ${releases[0]}`);
    } else {
      s.version = Object.fromEntries([...exact].sort(([a], [b]) => a.localeCompare(b)));
      note("mapped", "workspaces[].terraform-version", "Terraform version per workspace", `binary: ${s.binary}, version: a release per root, ${[...exact].map(([d, v]) => `${d} ${v}`).join(", ")}`);
    }
  } else if (binaries.has("tofu")) {
    s.binary = "tofu";
    note("mapped", "workspaces[].iac-platform", "Terraform version per workspace", "binary: tofu");
  }

  // Variables.
  const env = new Map<string, { value: string; at: string; roots: string[] }>();
  const conflicts = new Set<string>();
  const secrets = new Map<string, string[]>();
  for (const [dir, w] of roots) {
    // A workspace's own variable wins over a set's of the same key and category.
    const seen = new Set<string>();
    const vars = w.vars.filter((v) => {
      const k = `${v.category}\0${v.key}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const lines: string[] = [];
    const tfvarKeys: string[] = [];
    for (const v of vars) {
      if (v.sensitive) {
        const name = secretName(v);
        secrets.set(name, [...(secrets.get(name) ?? []), v.at]);
        continue;
      }
      if (v.category === "terraform") {
        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(v.key)) {
          note("unmapped", v.at, "Terraform variables", `${JSON.stringify(v.key)} is not a variable name`);
          continue;
        }
        lines.push(`${v.key} = ${tfvarsValue(v)}`);
        tfvarKeys.push(v.at);
        continue;
      }
      if (DYNAMIC_CREDENTIALS.test(v.key)) {
        note("unmapped", v.at, "Dynamic provider credentials", "name the plan and apply roles under `oidc`");
        continue;
      }
      if (PLATFORM_ENV.test(v.key)) {
        notes.own(v.at, "unmapped", `a setting of the platform's runs, not of the code; nothing written. See ${PLATFORM_GUIDE_URL}`);
        continue;
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key)) {
        note("unmapped", v.at, "Environment variables, variable sets", `${JSON.stringify(v.key)} is not a variable name`);
        continue;
      }
      const had = env.get(v.key);
      if (had && had.value !== (v.value ?? "")) {
        conflicts.add(v.key);
        note("unmapped", v.at, "Environment variables, variable sets", `${v.key} is set to two values (in ${had.at} too), and env holds one`);
      } else if (had) had.roots.push(dir);
      else env.set(v.key, { value: v.value ?? "", at: v.at, roots: [dir] });
    }
    if (lines.length) {
      if (o.hasTfvars?.(dir)) {
        note("unmapped", `${w.at}.vars`, "Terraform variables", `${dir}/terraform.tfvars is already there; add ${tfvarKeys.map((k) => k.replace(/.*\./, "")).join(", ")} to it by hand`);
      } else {
        tfvars.set(dir, `# Written by terragucci import ${read.source} from ${read.from}, workspace ${w.name}.\n${lines.join("\n")}\n`);
        note("mapped", `${w.at}.vars`, "Terraform variables", `${dir}/terraform.tfvars: ${tfvarKeys.map((k) => k.replace(/.*\./, "")).join(", ")}`);
      }
    }
  }
  const kept = [...env].filter(([k]) => !conflicts.has(k));
  if (kept.length) {
    s.env = Object.fromEntries(kept.map(([k, v]) => [k, v.value]));
    for (const [k, v] of kept) {
      const some = v.roots.length < roots.length ? `; set on ${v.roots.length} of ${roots.length} roots, and env gives it to every job` : "";
      note("mapped", v.at, "Environment variables, variable sets", `env: ${k}${some}`);
    }
  }
  if (secrets.size) {
    const names = [...secrets.keys()].sort();
    if (o.forge === "gitlab") {
      for (const [name, at] of secrets) note("unmapped", at.length === 1 ? at[0] : `${name}`, "Environment variables, variable sets", `sensitive: create a masked CI/CD variable ${name}, which reaches every job; its value is not read from the platform`);
    } else {
      s.pass = { secrets: names };
      for (const [name, at] of secrets) note("mapped", at.length === 1 ? at[0] : `${name}`, "Environment variables, variable sets", `pass.secrets: ${name}, a CI secret to create; its value is not read from the platform`);
    }
  }

  // Order: run triggers.
  const edges: { at: string; d: string; u: string }[] = [];
  const byId = new Map(read.workspaces.map((w) => [w.id, w]));
  for (const [dir, w] of roots) {
    for (const up of w.upstream ?? []) {
      const at = `${w.at}.run-triggers`;
      const u = rootOfWs.get(up);
      if (u === undefined) note("unmapped", at, "Run triggers, `tfe_outputs`", `${byId.get(up)?.name ?? up} is not a root here, so the order after it is not kept`);
      else if (u !== dir) edges.push({ at, d: dir, u });
    }
  }
  const { after, fromReads, cycle } = wavesAfterOf(edges.map((e) => [e.d, e.u] as const), o.reads);
  if (Object.keys(after).length) s.waves = { after };
  for (const e of edges) {
    const what = `${e.d} after ${e.u}`;
    if (fromReads.has(`${e.d}\0${e.u}`)) note("default", e.at, "Run triggers, `tfe_outputs`", `the terraform_remote_state reads already order ${what}`);
    else if (cycle) note("unmapped", e.at, "Run triggers, `tfe_outputs`", `${what} is not kept: with the terraform_remote_state reads the triggers make a cycle, ${cycle.join(" after ")}`);
    else note("mapped", e.at, "Run triggers, `tfe_outputs`", `waves.after: ${what}`);
  }

  // What the import reads and leaves to the pipeline or a person.
  const connected = roots.filter(([, w]) => w.repo).length;
  if (connected) note("default", "workspaces[].vcs-repo", "VCS-driven runs, trigger patterns", `${plural(connected, "root runs", "roots run")} from the repo; trigger patterns are not needed`);
  const auto = roots.filter(([, w]) => w.autoApply).map(([, w]) => w.name);
  if (auto.length) note("unmapped", "workspaces[].auto-apply", "Confirm and apply, auto-apply", `${auto.join(", ")} apply with no confirmation: \`gate: never\` does that for every wave, and the default waits only for a destroy`);
  const agents = roots.filter(([, w]) => w.executionMode === "agent").map(([, w]) => w.name);
  if (agents.length) note("unmapped", "workspaces[].execution-mode", "Agents, remote execution", `${agents.join(", ")} run on an agent pool: name your own runners with \`runner\``);
  read.notes?.(notes);

  validateConfig(s, "terragucci.yml");
  return { settings: s, notes: notes.list, tfvars };
}

/** This repo as a VCS connection names it, `owner/name`, from a git remote URL. */
export function repoOfRemote(remote: string): string | undefined {
  const path = remote.trim().replace(/^[a-z+]+:\/\/[^/]+\//i, "").replace(/^[^@/]+@[^:/]+:/, "").replace(/\.git$/, "").replace(/\/$/, "");
  return /^[^/\s:]+(\/[^/\s:]+)+$/.test(path) ? path : undefined;
}

function originRepo(repo: string): string | undefined {
  try {
    return repoOfRemote(execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return undefined;
  }
}

export interface WorkspaceImportResult extends WorkspaceConverted {
  source: PlatformSource;
  from: string;
  wrote?: string;
  yaml: string;
  /** The terraform.tfvars files written, or that would be. */
  tfvarsFiles: string[];
  /** Roots that match no directory with Terraform files. */
  missing: string[];
  /** The repo the workspaces were matched against, and how it was found. */
  repo?: string;
}

/** Read the platform's workspaces with `reader`, convert them, and write terragucci.yml and the tfvars unless `dryRun`. */
export async function importWorkspaces(repo: string, reader: () => Promise<PlatformRead>, o: { repo?: string; forge?: ForgeName; dryRun?: boolean; force?: boolean } = {}): Promise<WorkspaceImportResult> {
  const existing = findConfig(repo);
  if (!o.dryRun && existing && !o.force) throw new ConfigError(`${relative(repo, existing)} is already here; --force replaces it, or --dry-run prints what would be written`);
  if (!o.dryRun && existing && !/\.ya?ml$/.test(existing)) throw new ConfigError(`${relative(repo, existing)} is not YAML; move it aside first`);
  const read = await reader();
  const found = findRoots(repo);
  const codeStates = new Map<string, string>();
  for (const r of found) {
    const own = stateOf(repo, r).own;
    // state-address.ts writes the host in lower case, as the reader's is compared.
    if (own?.key.startsWith("remote:")) codeStates.set(own.key, r);
  }
  const reads = rootDependencies(repo, found);
  const forge = o.forge ?? detectForge(repo)?.value;
  const repoName = o.repo ?? originRepo(repo);
  const converted = convertWorkspaces(read, { ...(repoName ? { repo: repoName } : {}), ...(forge ? { forge } : {}), codeStates, reads, hasTfvars: (r) => existsSync(join(repo, r, "terraform.tfvars")) });
  if (!repoName) converted.notes.unshift({ key: "repo", kind: "unmapped", row: "", text: "the repo has no origin remote, so every workspace connected to a repository was read as this one's; --repo owner/name narrows it" });
  const { settings, tfvars } = converted;
  const yaml = `# Written by terragucci import ${read.source} from ${read.from}. What became of each setting: ${PLATFORM_GUIDE_URL}\n${Object.keys(settings).length ? emitYAML(settings, 0).trim() : "{}"}\n`;
  const missing = (settings.roots ?? []).filter((r) => findRoots(repo, [r]).length === 0);
  const tfvarsFiles = [...tfvars.keys()].filter((r) => !missing.includes(r)).map((r) => (r === "." ? "terraform.tfvars" : `${r}/terraform.tfvars`));
  let wrote: string | undefined;
  if (!o.dryRun) {
    const out = existing ?? join(repo, "terragucci.yml");
    writeFileSync(out, yaml);
    wrote = relative(repo, out);
    for (const [r, text] of tfvars) if (!missing.includes(r)) writeFileSync(join(repo, r, "terraform.tfvars"), text);
  }
  return { ...converted, source: read.source, from: read.from, yaml, tfvarsFiles, missing, ...(wrote ? { wrote } : {}), ...(repoName ? { repo: repoName } : {}) };
}

const HEADINGS: Record<ImportNote["kind"], string> = {
  mapped: "Written",
  default: "Done by terragucci with no key",
  unmapped: "Not mapped",
  "left-out": "Left out on purpose",
};

/** The text `terragucci import hcp|otf|scalr` prints. */
export function describeWorkspaceImport(r: WorkspaceImportResult): string {
  const out: string[] = [];
  const files = r.tfvarsFiles.length ? ` and ${r.tfvarsFiles.join(", ")}` : "";
  out.push(r.wrote ? `read ${PLATFORM_NAMES[r.source]} ${r.from}, wrote ${r.wrote}${files}:` : `read ${PLATFORM_NAMES[r.source]} ${r.from}; dry run, nothing written. terragucci.yml would be${files ? `, with${files},` : ""}:`);
  out.push("", ...r.yaml.trimEnd().split("\n").map((l) => `  ${l}`));
  for (const kind of ["mapped", "default", "unmapped", "left-out"] as const) {
    const notes = r.notes.filter((n) => n.kind === kind);
    if (!notes.length) continue;
    out.push("", `${HEADINGS[kind]}:`);
    for (const n of notes) {
      const detail = n.detail ? `${n.detail}. ` : "";
      out.push(`  ${n.key}${n.row ? ` (${n.row})` : ""}: ${detail}${n.row ? `The guide: ${n.text}` : n.text}`);
    }
  }
  const secrets = r.settings.pass?.secrets ?? [];
  if (secrets.length) out.push("", `Secrets to create in the forge before the first plan, with the values from where they came from: ${secrets.join(", ")}`);
  if (r.missing.length) out.push("", `No directory with Terraform files matches ${r.missing.join(", ")}; check those workspaces' working directory.`);
  out.push("", `Next: \`npx terragucci init\` writes the pipeline for these settings. Every mapping: ${PLATFORM_GUIDE_URL}`);
  return out.join("\n");
}
