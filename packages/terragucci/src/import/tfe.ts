/**
 * An organization's workspaces over the TFE API, as HCP Terraform, Terraform
 * Enterprise and OTF serve it, through the client a backend move uses
 * (../state-source.ts): discovery, then
 *
 *   GET organizations/<org>/workspaces              paged
 *   GET workspaces/<id>/vars
 *   GET workspaces/<id>/varsets                     404 on a server without them
 *   GET varsets/<id>/relationships/vars
 *   GET workspaces/<id>/run-triggers?filter[run-trigger][type]=inbound
 *                                                   404 on a server without them
 *
 * A sensitive variable's value is never read: the API gives none, and a value
 * a server sends anyway is dropped here.
 */
import type { StoreFetch } from "../report/object-store";
import { tfeClient, type ApiResource } from "../state-source";
import type { PlatformRead, PlatformVar, PlatformWorkspace } from "./workspaces";

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const relId = (r: ApiResource, name: string): string | undefined => {
  const d = r.relationships?.[name]?.data;
  return d && !Array.isArray(d) ? d.id : undefined;
};

/** A variable resource as a PlatformVar; undefined for a category that is not one of Terraform's or the environment's. */
export function platformVar(r: ApiResource, at: string): PlatformVar | undefined {
  const a = r.attributes ?? {};
  const key = str(a.key);
  const category = a.category === "terraform" ? "terraform" : a.category === "env" || a.category === "shell" ? "env" : undefined;
  if (!key || !category) return undefined;
  const sensitive = a.sensitive === true;
  return { key, category, sensitive, hcl: a.hcl === true, at: `${at}.vars.${key}`, ...(!sensitive && typeof a.value === "string" ? { value: a.value } : {}) };
}

/** Read `org`'s workspaces on `host` (`hcp` or `otf`). */
export async function readTfe(source: "hcp" | "otf", host: string, org: string, env: NodeJS.ProcessEnv, fetchFn?: StoreFetch): Promise<PlatformRead> {
  const from = `${host}/${org}`;
  const c = tfeClient(host, `${source}://${from}`, env, fetchFn);
  const b = await c.api();
  const { data } = await c.list("the organization's workspaces", `${b}organizations/${encodeURIComponent(org)}/workspaces`);
  const varsets = new Map<string, { name: string; vars: ApiResource[] }>();
  const optional = async (what: string, url: string): Promise<ApiResource[] | undefined> => {
    const r = await c.call(url);
    if (r.status === 404) return undefined;
    const doc = c.json<{ data?: unknown }>(what, r);
    return Array.isArray(doc.data) ? (doc.data as ApiResource[]) : [];
  };
  const workspaces: PlatformWorkspace[] = [];
  for (const ws of data) {
    const a = ws.attributes ?? {};
    const name = str(a.name) ?? ws.id;
    const at = `workspaces[${name}]`;
    const own = c.json<{ data?: ApiResource[] }>(`${name}'s variables`, await c.call(`${b}workspaces/${ws.id}/vars`)).data ?? [];
    const vars = own.map((r) => platformVar(r, at)).filter((v) => v !== undefined);
    for (const set of (await optional(`${name}'s variable sets`, `${b}workspaces/${ws.id}/varsets`)) ?? []) {
      if (!varsets.has(set.id)) {
        const setName = str(set.attributes?.name) ?? set.id;
        const got = c.json<{ data?: ApiResource[] }>(`variable set ${setName}`, await c.call(`${b}varsets/${set.id}/relationships/vars`)).data ?? [];
        varsets.set(set.id, { name: setName, vars: got });
      }
      const vs = varsets.get(set.id)!;
      vars.push(...vs.vars.map((r) => platformVar(r, `varsets[${vs.name}]`)).filter((v) => v !== undefined));
    }
    const triggers = await optional(`${name}'s run triggers`, `${b}workspaces/${ws.id}/run-triggers?filter%5Brun-trigger%5D%5Btype%5D=inbound`);
    const vcs = a["vcs-repo"] && typeof a["vcs-repo"] === "object" ? (a["vcs-repo"] as Record<string, unknown>) : undefined;
    workspaces.push({
      id: ws.id,
      name,
      at,
      owners: [org],
      ...(str(a["working-directory"]) ? { workingDirectory: str(a["working-directory"]) } : {}),
      ...(str(vcs?.identifier) ? { repo: str(vcs?.identifier) } : {}),
      ...(str(a["terraform-version"]) ? { version: str(a["terraform-version"]) } : {}),
      vars,
      ...(triggers ? { upstream: triggers.map((t) => relId(t, "sourceable")).filter((id) => id !== undefined) } : {}),
      ...(a["auto-apply"] === true ? { autoApply: true } : {}),
      ...(str(a["execution-mode"]) ? { executionMode: str(a["execution-mode"]) } : {}),
    });
  }
  return { source, host, from, workspaces };
}
