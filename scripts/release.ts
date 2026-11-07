// The release step that changes files on main (CONTRIBUTING.md, Releasing).
//   npx tsx scripts/release.ts bump <version>   the package version, the images' version labels,
//                                                and every file init writes from them
// It regenerates the five Dockerfiles, both examples' pipelines, the examples'
// patches and the goldens that carry the image tags (cli-json, request
// workflows). init writes the images by bare tag from a tree; only the
// release's own bundle pins them by digest (scripts/build-cli.mjs reads the
// digests chant's cut recorded, chant.config.ts `release`).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const PKG = join(root, "packages/terragucci/package.json");
const LOCK = join(root, "package-lock.json");
const EXAMPLES = ["example", "example-terragrunt"];
const GOLDENS = ["packages/terragucci/test/cli-json.test.ts", "packages/terragucci/test/templates.test.ts"];

function run(bin: string, argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  console.log(`$ ${[bin, ...argv].join(" ")}`);
  execFileSync(bin, argv, { cwd: opts.cwd ?? root, env: opts.env ?? process.env, stdio: "inherit" });
}

const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf-8"));
const writeJson = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** Everything init writes from the version, written again. */
function regenerate(): void {
  run("just", ["render-images"]);
  // The bundle carries the version; init in the examples runs it.
  run("just", ["build-cli"]);
  for (const ex of EXAMPLES) run(process.execPath, [join(root, "packages/terragucci/dist/terragucci.mjs"), "init"], { cwd: join(root, ex) });
  // The patches carry the pipelines' blob hashes, so they follow the pipelines.
  run("just", ["example-patches"]);
  run("npx", ["vitest", "run", ...GOLDENS], { env: { ...process.env, UPDATE_GOLDEN: "1" } });
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
  console.log(`\npackages/terragucci is at ${version}. Merge it, then start the publish workflow with this version (CONTRIBUTING.md, Releasing).`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "bump" && rest.length === 1) {
  bump(rest[0]);
} else {
  console.error("usage: npx tsx scripts/release.ts bump <version>");
  process.exit(2);
}
