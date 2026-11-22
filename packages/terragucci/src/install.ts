/**
 * `terragucci install <binary> <version>`: fetch a release, check it, unpack
 * it, and print the directory it is in. chant's installCiTool (chant issue
 * 4784) does the work: it needs only Node, so it runs in terragucci's images,
 * which carry no curl or unzip, and it checks the archive against the
 * release's checksums file and, for the releases chant records
 * (CI_TOOL_SHA256), that sha256 too. A pipeline uses it when a repo pins a version its
 * image does not carry. It fetches Linux builds only (see assertLinux).
 *
 * A job that runs as a user who cannot write the install directory, such as
 * the Chainguard images' 65532 under a cache a runner mounts as root, installs
 * under its own $HOME instead and says so (installRoot).
 */
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ciToolBin, installCiTool } from "@intentius/chant/ci-image";
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

/** The filesystem calls installRoot makes, so a test can stand in for a directory the job's user cannot write. */
export interface InstallFs {
  /** Whether the file is there. */
  exists(path: string): boolean;
  /** Create the directory if it is missing and say whether this process can write in it. */
  writable(dir: string): boolean;
}

const nodeFs: InstallFs = {
  exists: existsSync,
  writable(dir) {
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export interface InstallRootOptions {
  fs?: InstallFs;
  /** The job's user, for the messages. Default this process's. */
  uid?: number;
  /** The temporary directory, the last place tried. Default the system's. */
  tmp?: string;
  /** Where the one line about a fallback goes. Default stderr. */
  warn?: (line: string) => void;
}

/**
 * The directory the versioned install goes under. It is the configured one
 * (TOFU_INSTALL_DIR, else $RUNNER_TEMP/terragucci-bin, else the temp
 * directory) when the release is already there or the job's user can write
 * it, so a runner that keeps that directory still shares it. Otherwise it is
 * the first of `$HOME/.cache/terragucci-bin` and the temp directory's
 * `terragucci-bin` that the user can write, with one line saying so. With none writable it
 * refuses, naming the directory, the user and the remedy.
 */
export function installRoot(tool: Tool, version: string, env: NodeJS.ProcessEnv = process.env, options: InstallRootOptions = {}): string {
  const fs = options.fs ?? nodeFs;
  const configured = dirname(installDir(tool, version, env));
  const has = (root: string): boolean => {
    try {
      return fs.exists(ciToolBin(tool, version, root));
    } catch {
      return false;
    }
  };
  if (has(configured) || fs.writable(configured)) return configured;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const fallbacks = [env.HOME ? join(env.HOME, ".cache", "terragucci-bin") : undefined, join(options.tmp ?? tmpdir(), "terragucci-bin")].filter(
    (d, i, all): d is string => d !== undefined && d !== configured && all.indexOf(d) === i,
  );
  const root = fallbacks.find((d) => has(d) || fs.writable(d));
  if (!root) {
    throw new ConfigError(
      `uid ${uid} cannot write ${configured} or ${fallbacks.join(" or ")}, so ${tool} ${version} cannot be installed; set TOFU_INSTALL_DIR to a directory that user can write, or give it ${configured}`,
    );
  }
  (options.warn ?? ((l: string) => process.stderr.write(`${l}\n`)))(
    `terragucci: uid ${uid} cannot write ${configured}, so ${tool} ${version} installs under ${root} instead, outside the directory later jobs share`,
  );
  return root;
}

/** Install `tool` at `version` and return the directory holding it. An existing install is reused. */
export async function install(tool: Tool, version: string, env = process.env, options: InstallRootOptions & { installer?: typeof installCiTool } = {}): Promise<string> {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new ConfigError(`"${version}" is not a release version`);
  // Decided before the download, so a directory the job cannot write costs no fetch.
  const root = installRoot(tool, version, env, options);
  try {
    const { dir } = await (options.installer ?? installCiTool)(tool, version, { root });
    return dir;
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
}
