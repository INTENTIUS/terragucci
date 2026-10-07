/**
 * The pipeline's jobs for a Terragrunt repo. The jobs are the same three as
 * for plain roots; what they run differs:
 *
 * check  `terragrunt hcl fmt --check` and `terragrunt hcl validate --inputs`.
 * plan   `terragucci stage tf-plan --terragrunt`: one `run --all` per wave.
 * apply  `terragucci stage tf-apply --terragrunt`, one job per wave: a wave
 *        is one dependency layer of the units, cut from `terragrunt find`
 *        when the job runs. The wave's units planned with one `run --all`,
 *        each plan saved, the wave's gate decided on their set digest, then
 *        the saved plans applied with one `run --all` over exactly those
 *        units. The last job runs with `--rest`, so a layer added after init
 *        wrote the pipeline applies there, behind its own gate.
 *
 * Every job runs Terragrunt with `TG_NON_INTERACTIVE`, `TG_PARALLELISM`, the
 * project's binary as `TG_TF_PATH`, and Terragrunt's provider cache. Sources
 * and providers live under `.terragrunt-cache/` at the repo root, which the
 * forge caches between runs and Terragrunt's discovery skips.
 *
 * Credentials: with `oidc`, every unit runs as its role. With
 * `terragrunt.credentials`, a generated auth-provider-cmd
 * (`terragucci auth-provider`) gives each unit the plan or apply role its
 * path maps to, over the job's OIDC token. A unit that sets its own
 * `iam_role` keeps it, and Terragrunt gets the token to assume it with.
 * terragucci never sets `TG_IAM_ASSUME_ROLE`.
 */
import { excludeFilter, TERRAGRUNT_DISCOVERY_EXCLUDES } from "@intentius/chant-lexicon-terraform/terragrunt/units";
import type { Binary, ForgeName, RolePair } from "./config";
import type { Tool } from "./install";
import { ROLES_ENV, rolesFor } from "./terragrunt";

export interface TerragruntPipelineInput {
  /** The Terragrunt release the jobs run. */
  version: string;
  parallelism: number;
  /** Unit globs discovery leaves out, beside catalog templates and the module cache. */
  exclude: string[];
  /** Plan and apply roles by unit glob, through the generated auth-provider-cmd. */
  credentials?: Record<string, RolePair>;
}

/** Where sources and providers are kept: under the repo, in a directory Terragrunt's discovery skips. */
export const TG_CACHE_DIR = ".terragrunt-cache";

const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The variables every Terragrunt job gets. */
export function terragruntJobEnv(binary: Binary, tg: TerragruntPipelineInput): Record<string, string> {
  return {
    TG_TF_PATH: binary,
    TG_NON_INTERACTIVE: "true",
    TG_PARALLELISM: String(tg.parallelism),
    TG_PROVIDER_CACHE: "1",
  };
}

/** Shell that points Terragrunt's downloads and provider cache at the cached directory. */
export function cacheExports(): string {
  return `export TG_DOWNLOAD_DIR="$PWD/${TG_CACHE_DIR}/sources" TG_PROVIDER_CACHE_DIR="$PWD/${TG_CACHE_DIR}/providers"`;
}

/** The tools a job installs because the image does not carry them at the versions asked for. */
export function terragruntInstalls(
  binary: Binary,
  binaryVersion: string,
  tgVersion: string,
  carried: { tofu: string; terragrunt: string },
): { tool: Tool; version: string }[] {
  const out: { tool: Tool; version: string }[] = [];
  if (tgVersion !== carried.terragrunt) out.push({ tool: "terragrunt", version: tgVersion });
  if (binary === "terraform") out.push({ tool: "terraform", version: binaryVersion });
  else if (binary === "tofu" && binaryVersion !== carried.tofu) out.push({ tool: "tofu", version: binaryVersion });
  return out;
}

const filters = (exclude: string[]): string =>
  [...TERRAGRUNT_DISCOVERY_EXCLUDES, ...exclude].map((g) => `--filter ${sh(excludeFilter(g))}`).join(" ");

export function terragruntCheckScript(tg: TerragruntPipelineInput, binary: Binary): string {
  return [
    "set -eu",
    cacheExports(),
    // The modules units call are plain Terraform: the binary formats them, Terragrunt formats its own files.
    `${binary} fmt -check -recursive -diff .`,
    "terragrunt hcl fmt --check --diff --no-color",
    `terragrunt hcl validate --inputs --no-color ${filters(tg.exclude)}`,
    'echo "every unit is formatted and its inputs match its module"',
    // With `policy:` set, the policy's own tests; no `policy:` key prints nothing.
    "terragucci check-policy",
  ].join("\n");
}

/**
 * Shell that sets up the auth provider for one phase. Without `oidc`, it
 * also fetches the job's OIDC token, which `oidc` would have fetched.
 */
export function credentialsScript(
  credentials: Record<string, RolePair>,
  phase: "plan" | "apply",
  token: string | undefined,
): string {
  return [
    ...(token ? ['export AWS_WEB_IDENTITY_TOKEN_FILE="$(mktemp)"', token] : []),
    `export TERRAGUCCI_REPO="$PWD" TERRAGUCCI_PHASE=${phase} ${ROLES_ENV}=${sh(JSON.stringify(rolesFor(credentials, phase)))}`,
    'export TG_AUTH_PROVIDER_CMD="terragucci auth-provider"',
    'export TG_IAM_ASSUME_ROLE_WEB_IDENTITY_TOKEN="$AWS_WEB_IDENTITY_TOKEN_FILE"',
  ].join("\n");
}

/** The forge's cache for sources and providers, keyed by every `.hcl` file, lock files included. */
export const GITHUB_CACHE_KEY = "terragucci-tg-${{ hashFiles('**/*.hcl') }}";

export function forgeCache(forge: ForgeName): Record<string, unknown> {
  return forge === "gitlab"
    ? { cache: [{ key: "terragucci-terragrunt", paths: [`${TG_CACHE_DIR}/`] }] }
    : { uses: "actions/cache@v4", with: { path: TG_CACHE_DIR, key: GITHUB_CACHE_KEY, "restore-keys": "terragucci-tg-" } };
}
