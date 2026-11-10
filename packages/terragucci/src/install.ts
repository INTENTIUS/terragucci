/**
 * `terragucci install <binary> <version>`: fetch a release, check it, unpack
 * it, and print the directory it is in. chant's installCiTool (chant issue
 * 4784) does the work: it needs only Node, so it runs in terragucci's images,
 * which carry no curl or unzip, and it checks the archive against the
 * release's checksums file and, for the releases chant records
 * (CI_TOOL_SHA256), that sha256 too. A pipeline uses it when a repo pins a version its
 * image does not carry. It fetches Linux builds only (see assertLinux).
 */
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installCiTool } from "@intentius/chant/ci-image";
import { ConfigError } from "./config";

export type Tool = "tofu" | "terraform" | "terragrunt" | "choudoufu" | "infracost" | "cosign" | "atmos" | "terramate";

/** The Infracost release a plan job installs for `cost:`. */
export const INFRACOST_VERSION = "0.10.45";

/**
 * The cosign release the publish job installs for `modules.attest`: the 2.x
 * line, whose key-based signing takes `--tlog-upload=false`. Not in the
 * images, since attest is opt-in and cosign is a 137 MB binary.
 */
export const COSIGN_VERSION = "2.6.5";

/** The releases `install` fetches are Linux builds, for a CI job; anywhere else it says so rather than hand over a binary that will not run. */
export function assertLinux(platform: string = process.platform): void {
  if (platform !== "linux") {
    throw new ConfigError(`terragucci install fetches Linux builds for a CI job, and this machine is ${platform}; install the tool with your package manager`);
  }
}

export function installDir(tool: Tool, version: string, env = process.env): string {
  const root = env.TOFU_INSTALL_DIR ?? join(env.RUNNER_TEMP ?? tmpdir(), "terragucci-bin");
  return join(root, `${tool}-${version}`);
}

/** Install `tool` at `version` and return the directory holding it. An existing install is reused. */
export async function install(tool: Tool, version: string, env = process.env): Promise<string> {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new ConfigError(`"${version}" is not a release version`);
  try {
    const { dir } = await installCiTool(tool, version, { root: dirname(installDir(tool, version, env)) });
    return dir;
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
}
