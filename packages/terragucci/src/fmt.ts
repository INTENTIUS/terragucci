/**
 * `terragucci fmt`: format the working tree, and nothing else (chant#4749).
 * The binary's `fmt -recursive .` formats every Terraform file, modules
 * included; in a Terragrunt repo `terragrunt hcl fmt` formats Terragrunt's
 * own files too. chant's commit job runs it after a check finds formatting,
 * and commits and pushes what changed: the push, its guards and its record
 * are chant's.
 */
import { spawnSync } from "node:child_process";
import { binaryEnv } from "./binary-env";
import { ConfigError } from "./config";

/** The exit code the check gives for formatting it found, which starts chant's commit job. */
export const FMT_FINDING = 3;

/** The file names the formatters change, which bound the commit job's change. */
export const FMT_FILES = ["*.tf", "*.tofu", "*.tfvars", "*.hcl"];

export interface FormatOptions {
  binary: string;
  terragrunt?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Run the formatters in `cwd`; throws when one fails, which is a file it could not parse. */
export function formatTree(o: FormatOptions): string[] {
  const cwd = o.cwd ?? process.cwd();
  const env = o.env ?? process.env;
  const ran: string[] = [];
  const f = spawnSync(o.binary, ["fmt", "-recursive", "-list=true", "."], { cwd, encoding: "utf-8", env: binaryEnv(env), stdio: ["ignore", "pipe", "pipe"] });
  if (f.error) throw new ConfigError(`fmt could not run ${o.binary}: ${f.error.message}`);
  if (f.status !== 0) throw new ConfigError(`${o.binary} fmt failed:\n${(f.stderr || f.stdout).trim()}`);
  ran.push(...f.stdout.split("\n").filter(Boolean));
  if (o.terragrunt) {
    const terragrunt = env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt";
    const h = spawnSync(terragrunt, ["hcl", "fmt", "--no-color"], { cwd, encoding: "utf-8", env: binaryEnv({ ...env, TG_NON_INTERACTIVE: "true" }) });
    if (h.error) throw new ConfigError(`fmt could not run ${terragrunt}: ${h.error.message}`);
    if (h.status !== 0) throw new ConfigError(`terragrunt hcl fmt failed:\n${(h.stderr || h.stdout).trim()}`);
  }
  return ran;
}

/**
 * The commit job's spec for the fmt response (chant#4749): after a check that
 * exits FMT_FINDING, `terragucci fmt` runs and chant commits what it changed,
 * bounded to the files the formatters change. On GitHub and Forgejo the push
 * is the job's own token (`jobToken`), and `after` does what the run that
 * push starts no more would have done; GitLab's job token cannot push, so
 * there `tokenEnv` names the token.
 */
export function fmtCommitSpec(binary: string, terragrunt: boolean, after: string[], tokenEnv?: string): {
  on: "check";
  command: string[];
  allowed: string[];
  allowedFiles: string[];
  findings: number[];
  jobToken?: boolean;
  tokenEnv?: string;
  after?: string[];
} {
  return {
    on: "check",
    command: ["terragucci", "fmt", "--binary", binary, ...(terragrunt ? ["--terragrunt"] : [])],
    allowed: [],
    allowedFiles: [...FMT_FILES],
    findings: [FMT_FINDING],
    ...(tokenEnv ? { tokenEnv } : { jobToken: true }),
    ...(after.length > 0 ? { after } : {}),
  };
}
