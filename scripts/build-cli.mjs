// Builds @intentius/terragucci for release: the CLI as one bundled file that
// imports Node's own modules and the installed @intentius/chant, and the
// config types for a terragucci.ts.
//   node scripts/build-cli.mjs
// The package depends on @intentius/chant at an exact pin (bundle-check holds
// it to the root's). The bundle imports chant core from it wherever that chant
// serves compiled JS (scripts/chant-external.mjs, chant#4591) and carries the
// lexicon code it uses. The TypeScript folder that a .ts config needs, and the
// HCL parser a module rollout needs, stay external and optional.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
// One set of options for the shipped bundle, the origin/main baseline and a
// smoke claim's BREAK bundle (stack/break-bundle.mjs).
import { bundleOptions as options, innerInputs } from "./cli-bundle.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages/terragucci");
const dist = join(pkg, "dist");
mkdirSync(dist, { recursive: true });
// Everything is built in a private stage inside dist and renamed into place at
// the end, so a build that runs while another one does never leaves a reader
// with a missing or half-written dist/terragucci.mjs. Renames within one
// directory are atomic; the last build to finish wins whole.
const stage = mkdtempSync(join(dist, ".stage-"));
// A build that fails (esbuild, tsc, a signal) must not leave the stage behind:
// it would ship in `npm pack`. After the renames the stage is already gone and
// the force makes this a no-op.
const cleanStage = () => rmSync(stage, { recursive: true, force: true });
process.on("exit", cleanStage);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(1));

// A release's build (chant issue 4657): the cut built the four CI images first and
// names their digests in the file CHANT_RELEASE_DIGESTS points at, { "<name>": "sha256:..." }.
// The bundle carries them as `init`'s table, keyed by each image's reference at this
// version, and dist/image-digests.json carries the same table for the npm target's `pins`.
// Any other build has no table, and `init` writes the tags bare.
const digests = releaseDigests();
// A build outside a release leaves no table from an earlier release's build behind.
if (!digests) rmSync(join(dist, "image-digests.json"), { force: true });
const base = options(pkg);
const result = await build({
  ...base,
  define: { ...(base.define ?? {}), ...(digests ? { __TERRAGUCCI_IMAGE_DIGESTS__: JSON.stringify(digests) } : {}) },
  outfile: join(stage, "terragucci.mjs"),
  sourcemap: "linked",
  // bundle-check reads this to refuse a denied input (terragucci#87).
  metafile: true,
});
// The MCP SDK's inner build (scripts/cli-bundle.mjs) is in the bundle too, so
// its inputs are held to the same denied list.
Object.assign(result.metafile.inputs, innerInputs);
// Kept out of dist so it does not ship in the tarball.
const metaDir = join(root, "node_modules/.cache/terragucci");
mkdirSync(metaDir, { recursive: true });
writeFileSync(join(metaDir, "metafile.json"), JSON.stringify(result.metafile));
chmodSync(join(stage, "terragucci.mjs"), 0o755);
if (digests) {
  // The npm target's `pins` reads this file; the publish plan refuses a digest the release did not build.
  const bundled = readFileSync(join(stage, "terragucci.mjs"), "utf-8");
  for (const [ref, digest] of Object.entries(digests)) {
    if (!bundled.includes(digest)) {
      console.error(`the bundle does not carry ${ref}@${digest}`);
      process.exit(1);
    }
  }
  writeFileSync(join(stage, "image-digests.json"), `${JSON.stringify(digests, null, 2)}\n`);
}

// The registry edge function (`terragucci registry edge`, terragucci#1287): chant's
// terraform lexicon function as a Cloudflare Worker and a Lambda@Edge handler,
// each one file a user deploys. Built only when the installed chant has
// registry/edge; without it the command says the build carries none.
const edgeEntries = {
  "registry-edge-worker.mjs": {
    platform: "browser",
    contents: 'export { registryWorker as default } from "@intentius/chant-lexicon-terraform/registry/edge";\n',
  },
  "registry-edge-lambda.mjs": {
    platform: "node",
    contents: [
      'import { readFileSync } from "node:fs";',
      'import { lambdaEdgeHandler, originFiles } from "@intentius/chant-lexicon-terraform/registry/edge";',
      '// Lambda@Edge has no environment variables: `terragucci registry edge` writes the options beside this file.',
      'const o = JSON.parse(readFileSync(new URL("./registry-edge.json", import.meta.url), "utf8"));',
      'export const handler = lambdaEdgeHandler({ files: originFiles(o.origin), ...(o.prefix ? { prefix: o.prefix } : {}), ...(o.auth ? { auth: o.auth } : {}) });',
      "",
    ].join("\n"),
  },
};
for (const [file, entry] of Object.entries(edgeEntries)) {
  try {
    await build({
      stdin: { contents: entry.contents, resolveDir: pkg, loader: "js" },
      bundle: true,
      format: "esm",
      platform: entry.platform,
      target: "es2022",
      minify: true,
      conditions: ["import", "default"],
      outfile: join(stage, file),
      logLevel: "silent",
    });
  } catch (e) {
    console.log(`  ${file}: not built (${String(e.message).split("\n")[0]})`);
  }
}

// The JSON Schemas of what terragucci writes, published so a reader can validate
// terragucci.report/v1, terragucci.report-index/v1, terragucci.estate/v1, terragucci.audit/v1, terragucci.inventory/v1, terragucci.changes/v1, terragucci.history/v1, terragucci.dora/v1, terragucci.state-versions/v1, terragucci.run/v1, terragucci.state-edges/v1, terragucci.estates/v1 and terragucci.versions/v1.
for (const f of ["report.schema.json", "report-index.schema.json", "estate.schema.json", "audit.schema.json", "inventory.schema.json", "changes.schema.json", "history.schema.json", "dora.schema.json", "state-versions.schema.json", "run.schema.json", "state-edges.schema.json", "estates.schema.json", "versions.schema.json"]) {
  copyFileSync(join(pkg, "src/report", f), join(stage, f));
}
// The generic webhook's event, chant's chant.notify/v1, for a receiver to validate.
copyFileSync(join(root, "node_modules/@intentius/chant/src/notify.schema.json"), join(stage, "notify.schema.json"));
// terragucci.yml's own schema, for editors and the provider (src/config-schema.ts builds it).
copyFileSync(join(pkg, "src/terragucci.schema.json"), join(stage, "terragucci.schema.json"));

// The config types, for `import type { TerragucciConfig } from "@intentius/terragucci"`.
execFileSync(
  join(root, "node_modules/.bin/tsc"),
  [join(pkg, "src/config.ts"), "--declaration", "--emitDeclarationOnly", "--outDir", join(stage, "types"),
    "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--types", "node"],
  { stdio: "inherit" },
);
renameSync(join(stage, "types/config.d.ts"), join(stage, "types.d.ts"));
rmSync(join(stage, "types"), { recursive: true, force: true });
// The map goes first and the bundle last, so a bundle that is there has its map.
for (const f of readdirSync(stage).sort((a, b) => Number(a === "terragucci.mjs") - Number(b === "terragucci.mjs"))) {
  renameSync(join(stage, f), join(dist, f));
}
rmSync(stage, { recursive: true, force: true });

// Size report: raw and gzipped, the change against origin/main, the ten largest
// inputs. It informs and never fails; bundle-check holds the ceiling.
const outBytes = readFileSync(join(dist, "terragucci.mjs"));
const raw = outBytes.length;
const gz = gzipSync(outBytes).length;
const fmt = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`  bundle ${fmt(raw)} raw, ${fmt(gz)} gzipped`);
// Both builds resolve chant from this node_modules, so the baseline is the
// origin/main sources on the chant build installed here. Say which, because it
// is not always the pin: chant-local installs a local build, and a bundle that
// differs from one built on the pin by a few KB is that, not the sources.
const chantBuild = (() => {
  try {
    const p = JSON.parse(readFileSync(join(root, "node_modules/@intentius/chant/package.json"), "utf8"));
    return `chant ${p.version}${p.chantLocal ? " (local build)" : ""}`;
  } catch { return "chant (not installed)"; }
})();
try {
  const baseSha = execFileSync("git", ["rev-parse", "--short", "origin/main"], { cwd: root, stdio: "pipe" }).toString().trim();
  const tmp = mkdtempSync(join(tmpdir(), "terragucci-base-"));
  execFileSync("sh", ["-c", `git archive origin/main packages scripts | tar -x -C "${tmp}"`], { cwd: root, stdio: "pipe" });
  symlinkSync(join(root, "node_modules"), join(tmp, "node_modules"));
  const base = await build({ ...options(join(tmp, "packages/terragucci")), write: false, outfile: join(tmp, "base.mjs") });
  const baseRaw = base.outputFiles[0].contents;
  const sign = (n) => `${n >= 0 ? "+" : "-"}${fmt(Math.abs(n))}`;
  console.log(`  vs origin/main ${sign(raw - baseRaw.length)} raw, ${sign(gz - gzipSync(baseRaw).length)} gzipped (origin/main ${baseSha} is ${fmt(baseRaw.length)} raw; both built with ${chantBuild})`);
  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.log(`  vs origin/main: not measured (${String(e.message).split("\n")[0]})`);
}
const largest = Object.entries(result.metafile.outputs[Object.keys(result.metafile.outputs).find((k) => k.endsWith("terragucci.mjs"))].inputs)
  .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput).slice(0, 10);
console.log("  ten largest inputs (bytes in the bundle):");
for (const [name, v] of largest) console.log(`    ${String(v.bytesInOutput).padStart(8)}  ${name.replace(/^(\.\.\/)+.*?node_modules\//, "")}`);

const kb = (p) => Math.round(statSync(p).size / 1024);
console.log(`  ✓ dist/terragucci.mjs ${kb(join(dist, "terragucci.mjs"))} KB, dist/types.d.ts ${kb(join(dist, "types.d.ts"))} KB`);

/** The release's image digests as `init`'s table, or undefined outside a release build. */
function releaseDigests() {
  const file = process.env.CHANT_RELEASE_DIGESTS;
  if (!file) return undefined;
  const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf-8"));
  // The release's label is the version: `just version-bump` set it on main before the cut.
  const label = process.env.CHANT_RELEASE_LABEL;
  if (label && label !== version) {
    console.error(`the release is labelled ${label}, and packages/terragucci/package.json is at ${version}; run just version-bump ${label} and cut the merged commit`);
    process.exit(1);
  }
  const named = JSON.parse(readFileSync(file, "utf-8"));
  const table = {};
  for (const [name, tag] of Object.entries(imageTags(version))) {
    const digest = named[name];
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      console.error(`${file} has no digest for the ${name} image, which the release builds`);
      process.exit(1);
    }
    table[`ghcr.io/intentius/terragucci-${name}:${tag}`] = digest;
  }
  return table;
}

/** Each CI image's tag at `version`, as imageTag in packages/terragucci/src/images.ts gives it. */
function imageTags(version) {
  const src = readFileSync(join(pkg, "src/images.ts"), "utf-8");
  const tool = (k) => new RegExp(`${k}: "([^"]+)"`).exec(src)[1];
  const [tofu, terraform, terragrunt, choudoufu] = ["tofu", "terraform", "terragrunt", "choudoufu"].map(tool);
  return { tofu: `${version}-tofu${tofu}`, terraform: `${version}-tf${terraform}`, terragrunt: `${version}-tg${terragrunt}-tofu${tofu}`, choudoufu: `${version}-choudoufu${choudoufu}` };
}
