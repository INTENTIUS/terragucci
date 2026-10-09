/**
 * The binary each plain root runs. A root may pin its own OpenTofu or
 * Terraform release; the first of these that names one wins:
 *
 *   1. `version` in terragucci.yml as a map, its first glob the root's path matches
 *   2. a `.opentofu-version` (tofu) or `.terraform-version` (terraform) file in the root
 *   3. an exact `required_version` in the root's Terraform files
 *
 * A root with no pin runs the job's binary: the image's, or the one the
 * pipeline's install step put on the path for a repo-wide `version`. A pin
 * the job's binary already is uses it as it is. Any other pin is installed
 * in the job by `install` (checked against the release's SHA256SUMS) once per
 * version, and every root that pins that version shares the one install, as
 * the wave's roots share one provider cache. The install lands in
 * `installDir`, keyed by tool and version, so a runner that keeps that
 * directory (`TOFU_INSTALL_DIR`) reuses it from one job to the next.
 *
 * Pins apply to tofu and terraform. choudoufu takes the repo-wide `version`
 * only, and a Terragrunt repo pins its binary for every unit at once.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { binaryEnv } from "./binary-env";
import { ConfigError } from "./config";
import { exactRequiredVersions, globMatch } from "./detect";
import { assertLinux, install, type Tool } from "./install";

/** The binaries a root may pin a release of. */
export type PinnedTool = "tofu" | "terraform";

/** Where a root's version came from, as the report names it. */
export interface RootPin {
  version: string;
  /** `terragucci.yml version <glob>`, `.opentofu-version`, `.terraform-version` or `required_version`. */
  source: string;
}

/** The binary one root runs. */
export interface RootBinary {
  /** What to run: the job's binary as given, or the path of the version installed for the root. */
  path: string;
  /** The binary's name: tofu, terraform or choudoufu. */
  name: string;
  /** Its version, when it says. */
  version?: string;
  /** Set when the root pinned the version. */
  pin?: string;
}

const RELEASE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

export const VERSION_FILES: Record<PinnedTool, string> = { tofu: ".opentofu-version", terraform: ".terraform-version" };

/** The release a `.opentofu-version` or `.terraform-version` file names: its first line that is not a comment, with any leading `v`. Anything but an exact release (`latest`, `min-required`, a regex) is no pin. */
export function versionFileRelease(text: string): string | undefined {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "" && !l.startsWith("#"));
  const v = line?.replace(/^v/, "");
  return v && RELEASE.test(v) ? v : undefined;
}

/** The tool a binary name pins releases of, or undefined (choudoufu, or a stand-in). */
export function pinnedTool(binary: string): PinnedTool | undefined {
  const name = basename(binary);
  return name === "tofu" || name === "terraform" ? name : undefined;
}

/** `version` from terragucci.yml as a map of root glob to release, or undefined when it is one repo-wide release. */
export function versionGlobs(version: unknown): Record<string, string> | undefined {
  return version !== null && typeof version === "object" && !Array.isArray(version) ? (version as Record<string, string>) : undefined;
}

/** The version `root` pins, and where it says so; undefined when it pins none. */
export function rootPin(repo: string, root: string, binary: string, version?: unknown): RootPin | undefined {
  const tool = pinnedTool(binary);
  if (!tool) return undefined;
  const globs = versionGlobs(version);
  if (globs) {
    const glob = Object.keys(globs).find((g) => globMatch(g, root));
    if (glob !== undefined) return { version: String(globs[glob]), source: `terragucci.yml version ${glob}` };
  }
  const dir = join(repo, root);
  const file = join(dir, VERSION_FILES[tool]);
  if (existsSync(file)) {
    const v = versionFileRelease(readFileSync(file, "utf-8"));
    if (v) return { version: v, source: VERSION_FILES[tool] };
  }
  const required = exactRequiredVersions(dir);
  if (required.length === 1) return { version: required[0], source: "required_version" };
  return undefined;
}

/** A binary's version, from `<binary> version -json`, run with no forge token. */
export function binaryVersion(binary: string, env: NodeJS.ProcessEnv): string | undefined {
  const r = spawnSync(binary, ["version", "-json"], { encoding: "utf-8", env: binaryEnv(env) });
  try {
    const v = (JSON.parse(r.stdout) as { terraform_version?: unknown }).terraform_version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

export type Installer = (tool: Tool, version: string) => Promise<string>;

/** Install as a CI job does: a Linux build, checked against its release's SHA256SUMS. */
const jobInstall: Installer = async (tool, version) => {
  assertLinux();
  return install(tool, version);
};

/**
 * The binaries a stage's roots run. `binary` is the job's (a name on the path,
 * or a path); `version` is terragucci.yml's `version` key, whose map form
 * pins roots by glob.
 */
export class RootBinaries {
  private readonly pins = new Map<string, RootPin | undefined>();
  private readonly installs = new Map<string, Promise<string>>();
  private carriedVersion: { v?: string } | undefined;

  constructor(
    private readonly repo: string,
    readonly binary: string,
    private readonly version: unknown,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly installer: Installer = jobInstall,
  ) {}

  /** The name the report gives the job's binary. */
  get name(): string {
    return basename(this.binary);
  }

  pin(root: string): RootPin | undefined {
    if (!this.pins.has(root)) this.pins.set(root, rootPin(this.repo, root, this.binary, this.version));
    return this.pins.get(root);
  }

  /** The job's binary's version, asked once. */
  carried(): string | undefined {
    this.carriedVersion ??= { v: binaryVersion(this.binary, this.env) };
    return this.carriedVersion.v;
  }

  /** What `root` runs, as the report names it, without installing anything. */
  expected(root: string): { name: string; version?: string; pin?: string } {
    const pin = this.pin(root);
    const tool = pinnedTool(this.binary);
    const version = pin && tool ? pin.version : this.carried();
    return { name: pin && tool ? tool : this.name, ...(version ? { version } : {}), ...(pin && tool ? { pin: pin.source } : {}) };
  }

  /**
   * The binary `root` runs. A pin the job's binary does not carry is installed
   * here, once per version however many roots pin it; an install that fails
   * throws, naming the root's pin.
   */
  async resolve(root: string): Promise<RootBinary> {
    const pin = this.pin(root);
    const carried = this.carried();
    const tool = pinnedTool(this.binary);
    if (!pin || !tool || pin.version === carried) {
      return { path: this.binary, name: this.name, ...(carried ? { version: carried } : {}), ...(pin ? { pin: pin.source } : {}) };
    }
    let dir = this.installs.get(pin.version);
    if (!dir) {
      dir = this.installer(tool, pin.version);
      this.installs.set(pin.version, dir);
    }
    try {
      return { path: join(await dir, tool), name: tool, version: pin.version, pin: pin.source };
    } catch (e) {
      throw new ConfigError(`${root} pins ${tool} ${pin.version} (${pin.source}), which was not installed: ${(e as Error).message}`);
    }
  }
}

export { binaryText as describeBinary } from "./report/schema";
