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
 * reaches it. The runners are the terraform lexicon's engine runner
 * (chant#4954), given terragucci's two token variables.
 */
import { engineRunner } from "@intentius/chant-lexicon-terraform/engine-runner";
import { tokenlessBinaryExec, type BinaryExec } from "@intentius/chant-lexicon-terraform/state";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";

/** terragucci's own token variables, which the binary never sees beside chant's forge token variables. */
export const TG_TOKEN_ENV = ["TG_TOKEN", "TG_MERGE_TOKEN"] as const;

/** chant's runners of the engine for terragucci. */
const engine = engineRunner({ tokens: TG_TOKEN_ENV });

/** The forge token variables the binary never sees, by name. */
export const FORGE_TOKEN_ENV: readonly string[] = engine.tokens;

/** `env` less every forge token, by name and by value. */
export const binaryEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => engine.env(env);

/**
 * The terraform lexicon's run of the binary, with the forge tokens left out of its environment. It is not the engine
 * runner's `exec`, which also sends each run through the command hook it runs under: terragucci's stages still trace
 * their own commands (report/observe.ts), so a run through the hook would be traced twice.
 */
export const runBinary: BinaryExec = tokenlessBinaryExec(TG_TOKEN_ENV);

/**
 * The binary chant's step runs in place of `binary` (terragucci#1303): the engine runner's script of the same name in
 * `dir` that drops the forge tokens `env` holds, by name and by value, then runs `binary`. One script per binary.
 */
export const tokenlessBinary = (dir: string, given: string, env: NodeJS.ProcessEnv): string => engine.script(dir, given, env);

/** Terragrunt's runner, with the job's environment less its forge tokens. */
export const terragruntExec: TerragruntExec = engine.terragrunt;
