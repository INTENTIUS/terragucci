// Holds the config and environment reference pages to the code.
//   node scripts/lint-config-docs.mjs
// Every key config.ts accepts has a row in config.md and the other way round,
// and every environment variable named in packages/terragucci/src is on
// environment.md. Exits 1 on a mismatch.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { docPage } from "./docs-pages.mjs";

const problems = [];

// ── config keys ──────────────────────────────────────────────────────────────
const config = readFileSync("packages/terragucci/src/config.ts", "utf8");
const block = config.match(/const SETTING_KEYS = new Set\(\[([\s\S]*?)\]\)/);
if (!block) throw new Error("SETTING_KEYS not found in config.ts");
const keys = new Set([...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));

const configPage = readFileSync(docPage("reference/config"), "utf8");
const keysTable = configPage.split(/^## Keys$/m)[1]?.split(/^## /m)[0] ?? "";
const rows = new Set([...keysTable.matchAll(/^\| `([a-z_]+)(?:\.[a-z_]+)?` \|/gm)].map((m) => m[1]));
for (const k of keys) if (!rows.has(k)) problems.push(`config.ts accepts \`${k}\` and the Keys table of config.md has no row for it`);
for (const k of rows) if (!keys.has(k)) problems.push(`the Keys table of config.md lists \`${k}\` and config.ts does not accept it`);

// ── environment variables ────────────────────────────────────────────────────
// Constants in the source whose names look like variables and are not, and
// variables only the binary reads that terragucci names in a message.
const NOT_VARIABLES = new Set([
  "TF_CLOUD_ORGANIZATION",
  "AWS_CLI", "AZURE_AUDIENCE", "AZURE_AUTHORITY", "AZURE_KEY_SECRET", "AZURE_VERSION", "GITHUB_CACHE_KEY", "GITHUB_COMMENT_LIMIT", "GITLAB_NOTE_LIMIT", "GITLAB_STATE", "GITLAB_GCP_TOKEN", "GITLAB_AZURE_TOKEN",
  "RUNNER_TOKEN_VARS", "TG_CACHE_DIR",
]);
const NAME = /\b(?:(?:TG|TERRAGUCCI|TOFU|TF|OTEL|AWS|ARM|AZURE|GOOGLE|GITHUB|GITLAB|FORGEJO|GITEA|CI|RUNNER|ACTIONS|ANTHROPIC)_[A-Z0-9_]*[A-Z0-9]|TRACEPARENT)\b/g;

function collect(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).sort().flatMap((e) => collect(join(path, e))).filter((f) => f.endsWith(".ts"));
}
const used = new Map();
for (const file of collect("packages/terragucci/src")) {
  for (const m of readFileSync(file, "utf8").matchAll(NAME)) {
    if (NOT_VARIABLES.has(m[0])) continue;
    // A prefix that a template literal completes, such as OTEL_EXPORTER_OTLP_${S}_HEADERS, is not a name.
    const after = readFileSync(file, "utf8")[m.index + m[0].length];
    if (after === "_" || (m[0].endsWith("OTLP") && after === "_")) continue;
    if (!used.has(m[0])) used.set(m[0], file);
  }
}
const envPage = readFileSync(docPage("reference/environment"), "utf8");
const listed = new Set(envPage.match(NAME) ?? []);
// The signal-specific OTLP variables and TF_CLI_ARGS_<command> are written as families on the pages.
for (const [name, file] of [...used].sort()) {
  if (!listed.has(name)) problems.push(`${name} is read in ${file} and is not on environment.md`);
}
for (const name of listed) {
  if (!used.has(name) && !/^(TF_CLI_ARGS|OTEL_EXPORTER_OTLP_(TRACES|METRICS)_HEADERS)$/.test(name) && !/^(OTEL_|AWS_ROLE|ARM_)/.test(name)) {
    problems.push(`${name} is on environment.md and nothing in packages/terragucci/src names it`);
  }
}

if (problems.length) {
  for (const p of problems) console.log(`FAIL ${p}`);
  process.exit(1);
}
console.log(`ok   ${keys.size} config keys, ${used.size} environment variables`);
