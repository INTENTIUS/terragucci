/**
 * The environment the stages give tofu, terraform, choudoufu and Terragrunt.
 *
 * The binary runs the providers, modules and external data sources of the
 * code it plans and applies, which on a pull request is the pull request's
 * own code. None of it needs the forge's API, so the job's forge tokens are
 * left out: `TG_TOKEN`, `TG_MERGE_TOKEN`, the forges' usual token variables,
 * and any other variable that holds the same value as `TG_TOKEN` or
 * `TG_MERGE_TOKEN` (GitLab's `GITLAB_TOKEN`, or the variable `token_env`
 * names). A variable whose name starts with `TF_` is passed as set, so a
 * backend password or a `TF_VAR_` given to the binary on purpose still
 * reaches it.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";

/** The forge token variables the binary never sees, by name. */
export const FORGE_TOKEN_ENV = [
  "TG_TOKEN",
  "TG_MERGE_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "CI_JOB_TOKEN",
  "FORGEJO_TOKEN",
  "GITEA_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
] as const;

/** `env` less every forge token, by name and by value. */
export function binaryEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const secrets = new Set([env.TG_TOKEN, env.TG_MERGE_TOKEN].filter((v): v is string => typeof v === "string" && v.length > 0));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if ((FORGE_TOKEN_ENV as readonly string[]).includes(k)) continue;
    if (v !== undefined && secrets.has(v) && !k.startsWith("TF_")) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The binary chant's step runs in place of `binary` (terragucci#1303): a
 * script of the same name in `dir` that drops the forge tokens `env` holds,
 * by name and by value, then runs `binary` with what it was given. chant runs
 * the binary with the job's environment, so this is where the tokens are left
 * out. One script per binary.
 */
export function tokenlessBinary(dir: string, given: string, env: NodeJS.ProcessEnv): string {
  // A name runs what PATH finds now, so the script never finds itself when its directory comes first on PATH.
  const binary = given.includes("/") ? given : ((env.PATH ?? "").split(delimiter).map((d) => join(d, given)).find((p) => runnable(p)) ?? given);
  const kept = binaryEnv(env);
  const drop = [...new Set([...FORGE_TOKEN_ENV, ...Object.keys(env).filter((k) => !(k in kept))])].filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).sort();
  const at = join(dir, createHash("sha256").update(`${binary}\n${drop.join(" ")}`).digest("hex").slice(0, 16));
  const path = join(at, basename(binary) || "terraform");
  if (!existsSync(path)) {
    mkdirSync(at, { recursive: true });
    const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
    writeFileSync(path, `#!/bin/sh\nexec env ${drop.map((k) => `-u ${k}`).join(" ")} ${q(binary)} "$@"\n`, { mode: 0o755 });
  }
  return path;
}

/** Whether `p` is a file this process may run. */
function runnable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Terragrunt's runner, as chant's default runs it, with the job's environment less its forge tokens. */
export const terragruntExec: TerragruntExec = (file, args, options) =>
  new Promise((done) => {
    execFile(
      file,
      [...args],
      { cwd: options.cwd, env: binaryEnv({ ...process.env, ...options.env }), maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null) : 0;
        done({ code, stdout: String(stdout), stderr: err && code === null ? `${String(stderr)}${err.message}` : String(stderr) });
      },
    );
  });
