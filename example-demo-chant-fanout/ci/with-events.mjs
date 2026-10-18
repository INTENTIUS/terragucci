// Run a chant pull-request stage with --events-json, and keep its events where
// a viewer outside CI reads them: every few seconds while it runs, and once
// more when it ends, the stream goes to
//
//   <CHANT_EVENTS_URL>/<pull request>/<commit>/events.jsonl
//
// with the stage's pr-<stage>.json and change-set.json beside it at the end.
// That is the layout chant#4007's --report-url writes; once the pin is chant
// 0.124.29, the pipeline passes --report-url instead and this goes.
//
//   node ci/with-events.mjs <plan|apply> -- chant components pr-<stage> ... --events-json
//
// CHANT_EVENTS_URL is s3://<bucket>/<prefix>, written to AWS_ENDPOINT_URL
// (the stack's floci) path-style, unsigned, as stack/demo.sh writes demo.json.
// The plan names its pull request (PR_NUMBER) and commit (HEAD_SHA); the
// apply's commit is GITHUB_SHA, and its pull request is the one Forgejo says
// merged it. A copy that fails is logged and never fails the stage: the
// stage's exit code is the command's.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";

const [stage, dashes, ...command] = process.argv.slice(2);
if (!["plan", "apply"].includes(stage) || dashes !== "--" || command.length === 0) {
  console.error("usage: node ci/with-events.mjs <plan|apply> -- <command...>");
  process.exit(2);
}
const OUT = ".chant/pr";
const EVERY_MS = 3000;
mkdirSync(OUT, { recursive: true });

const base = (() => {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(process.env.CHANT_EVENTS_URL ?? "");
  const endpoint = (process.env.AWS_ENDPOINT_URL ?? "").replace(/\/$/, "");
  if (!m || !endpoint) return undefined;
  return `${endpoint}/${m[1]}${m[2] ? `/${m[2].replace(/\/$/, "")}` : ""}`;
})();

async function pullRequest() {
  if (stage === "plan") return process.env.PR_NUMBER;
  const url = `${process.env.GITHUB_SERVER_URL}/api/v1/repos/${process.env.GITHUB_REPOSITORY}/commits/${process.env.GITHUB_SHA}/pull`;
  try {
    const r = await fetch(url, { headers: { authorization: `token ${process.env.GITHUB_TOKEN}` } });
    if (!r.ok) throw new Error(`answered ${r.status}`);
    return String((await r.json()).number);
  } catch (e) {
    console.error(`events: no pull request found for ${process.env.GITHUB_SHA} (${e.message}); the events stay in the report artifact`);
    return undefined;
  }
}

const commit = stage === "plan" ? process.env.HEAD_SHA : process.env.GITHUB_SHA;
const pr = base ? await pullRequest() : undefined;
const at = base && pr && commit ? `${base}/${pr}/${commit}` : undefined;
if (!base) console.error("events: CHANT_EVENTS_URL or AWS_ENDPOINT_URL is not set; the events stay in the report artifact");
else if (at) console.error(`events: copied to ${at}/events.jsonl as the stage runs`);

let sent = -1;
async function put(name, type) {
  const file = `${OUT}/${name}`;
  if (!at || !existsSync(file)) return;
  const body = readFileSync(file);
  if (name === "events.jsonl" && body.length === sent) return;
  try {
    const r = await fetch(`${at}/${name}`, { method: "PUT", headers: { "content-type": type }, body });
    if (!r.ok) throw new Error(`answered ${r.status}`);
    if (name === "events.jsonl") sent = body.length;
  } catch (e) {
    console.error(`events: could not copy ${name} (${e.message})`);
  }
}

const events = createWriteStream(`${OUT}/events.jsonl`);
const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "inherit"] });
child.stdout.pipe(events);
let copying = Promise.resolve();
const timer = setInterval(() => {
  copying = copying.then(() => put("events.jsonl", "application/x-ndjson"));
}, EVERY_MS);

const code = await new Promise((done) => {
  child.on("error", (e) => {
    console.error(`events: ${command[0]} did not start (${e.message})`);
    done(1);
  });
  child.on("close", (c, signal) => done(c ?? (signal ? 1 : 0)));
});
clearInterval(timer);
await new Promise((done) => events.end(done));
await copying;
await put("events.jsonl", "application/x-ndjson");
await put(`pr-${stage}.json`, "application/json");
await put("change-set.json", "application/json");
process.exit(code);
