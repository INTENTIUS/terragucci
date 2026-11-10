/**
 * The workspace a root names for itself (an Atmos instance's, ./atmos.ts),
 * and how the binary is initialised in it. Where a root's state is, and the
 * versions of it, are the terraform lexicon's (`@intentius/chant-lexicon-terraform/state`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The file a root names its Terraform workspace in. terragucci writes it in
 * each Atmos instance's directory (./atmos.ts), and the stages run the binary
 * there with `TF_WORKSPACE` set to it.
 */
export const WORKSPACE_FILE = ".terragucci-workspace";

/** The workspace the root at `dir` names in its WORKSPACE_FILE, or undefined. */
export function rootWorkspace(dir: string): string | undefined {
  const file = join(dir, WORKSPACE_FILE);
  if (!existsSync(file)) return undefined;
  const ws = readFileSync(file, "utf-8").trim();
  return ws || undefined;
}

/** `env` with `TF_WORKSPACE` set to the workspace the root at `dir` names; `env` as it is when it names none. */
export function workspaceEnv(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const ws = rootWorkspace(dir);
  return ws ? { ...env, TF_WORKSPACE: ws } : env;
}

/**
 * How a root that names its workspace is initialised: `init` in `default`,
 * which every backend has, then `workspace select -or-create` of its own,
 * since `init` refuses a selected workspace the backend does not list yet.
 * The binary runs the select with `TF_WORKSPACE` unset, which would override
 * it. Undefined for a root that names none.
 */
export function workspaceInit(env: NodeJS.ProcessEnv, dir: string): { init: NodeJS.ProcessEnv; select: string[]; selectEnv: NodeJS.ProcessEnv } | undefined {
  const ws = rootWorkspace(dir);
  if (!ws) return undefined;
  const { TF_WORKSPACE: _w, ...selectEnv } = env;
  return { init: { ...env, TF_WORKSPACE: "default" }, select: ["workspace", "select", "-or-create=true", ws], selectEnv };
}
