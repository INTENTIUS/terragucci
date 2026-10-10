/**
 * A Scalr account's workspaces over Scalr's own API (`/api/iacp/v3/`, JSON:API,
 * the token in `TF_TOKEN_<host>`, credentials.tfrc.json or `SCALR_TOKEN`):
 *
 *   GET environments                                     paged
 *   GET workspaces?filter[environment]=<env>             paged
 *   GET vars?filter[environment]=<env>                   the environment's and the account's
 *   GET vars?filter[workspace]=<ws>                      the workspace's own
 *   GET policy-groups?filter[environment]=<env>&include=policies
 *
 * Scalr's API lists no run triggers, so none are read. A workspace's
 * `iac-platform` of `opentofu` runs tofu. A cloud block names a Scalr
 * workspace by its environment's name or ID as the organization, so both
 * count. Each policy group is a note: Scalr hands OPA the plan as
 * `input.tfplan` and the run as `input.tfrun`, which terragucci's `input:
 * plan` and `input: hcp` do not carry.
 */
import { ConfigError } from "../config";
import type { StoreFetch } from "../report/object-store";
import { tfeClient, type ApiResource } from "../state-source";
import type { Notes } from "./notes";
import { conceptCell } from "./platform-guide";
import { platformVar } from "./tfe";
import type { PlatformRead, PlatformVar, PlatformWorkspace } from "./workspaces";

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const relId = (r: ApiResource, name: string): string | undefined => {
  const d = r.relationships?.[name]?.data;
  return d && !Array.isArray(d) ? d.id : undefined;
};
const relIds = (r: ApiResource, name: string): string[] => {
  const d = r.relationships?.[name]?.data;
  return (Array.isArray(d) ? d : d ? [d] : []).map((x) => x.id).filter((id): id is string => typeof id === "string");
};

/** What a Scalr enforcement level becomes. */
const LEVELS: Record<string, string> = {
  "hard-mandatory": "a deny rule",
  "soft-mandatory": "a deny rule that a person in policy.override can let through",
  advisory: "a warn rule",
};

/** Read the workspaces of every environment on `host` the token sees, or of `environment` (a name or an ID). */
export async function readScalr(host: string, environment: string | undefined, env: NodeJS.ProcessEnv, fetchFn?: StoreFetch): Promise<PlatformRead> {
  const c = tfeClient(host, `scalr://${host}`, env, fetchFn, "SCALR_TOKEN");
  const b = `https://${host}/api/iacp/v3/`;
  const q = (path: string, params: Record<string, string>): string => {
    const u = new URL(path, b);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };
  const envs = (await c.list("the environments", `${b}environments`)).data.filter((e) => !environment || e.id === environment || e.attributes?.name === environment);
  if (environment && !envs.length) throw new ConfigError(`scalr://${host}: no environment the token sees is named ${environment}`);
  const workspaces: PlatformWorkspace[] = [];
  const groups = new Map<string, { group: ApiResource; envs: string[]; policies: ApiResource[] }>();
  for (const e of envs) {
    const envName = str(e.attributes?.name) ?? e.id;
    // The environment's own variables and the account's: those set on no workspace.
    const shared: PlatformVar[] = (await c.list(`${envName}'s variables`, q("vars", { "filter[environment]": e.id }))).data
      .filter((v) => !relId(v, "workspace"))
      .map((v) => platformVar(v, relId(v, "environment") ? `environments[${envName}]` : "account"))
      .filter((v) => v !== undefined);
    for (const ws of (await c.list(`${envName}'s workspaces`, q("workspaces", { "filter[environment]": e.id }))).data) {
      const a = ws.attributes ?? {};
      const name = str(a.name) ?? ws.id;
      const at = `workspaces[${envName}/${name}]`;
      const own = (await c.list(`${envName}/${name}'s variables`, q("vars", { "filter[workspace]": ws.id }))).data
        .filter((v) => relId(v, "workspace") === ws.id)
        .map((v) => platformVar(v, at))
        .filter((v) => v !== undefined);
      const vcs = a["vcs-repo"] && typeof a["vcs-repo"] === "object" ? (a["vcs-repo"] as Record<string, unknown>) : undefined;
      const platform = str(a["iac-platform"]);
      workspaces.push({
        id: ws.id,
        name,
        at,
        owners: [e.id, envName],
        ...(str(a["working-directory"]) ? { workingDirectory: str(a["working-directory"]) } : {}),
        ...(str(vcs?.identifier) ? { repo: str(vcs?.identifier) } : {}),
        ...(str(a["terraform-version"]) ? { version: str(a["terraform-version"]) } : {}),
        ...(platform === "opentofu" ? { binary: "tofu" as const } : platform === "terraform" ? { binary: "terraform" as const } : {}),
        vars: [...own, ...shared],
        ...(a["auto-apply"] === true ? { autoApply: true } : {}),
        ...(str(a["execution-mode"]) ? { executionMode: str(a["execution-mode"]) } : {}),
      });
    }
    const pg = await c.list(`${envName}'s policy groups`, q("policy-groups", { "filter[environment]": e.id, include: "policies" }));
    const policies = new Map(pg.included.filter((r) => r.type === "policies").map((r) => [r.id, r]));
    for (const g of pg.data) {
      const had = groups.get(g.id);
      if (had) had.envs.push(envName);
      else groups.set(g.id, { group: g, envs: [envName], policies: relIds(g, "policies").map((id) => policies.get(id)).filter((p) => p !== undefined) });
    }
  }
  const notes = (n: Notes): void => {
    if (workspaces.length) n.own("run-triggers", "unmapped", "Scalr's API lists no run triggers, so none were read; an order the terraform_remote_state reads do not give goes in waves.after by hand");
    for (const { group, envs: on, policies } of groups.values()) {
      const a = group.attributes ?? {};
      const vcs = a["vcs-repo"] && typeof a["vcs-repo"] === "object" ? (a["vcs-repo"] as Record<string, unknown>) : {};
      const where = [str(vcs.identifier), str(vcs.path)].filter(Boolean).join("/") || "its repo";
      const each = policies
        .filter((p) => p.attributes?.enabled !== false)
        .map((p) => `${str(p.attributes?.name) ?? p.id} (${str(p.attributes?.["enforced-level"]) ?? "advisory"}): ${LEVELS[String(p.attributes?.["enforced-level"])] ?? LEVELS.advisory}`);
      n.cell(
        "unmapped",
        `policy-groups[${str(a.name) ?? group.id}]`,
        "Scalr OPA policy group",
        conceptCell("Scalr OPA policy group"),
        `on ${on.join(", ")}, from ${where}${str(vcs.branch) ? ` at ${str(vcs.branch)}` : ""}; copy its Rego into the repo and set policy with engine: opa and input: plan${each.length ? `. Each policy becomes ${each.join("; ")}` : ""}`,
      );
    }
  };
  return { source: "scalr", host, from: host + (environment ? `/${environment}` : ""), workspaces, notes };
}
