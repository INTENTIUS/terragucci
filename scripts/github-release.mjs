// Create a release's GitHub release on its existing tag, with its notes from
// the "## In <version>" section of the Changes page
// (docs-site/src/content/docs/reference/whats-new.mdx). The tag must already
// be on GitHub (--verify-tag): this never creates or moves a tag. A version
// whose release exists is left as it is.
//
//   node scripts/github-release.mjs <version>...    create each one's release; the newest named is marked latest
//   node scripts/github-release.mjs --dry-run <version>...   print each release's notes and create nothing
//
// The release path runs it after the publish workflow (CONTRIBUTING.md,
// Releasing), as `just github-release <version>`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const DOCS = "https://intentius.io";
const REPO = "INTENTIUS/terragucci";

/** The "## In <version>" section of the Changes page, its links made absolute. */
export function releaseNotes(page, version) {
  const lines = page.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## In ${version}`);
  if (start < 0) throw new Error(`the Changes page has no "## In ${version}" section`);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").trim();
  if (!body) throw new Error(`the Changes page's "## In ${version}" section is empty`);
  const notes = body.replace(/\]\((\/terragucci\/[^)]*)\)/g, (_, path) => `](${DOCS}${path})`);
  return [
    `\`@intentius/terragucci@${version}\` on npm. Upgrade each repo with \`npx @intentius/terragucci@${version} init\`, then merge the pipeline it writes.`,
    "",
    notes,
    "",
    `The [Changes page](${DOCS}/terragucci/reference/whats-new/) lists every release.`,
  ].join("\n") + "\n";
}

/** Versions oldest first, by their numbers. */
export function byVersion(versions) {
  const key = (v) => v.split(".").map(Number);
  return [...versions].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  });
}

const gh = (args, input) => spawnSync("gh", args, { encoding: "utf8", input });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const versions = byVersion(args.filter((a) => a !== "--dry-run").map((v) => v.replace(/^v/, "")));
  if (versions.length === 0) {
    console.error("usage: node scripts/github-release.mjs [--dry-run] <version>...");
    process.exit(2);
  }
  const page = readFileSync(join(root, "docs-site", "src", "content", "docs", "reference", "whats-new.mdx"), "utf8");
  const newest = versions.at(-1);
  let created = 0;
  for (const v of versions) {
    const notes = releaseNotes(page, v);
    if (dry) {
      console.log(`=== v${v}${v === newest ? " (latest)" : ""}\n${notes}`);
      continue;
    }
    if (gh(["release", "view", `v${v}`, "-R", REPO, "--json", "tagName"]).status === 0) {
      console.log(`v${v}: its GitHub release exists; left as it is`);
      continue;
    }
    const r = gh(["release", "create", `v${v}`, "-R", REPO, "--verify-tag", "--title", v, `--latest=${v === newest}`, "--notes-file", "-"], notes);
    if (r.status !== 0) {
      console.error(`v${v}: ${r.stderr.trim()}`);
      process.exit(1);
    }
    created++;
    console.log(`v${v}: ${r.stdout.trim()}`);
  }
  if (!dry) console.log(`${created} release${created === 1 ? "" : "s"} created`);
}
