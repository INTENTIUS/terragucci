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
 * reaches it. The rule is the terraform lexicon's `engineEnv` (chant#4910),
 * given terragucci's two token variables.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { FORGE_TOKEN_VARS } from "@intentius/chant/ci-handover";
import { engineEnv, tokenlessBinaryExec, type BinaryExec } from "@intentius/chant-lexicon-terraform/state";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";

/** terragucci's own token variables, which the binary never sees beside chant's forge token variables. */
export const TG_TOKEN_ENV = ["TG_TOKEN", "TG_MERGE_TOKEN"] as const;

/** The forge token variables the binary never sees, by name. */
export const FORGE_TOKEN_ENV: readonly string[] = [...TG_TOKEN_ENV, ...FORGE_TOKEN_VARS];

/** `env` less every forge token, by name and by value (chant's engineEnv). */
export const binaryEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => engineEnv(env, TG_TOKEN_ENV);

/** The terraform lexicon's run of the binary, with the forge tokens left out of its environment (chant's tokenlessBinaryExec). */
export const runBinary: BinaryExec = tokenlessBinaryExec(TG_TOKEN_ENV);

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
