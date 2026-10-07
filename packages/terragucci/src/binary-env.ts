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
