// A chant example's pipeline is chant's generator output, byte for byte: each
// tree with a chant.config.ts names the workflow file it commits and the chant
// command that writes it. The check copies the tree to a temporary directory,
// installs the chant its package-lock.json pins (with the lexicons the
// generator loads, as devDependencies), runs the command there and compares the
// result with the committed file.
//
//   node scripts/chant-pipelines.mjs           check every tree; exit 1 on a difference
//   node scripts/chant-pipelines.mjs --write   write the generator's output over the committed file
//
// A tree with a chant.config.ts and no entry here fails the check: every chant
// example's pipeline comes from chant.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");

export const PIPELINES = {
  "example-demo-chant": {
    file: ".forgejo/workflows/chant-pr.yml",
    args: ["build", "--components", "--generate", "forgejo", "--pr-loop", "--env", "demo", "--image", "terragucci-demo-chant:local"],
  },
  // The fan-out estate's pipeline: each job builds the fifteen templates (cfn-deploy applies dist/), and each
  // stage copies its events, report and change set to the reports bucket, where behold reads them.
  "example-demo-chant-fanout": {
    file: ".forgejo/workflows/chant-pr.yml",
    args: [
      "build", "--components", "--generate", "forgejo", "--pr-loop", "--env", "demo", "--image", "terragucci-demo-chant-fanout:local",
      "--events-json", "--report-url", "s3://demo-reports/demo/chant/${{ github.repository }}",
      "--pr-build-command", "ln -s /opt/demo-chant-fanout/node_modules node_modules && npm run build",
    ],
  },
};

/** The example trees that are chant projects: a chant.config.ts at their root. */
export function chantTrees(dir = root) {
  return readdirSync(dir)
    .filter((d) => d.startsWith("example-") && existsSync(join(dir, d, "chant.config.ts")))
    .sort();
}

function generate(tree, { file, args }) {
  const tmp = mkdtempSync(join(tmpdir(), "chant-pipeline-"));
  try {
    // The repo the demo pushes has no scenarios/ (stack/demo.sh leaves it out of the base), and a scenario's pull
    // request can carry a *.component.ts of its own, which chant would read as a second component of the same name.
    cpSync(join(root, tree), tmp, {
      recursive: true,
      filter: (src) => !src.split("/").includes("node_modules") && !src.startsWith(join(root, tree, "scenarios")),
    });
    const ci = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: tmp, encoding: "utf8" });
    if (ci.status !== 0) throw new Error(`${tree}: npm ci failed\n${ci.stderr}`);
    const out = join(tmp, "generated.yml");
    const r = spawnSync(join(tmp, "node_modules", ".bin", "chant"), [...args, "--output", out], { cwd: tmp, encoding: "utf8" });
    if (r.status !== 0 || !existsSync(out)) throw new Error(`${tree}: chant ${args.join(" ")} failed\n${r.stdout}${r.stderr}`);
    return readFileSync(out, "utf8");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes("--write");
  let bad = 0;
  for (const tree of chantTrees()) {
    const entry = PIPELINES[tree];
    if (!entry) {
      console.error(`${tree}: a chant project with no generator command in scripts/chant-pipelines.mjs`);
      bad++;
      continue;
    }
    const committed = join(root, tree, entry.file);
    const generated = generate(tree, entry);
    const same = existsSync(committed) && readFileSync(committed, "utf8") === generated;
    if (same) {
      console.log(`ok   ${tree}/${entry.file}`);
    } else if (write) {
      writeFileSync(committed, generated);
      console.log(`wrote ${tree}/${entry.file}`);
    } else {
      console.error(`${tree}/${entry.file} is not what \`chant ${entry.args.join(" ")}\` writes; run node scripts/chant-pipelines.mjs --write`);
      bad++;
    }
  }
  process.exit(bad ? 1 : 0);
}
