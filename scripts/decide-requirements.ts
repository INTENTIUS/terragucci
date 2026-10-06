// Regenerate images/decide/requirements.txt, the decide image's hash-locked Python dependencies.
//   npx tsx scripts/decide-requirements.ts          rewrite the file
//   npx tsx scripts/decide-requirements.ts --check  print the file it would write and exit 1 if it differs
//
// The pins come from DECIDE_IMAGE in packages/terragucci/src/images.ts: pip, the CPU build of torch and laya[serve].
// For each platform the image runs on (CPython 3.12, linux, x86_64 and aarch64) pip resolves them with
// `pip install --dry-run --report` against PyPI plus the PyTorch CPU index, and every package is kept with the
// union of the sha256 of the wheels pip chose on the platforms. Needs python3 with pip, and network access.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DECIDE_IMAGE } from "../packages/terragucci/src/images";

const root = join(import.meta.dirname, "..");
const file = join(root, "images/decide/requirements.txt");
const check = process.argv.includes("--check");

const GLIBC = ["2_17", "2_28", "2_31", "2_34", "2_35", "2_36"];
const PLATFORMS: Record<string, string[]> = {
  x86_64: ["linux_x86_64", "manylinux2014_x86_64", ...GLIBC.map((g) => `manylinux_${g}_x86_64`)],
  aarch64: ["linux_aarch64", "manylinux2014_aarch64", ...GLIBC.map((g) => `manylinux_${g}_aarch64`)],
};

interface ReportItem {
  metadata: { name: string; version: string };
  download_info?: { archive_info?: { hashes?: { sha256?: string }; hash?: string } };
}

const wanted = [`pip==${DECIDE_IMAGE.pip}`, `torch==${DECIDE_IMAGE.torch}+cpu`, `laya[serve]==${DECIDE_IMAGE.laya}`];
const work = mkdtempSync(join(tmpdir(), "decide-requirements-"));
const packages = new Map<string, { version: string; hashes: Set<string> }>();

for (const [arch, platforms] of Object.entries(PLATFORMS)) {
  const report = join(work, `${arch}.json`);
  const p = spawnSync(
    "python3",
    [
      "-m", "pip", "install", "--dry-run", "--ignore-installed", "--quiet", "--report", report,
      "--only-binary=:all:", "--python-version", "3.12", "--implementation", "cp", "--abi", "cp312",
      ...platforms.flatMap((t) => ["--platform", t]),
      "--target", join(work, `target-${arch}`),
      "--extra-index-url", "https://download.pytorch.org/whl/cpu",
      ...wanted,
    ],
    { encoding: "utf-8", maxBuffer: 1 << 26 },
  );
  if (p.status !== 0) {
    console.error(`pip could not resolve for ${arch}:\n${p.stderr || p.stdout}`);
    process.exit(1);
  }
  for (const item of (JSON.parse(readFileSync(report, "utf-8")) as { install: ReportItem[] }).install) {
    const name = item.metadata.name.toLowerCase().replaceAll("_", "-");
    const info = item.download_info?.archive_info;
    const sha = info?.hashes?.sha256 ?? info?.hash?.replace(/^sha256=/, "");
    if (!sha) {
      console.error(`pip reported no sha256 for ${name} ${item.metadata.version} on ${arch}`);
      process.exit(1);
    }
    const have = packages.get(name);
    if (have && have.version !== item.metadata.version) {
      console.error(`${name} resolves to ${have.version} and ${item.metadata.version} on different platforms; pin one`);
      process.exit(1);
    }
    (have ?? packages.set(name, { version: item.metadata.version, hashes: new Set() }).get(name)!).hashes.add(sha);
  }
}

// Keep the file's own header: every leading comment line.
const old = readFileSync(file, "utf-8");
const header = old.split("\n").filter((l, i, all) => l.startsWith("#") && all.slice(0, i).every((x) => x.startsWith("#")));
const body = [...packages.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, p]) => `${name}==${p.version} \\\n${[...p.hashes].sort().map((h) => `    --hash=sha256:${h}`).join(" \\\n")}`);
const next = [...header, ...body].join("\n") + "\n";

if (check) {
  if (next === old) console.log("images/decide/requirements.txt is current");
  else {
    console.error("images/decide/requirements.txt differs from what the pins resolve to; run `just decide-requirements`");
    process.exit(1);
  }
} else {
  writeFileSync(file, next);
  console.log(`wrote ${file}: ${packages.size} packages`);
}
