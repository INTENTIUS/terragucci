// The CI images (chant#3422): build them, prove each one works, and hold
// each to its size budget.
//   npx tsx scripts/images.ts tags                 print each image's name and reference
//   npx tsx scripts/images.ts build [--platform p]  build all three for one platform, into the local daemon
//   npx tsx scripts/images.ts check [--platform p]  run each image's tools, and compare sizes with images/budget.json
// Tags and tool versions come from packages/terragucci, the same source `init` reads.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY, TOOL_VERSIONS, imageTag } from "../packages/terragucci/src/images";

const root = join(import.meta.dirname, "..");
const NAMES = ["tofu", "terraform", "terragrunt"] as const;
type Name = (typeof NAMES)[number];

const ref = (name: Name): string => `${REGISTRY}/terragucci-${name}:${imageTag(name)}`;

/** What each image must answer, with a version it must print. */
const PROBES: Record<Name, Array<[string[], string]>> = {
  tofu: [[["tofu", "version"], TOOL_VERSIONS.tofu]],
  terraform: [[["terraform", "version"], TOOL_VERSIONS.terraform]],
  terragrunt: [
    [["terragrunt", "--version"], TOOL_VERSIONS.terragrunt],
    [["tofu", "version"], TOOL_VERSIONS.tofu],
  ],
};

const args = process.argv.slice(2);
const cmd = args[0];
const platform = args.includes("--platform") ? args[args.indexOf("--platform") + 1] : undefined;

function run(bin: string, argv: string[]): void {
  execFileSync(bin, argv, { cwd: root, stdio: "inherit" });
}

if (cmd === "tags") {
  for (const n of NAMES) console.log(`${n} ${ref(n)}`);
} else if (cmd === "build") {
  if (!existsSync(join(root, "packages/terragucci/dist/terragucci.mjs"))) {
    console.error("packages/terragucci/dist/terragucci.mjs is missing; run just build-cli first");
    process.exit(2);
  }
  for (const n of NAMES) {
    run("docker", ["buildx", "build", "--load", ...(platform ? ["--platform", platform] : []), "-f", `images/Dockerfile.${n}`, "-t", ref(n), "."]);
  }
} else if (cmd === "check") {
  const budget = JSON.parse(readFileSync(join(root, "images/budget.json"), "utf-8")) as Record<string, number>;
  let failed = false;
  for (const n of NAMES) {
    const plat = platform ? ["--platform", platform] : [];
    for (const [argv, want] of [...PROBES[n], [["terragucci", "--help"], "terragucci init"]] as Array<[string[], string]>) {
      const out = spawnSync("docker", ["run", "--rm", ...plat, ref(n), ...argv], { encoding: "utf-8" });
      const text = `${out.stdout}${out.stderr}`;
      const ok = out.status === 0 && text.includes(want);
      if (!ok) failed = true;
      console.log(`${ok ? "ok  " : "FAIL"} ${n}: ${argv.join(" ")}${ok ? "" : `\n${text}`}`);
    }
    const bytes = Number(execFileSync("docker", ["image", "inspect", "--format", "{{.Size}}", ref(n)], { encoding: "utf-8" }).trim());
    const mb = (b: number) => (b / 1e6).toFixed(0);
    const max = budget[n];
    const over = max !== undefined && bytes > max;
    if (over || max === undefined) failed = true;
    console.log(`${over || max === undefined ? "FAIL" : "ok  "} ${n}: ${mb(bytes)} MB${max === undefined ? ", no budget in images/budget.json" : ` (budget ${mb(max)} MB)`}`);
  }
  process.exit(failed ? 1 : 0);
} else {
  console.error("usage: npx tsx scripts/images.ts tags|build|check [--platform linux/amd64|linux/arm64]");
  process.exit(2);
}
