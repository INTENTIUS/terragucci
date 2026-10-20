// The two release steps that change files on main (CONTRIBUTING.md, Releasing).
//   npx tsx scripts/release.ts bump <version>       the package version, the images' version labels,
//                                                    and every file init writes from them, with bare tags
//   npx tsx scripts/release.ts digests [--run <id>]  this version's image digests from GHCR into
//                                                    image-digests.json, and the same files again, pinned
// Both regenerate the same set: the five Dockerfiles, both examples' pipelines,
// the examples' patches and the cli-json goldens. A bump leaves the earlier
// release's digests in image-digests.json; no key matches the new tags, so init
// writes them bare until `digests` records this version's.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const PKG = join(root, "packages/terragucci/package.json");
const LOCK = join(root, "package-lock.json");
const DIGESTS = join(root, "packages/terragucci/src/image-digests.json");
const SANDBOX = join(root, "stack/sandbox-github.sh");
const EXAMPLES = ["example", "example-terragrunt"];
const GOLDENS = "packages/terragucci/test/cli-json.test.ts";

function run(bin: string, argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  console.log(`$ ${[bin, ...argv].join(" ")}`);
  execFileSync(bin, argv, { cwd: opts.cwd ?? root, env: opts.env ?? process.env, stdio: "inherit" });
}

const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf-8"));
const writeJson = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** Everything init writes from the version and the digest table, written again. */
function regenerate(): void {
  run("just", ["render-images"]);
  // The bundle carries the version and the digest table; init in the examples runs it.
  run("just", ["build-cli"]);
  for (const ex of EXAMPLES) run(process.execPath, [join(root, "packages/terragucci/dist/terragucci.mjs"), "init"], { cwd: join(root, ex) });
  // The patches carry the pipelines' blob hashes, so they follow the pipelines.
  run("just", ["example-patches"]);
  run("npx", ["vitest", "run", GOLDENS], { env: { ...process.env, UPDATE_GOLDEN: "1" } });
}

function bump(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`${version} is not a version: give it as MAJOR.MINOR.PATCH, with no v`);
    process.exit(2);
  }
  const pkg = readJson(PKG);
  if (pkg.version === version) {
    console.error(`packages/terragucci is already at ${version}`);
    process.exit(2);
  }
  pkg.version = version;
  writeJson(PKG, pkg);
  const lock = readJson(LOCK);
  lock.packages["packages/terragucci"].version = version;
  writeJson(LOCK, lock);
  regenerate();
  console.log(`\npackages/terragucci is at ${version}; init writes its images by bare tag until \`just record-digests\`.`);
}

/** The refs scripts/images.ts tags prints, as {name, ref}. */
function tags(): Array<{ name: string; ref: string }> {
  const out = execFileSync("npx", ["tsx", "scripts/images.ts", "tags"], { cwd: root, encoding: "utf-8" });
  return out
    .trim()
    .split("\n")
    .map((l) => {
      const [name, ref] = l.trim().split(/\s+/);
      return { name, ref };
    });
}

/** The digest GHCR serves for a public ref: the multi-platform index the images workflow pushed. */
async function ghcrDigest(ref: string): Promise<string> {
  const m = /^ghcr\.io\/([^:]+):(.+)$/.exec(ref);
  if (!m) throw new Error(`${ref} is not a ghcr.io reference`);
  const [, repo, tag] = m;
  const tok = await fetch(`https://ghcr.io/token?scope=repository:${repo}:pull`);
  if (!tok.ok) throw new Error(`GHCR gave no pull token for ${repo}: HTTP ${tok.status}`);
  const { token } = (await tok.json()) as { token: string };
  const res = await fetch(`https://ghcr.io/v2/${repo}/manifests/${tag}`, {
    method: "HEAD",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].join(", "),
    },
  });
  const digest = res.headers.get("docker-content-digest") ?? "";
  if (!res.ok || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`GHCR has no ${ref} (HTTP ${res.status}); has the images workflow pushed it?`);
  return digest;
}

/** The "<ref> <digest>" lines the images workflow's publish job prints, from one run's log. */
function runDigests(id: string): Map<string, string> {
  const log = execFileSync("gh", ["run", "view", id, "--log"], { cwd: root, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  const found = new Map<string, string>();
  for (const m of log.matchAll(/(ghcr\.io\/\S+:\S+) (sha256:[0-9a-f]{64})\s*$/gm)) found.set(m[1], m[2]);
  return found;
}

async function digests(runId: string | undefined): Promise<void> {
  const version: string = readJson(PKG).version;
  const fromRun = runId ? runDigests(runId) : undefined;
  const table: Record<string, string> = {};
  let failed = false;
  for (const { name, ref } of tags()) {
    let digest: string;
    try {
      digest = await ghcrDigest(ref);
    } catch (e) {
      console.error(`${name}: ${(e as Error).message}`);
      failed = true;
      continue;
    }
    if (fromRun) {
      const logged = fromRun.get(ref);
      if (logged !== digest) {
        console.error(`${name}: run ${runId} printed ${logged ?? "no digest"} for ${ref}, and GHCR serves ${digest}`);
        failed = true;
        continue;
      }
    }
    console.log(`${name} ${ref}@${digest}`);
    table[ref] = digest;
  }
  if (failed) process.exit(1);
  writeJson(DIGESTS, table);
  // The sandbox prove runs the published release's init.
  const sandbox = readFileSync(SANDBOX, "utf-8");
  writeFileSync(SANDBOX, sandbox.replace(/(TERRAGUCCI_SANDBOX_RELEASE:-)[0-9.]+/, `$1${version}`));
  regenerate();
  console.log(`\nimage-digests.json holds the ${version} images; init pins them by digest.`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "bump" && rest.length === 1) {
  bump(rest[0]);
} else if (cmd === "digests" && (rest.length === 0 || (rest.length === 2 && rest[0] === "--run"))) {
  await digests(rest[1]);
} else {
  console.error("usage: npx tsx scripts/release.ts bump <version> | digests [--run <images workflow run id>]");
  process.exit(2);
}
