// The CI images (terragucci#19): build them, prove each one works, and hold
// each to its size budget.
//   npx tsx scripts/images.ts tags                 print each image's name and reference
//   npx tsx scripts/images.ts build [--platform p]  build all four for one platform, into the local daemon
//   npx tsx scripts/images.ts check [--platform p]  run each image's tools, and compare sizes with images/budget.json
//   npx tsx scripts/images.ts build-decide [--platform p]  build the opt-in terragucci-decide image (not one of the four)
// Tags and tool versions come from packages/terragucci, the same source `init` reads.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY, TOOL_VERSIONS, decideImage, imageTag } from "../packages/terragucci/src/images";

const root = join(import.meta.dirname, "..");
const NAMES = ["tofu", "terraform", "terragrunt", "choudoufu"] as const;
type Name = (typeof NAMES)[number];

// TG_IMAGE_SUFFIX (stack/smoke.sh sets it: "-t" and 12 hex digits of this tree's
// bundle and Dockerfiles) gives a tree tags of its own, so claim runs from two
// worktrees never run each other's code under one shared tag.
const SUFFIX = process.env.TG_IMAGE_SUFFIX ?? "";
if (SUFFIX && !/^-t[0-9a-f]{12}$/.test(SUFFIX)) {
  console.error(`TG_IMAGE_SUFFIX is "-t" and 12 hex digits, not "${SUFFIX}"`);
  process.exit(2);
}
const ref = (name: Name): string => `${REGISTRY}/terragucci-${name}:${imageTag(name)}${SUFFIX}`;

/** What each image must answer, with a version it must print. */
const PROBES: Record<Name, Array<[string[], string]>> = {
  tofu: [[["tofu", "version"], TOOL_VERSIONS.tofu]],
  terraform: [[["terraform", "version"], TOOL_VERSIONS.terraform]],
  terragrunt: [
    [["terragrunt", "--version"], TOOL_VERSIONS.terragrunt],
    [["tofu", "version"], TOOL_VERSIONS.tofu],
  ],
  choudoufu: [[["choudoufu", "version"], TOOL_VERSIONS.choudoufu]],
};

/**
 * git in a checkout another user owns, both ways round: root in one uid 1001
 * owns (a github.com container job and its runner's workspace), and uid 1001
 * in one root owns. Each reads HEAD and fetches from a local remote, whose
 * upload-pack checks ownership again. Prints "git: safe" when git refused none.
 */
const FOREIGN_CHECKOUT = [
  "set -e",
  "git init -q -b main /src",
  "git -C /src -c user.name=check -c user.email=check@localhost commit -q --allow-empty -m one",
  "git clone -q /src /repo",
  "chown -R 1001:1001 /src /repo",
  "git -C /repo rev-parse -q --verify HEAD >/dev/null",
  "git -C /repo fetch -q origin",
  "chown -R 0:0 /src /repo",
  "HOME=/tmp setpriv --reuid 1001 --regid 1001 --clear-groups git -C /repo rev-parse -q --verify HEAD >/dev/null",
  "HOME=/tmp setpriv --reuid 1001 --regid 1001 --clear-groups git -C /repo ls-remote -q origin >/dev/null",
  "echo 'git: safe'",
].join(" && ");

/**
 * The image's tool as a uid with no passwd entry, with an OTLP endpoint set:
 * Go finds no user name without cgo or $USER, and tofu init then fails. Prints
 * "init: ok" when the tool ran.
 */
const UNNAMED_UID: Record<Name, string> = {
  tofu: "tofu init -input=false",
  terraform: "terraform init -input=false",
  terragrunt: "tofu init -input=false",
  choudoufu: "choudoufu version",
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
    for (const [argv, want] of [...PROBES[n], [["terragucci", "--help"], "terragucci init"], [["sh", "-c", FOREIGN_CHECKOUT], "git: safe"], [["sh", "-c", `mkdir -p /tmp/w && cd /tmp/w && ${UNNAMED_UID[n]} && echo 'init: ok'`], "init: ok"]] as Array<[string[], string]>) {
      const unnamed = argv[2]?.includes("init: ok");
      const out = spawnSync("docker", ["run", "--rm", ...plat, ...(unnamed ? ["--user", "4242:4242", "-e", "OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318"] : []), ref(n), ...argv], { encoding: "utf-8" });
      const text = `${out.stdout}${out.stderr}`;
      const ok = out.status === 0 && text.includes(want);
      if (!ok) failed = true;
      console.log(`${ok ? "ok  " : "FAIL"} ${n}: ${argv[0] === "sh" ? (unnamed ? "a tool as a uid with no passwd entry and OTLP set" : "git in a checkout another user owns") : argv.join(" ")}${ok ? "" : `\n${text}`}`);
    }
    const bytes = Number(execFileSync("docker", ["image", "inspect", "--format", "{{.Size}}", ref(n)], { encoding: "utf-8" }).trim());
    const mb = (b: number) => (b / 1e6).toFixed(0);
    const max = budget[n];
    const over = max !== undefined && bytes > max;
    if (over || max === undefined) failed = true;
    console.log(`${over || max === undefined ? "FAIL" : "ok  "} ${n}: ${mb(bytes)} MB${max === undefined ? ", no budget in images/budget.json" : ` (budget ${mb(max)} MB)`}`);
  }
  process.exit(failed ? 1 : 0);
} else if (cmd === "build-decide") {
  // terragucci-decide (terragucci#29) is opt-in: tags, build and check above
  // never name it, and images/budget.json holds no budget for it. The stack's
  // decide profile runs it as terragucci-decide:local.
  run("docker", ["buildx", "build", "--load", ...(platform ? ["--platform", platform] : []), "-f", "images/Dockerfile.decide", "-t", decideImage(), "-t", "terragucci-decide:local", "."]);
} else {
  console.error("usage: npx tsx scripts/images.ts tags|build|check|build-decide [--platform linux/amd64|linux/arm64]");
  process.exit(2);
}
