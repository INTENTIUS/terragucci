// The CI images (terragucci#19): build them, prove each one works, and hold
// each to its size budget. There are four images in each of two sets, Debian and Chainguard
// (`tofu` and `tofu-chainguard`, the names images/budget.json and chant.config.ts use); --base
// debian or --base chainguard limits a command to one set.
//   npx tsx scripts/images.ts tags [--base b]                 print each image's name and reference
//   npx tsx scripts/images.ts build [--platform p] [--base b]  build the images for one platform, into the local daemon
//   npx tsx scripts/images.ts check [--platform p] [--base b]  run each image's tools, and compare sizes with images/budget.json
//   npx tsx scripts/images.ts build-decide [--platform p]  build the opt-in terragucci-decide image (not one of the eight)
// Tags and tool versions come from packages/terragucci, the same source `init` reads.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../packages/terragucci/package.json" with { type: "json" };
import { IMAGE_BASES, REGISTRY, TOOL_VERSIONS, decideImage, imageTag, releaseImageName, type ImageBase } from "../packages/terragucci/src/images";

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
const ref = (name: Name, base: ImageBase = "debian"): string => `${REGISTRY}/terragucci-${name}:${imageTag(name, undefined, base)}${SUFFIX}`;

/** The Dockerfile an image is built from: images/Dockerfile.tofu, and images/Dockerfile.tofuChainguard for the Chainguard set. */
const dockerfile = (name: Name, base: ImageBase): string => `images/Dockerfile.${name}${base === "chainguard" ? "Chainguard" : ""}`;

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
 * The chant a wave job runs: the image's `chant` on the path. Prints the
 * version it runs, which must be the one the package pins. The bundle imports
 * the chant package installed beside it, so that one is checked too.
 */
const CHANT_BIN = "command -v chant >/dev/null && node -p 'require(\"/usr/local/node_modules/@intentius/chant/package.json\").version' && chant --version";

/**
 * git in a checkout another user owns, both ways round: root in one uid 1001
 * owns (a github.com container job and its runner's workspace), and uid 1001
 * in one root owns. The probe runs as root in both sets: the Chainguard set's own
 * user is 65532, which cannot chown. Each reads HEAD and fetches from a local remote, whose
 * upload-pack checks ownership again. Prints "git: safe" when git refused none.
 */
const asUid1001 = (base: ImageBase, argv: string): string =>
  base === "chainguard"
    // The Chainguard set carries no setpriv, so node drops to uid 1001 before it runs git.
    ? `HOME=/tmp node -e 'process.setgid(1001);process.setuid(1001);process.exit(require("child_process").spawnSync(process.argv[1],process.argv.slice(2),{stdio:"inherit"}).status)' ${argv}`
    : `HOME=/tmp setpriv --reuid 1001 --regid 1001 --clear-groups ${argv}`;
const foreignCheckout = (base: ImageBase): string =>
  [
    "set -e",
    "git init -q -b main /src",
    "git -C /src -c user.name=check -c user.email=check@localhost commit -q --allow-empty -m one",
    "git clone -q /src /repo",
    "chown -R 1001:1001 /src /repo",
    "git -C /repo rev-parse -q --verify HEAD >/dev/null",
    "git -C /repo fetch -q origin",
    "chown -R 0:0 /src /repo",
    asUid1001(base, "git -C /repo rev-parse -q --verify HEAD >/dev/null"),
    asUid1001(base, "git -C /repo ls-remote -q origin >/dev/null"),
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
const baseArg = args.includes("--base") ? args[args.indexOf("--base") + 1] : undefined;
if (baseArg !== undefined && !(IMAGE_BASES as readonly string[]).includes(baseArg)) {
  console.error(`--base is ${IMAGE_BASES.join(" or ")}, not "${baseArg}"`);
  process.exit(2);
}
const BASES: readonly ImageBase[] = baseArg ? [baseArg as ImageBase] : IMAGE_BASES;

function run(bin: string, argv: string[]): void {
  execFileSync(bin, argv, { cwd: root, stdio: "inherit" });
}

// A build outside a release labels each image with the committed version; a release's build gets its label from chant.
// CHANT_RELEASE_LABEL is RELEASE_LABEL_ARG in images/images.ts, the argument chant passes a release's build.
const versionArg = ["--build-arg", `CHANT_RELEASE_LABEL=${pkg.version}`];

if (cmd === "tags") {
  for (const b of BASES) for (const n of NAMES) console.log(`${releaseImageName(n, b)} ${ref(n, b)}`);
} else if (cmd === "build") {
  if (!existsSync(join(root, "packages/terragucci/dist/terragucci.mjs"))) {
    console.error("packages/terragucci/dist/terragucci.mjs is missing; run just build-cli first");
    process.exit(2);
  }
  for (const b of BASES) {
    for (const n of NAMES) {
      run("docker", ["buildx", "build", "--load", ...(platform ? ["--platform", platform] : []), ...versionArg, "-f", dockerfile(n, b), "-t", ref(n, b), "."]);
    }
  }
} else if (cmd === "check") {
  const budget = JSON.parse(readFileSync(join(root, "images/budget.json"), "utf-8")) as Record<string, number>;
  let failed = false;
  for (const b of BASES) {
    for (const n of NAMES) {
      const plat = platform ? ["--platform", platform] : [];
      const name = releaseImageName(n, b);
      // The set's final user: root on Debian, 65532 on Chainguard (chant's CI_IMAGE_CHAINGUARD_USER).
      const finalUser = b === "chainguard" ? "65532" : "0";
      const probes = [
        ...PROBES[n],
        [["terragucci", "--help"], "terragucci init"],
        [["sh", "-c", CHANT_BIN], pkg.dependencies["@intentius/chant"]],
        [["sh", "-c", "echo \"user: $(id -u)\""], `user: ${finalUser}`],
        [["sh", "-c", foreignCheckout(b)], "git: safe"],
        [["sh", "-c", `mkdir -p /tmp/w && cd /tmp/w && ${UNNAMED_UID[n]} && echo 'init: ok'`], "init: ok"],
      ] as Array<[string[], string]>;
      for (const [argv, want] of probes) {
        const unnamed = argv[2]?.includes("init: ok");
        // The foreign-checkout probe chowns, which the Chainguard set's own user cannot, so it runs as root there as it does on Debian.
        const foreign = argv[2] === foreignCheckout(b);
        const user = unnamed ? ["--user", "4242:4242", "-e", "OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318"] : foreign ? ["--user", "root"] : [];
        const out = spawnSync("docker", ["run", "--rm", ...plat, ...user, ref(n, b), ...argv], { encoding: "utf-8" });
        const text = `${out.stdout}${out.stderr}`;
        const ok = out.status === 0 && text.includes(want);
        if (!ok) failed = true;
        const what = argv[0] !== "sh" ? argv.join(" ") : unnamed ? "a tool as a uid with no passwd entry and OTLP set" : foreign ? "git in a checkout another user owns" : argv[2] === CHANT_BIN ? "the chant bin a wave job runs" : "the image's final user";
        console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${what}${ok ? "" : `\n${text}`}`);
      }
      const bytes = Number(execFileSync("docker", ["image", "inspect", "--format", "{{.Size}}", ref(n, b)], { encoding: "utf-8" }).trim());
      const mb = (x: number) => (x / 1e6).toFixed(0);
      const max = budget[name];
      const over = max !== undefined && bytes > max;
      if (over || max === undefined) failed = true;
      console.log(`${over || max === undefined ? "FAIL" : "ok  "} ${name}: ${mb(bytes)} MB${max === undefined ? ", no budget in images/budget.json" : ` (budget ${mb(max)} MB)`}`);
    }
  }
  process.exit(failed ? 1 : 0);
} else if (cmd === "build-decide") {
  // terragucci-decide (terragucci#29) is opt-in: tags, build and check above
  // never name it, and images/budget.json holds no budget for it. The stack's
  // decide profile runs it as terragucci-decide:local.
  run("docker", ["buildx", "build", "--load", ...(platform ? ["--platform", platform] : []), ...versionArg, "-f", "images/Dockerfile.decide", "-t", decideImage(), "-t", "terragucci-decide:local", "."]);
} else {
  console.error("usage: npx tsx scripts/images.ts tags|build|check|build-decide [--platform linux/amd64|linux/arm64] [--base debian|chainguard]");
  process.exit(2);
}
