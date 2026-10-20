// Publish the demo cycle that just wrote reset as its tool's latest, for
// behold's per-tool page: <prefix>/cycles/<tool>/<cycle>.json and
// <prefix>/cycles/<tool>/latest.json (the format is in scripts/demo-cycles-lib.ts
// and at the top of stack/demo.sh), then delete the tool's older cycles past
// the newest 5. The base, and a cycle that stalled at any step, publish nothing.
//
// Everything comes from the environment the driver sets:
//   DEMO_CYCLES_TIMELINE                    the cycle's timeline: demo.json as each step wrote it, with at, one a line
//   DEMO_CYCLES_MARKS                       the runs copy's marks.jsonl, for the ids of the cycle's runs
//   DEMO_CYCLES_BUCKET_URL, DEMO_CYCLES_PREFIX   the reports bucket's URL in floci, and the prefix
//   DEMO_CYCLES_TOOL, DEMO_CYCLES_REPO      the tool the cycle showed, and its forge repo
//   DEMO_CYCLES_CYCLE, DEMO_CYCLES_SCENARIO the cycle and its scenario
//
// Exits 1 when a write fails; the driver logs that and goes on.
import { readFileSync } from "node:fs";
import { buildCycle, cycleKeys, cyclesToPrune, readTimeline } from "./demo-cycles-lib";
import { readMarks } from "./demo-runs-lib";

const env = (k: string, def?: string): string => {
  const v = process.env[k] ?? def;
  if (v === undefined || v === "") throw new Error(`${k} is not set`);
  return v;
};

const TIMEOUT = 10_000;
setTimeout(() => {
  console.error("cycles: the publish took over 30s; stopped");
  process.exit(1);
}, 30_000).unref();

const readText = (p: string): string => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

async function main(): Promise<void> {
  const bucket = env("DEMO_CYCLES_BUCKET_URL").replace(/\/+$/, "");
  const prefix = env("DEMO_CYCLES_PREFIX", "demo");
  const tool = env("DEMO_CYCLES_TOOL");
  const cycle = Number(env("DEMO_CYCLES_CYCLE"));
  const built = buildCycle({
    tool,
    repo: env("DEMO_CYCLES_REPO"),
    scenario: process.env.DEMO_CYCLES_SCENARIO ?? "",
    cycle,
    steps: readTimeline(readText(env("DEMO_CYCLES_TIMELINE"))),
    marks: readMarks(readText(process.env.DEMO_CYCLES_MARKS ?? "")),
  });
  if ("skip" in built) {
    console.error(`cycles: nothing published: ${built.skip}`);
    return;
  }
  const body = JSON.stringify(built.doc);
  const put = async (key: string) => {
    const res = await fetch(`${bucket}/${prefix}/${key}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`PUT ${key}: ${res.status}`);
  };
  // The cycle's own record first, so latest never names a cycle that is not stored.
  await put(`cycles/${tool}/${cycle}.json`);
  await put(`cycles/${tool}/latest.json`);
  console.error(`cycles: published cycle ${cycle} as ${tool}'s latest`);

  let stored: number[] = [cycle];
  const res = await fetch(`${bucket}?list-type=2&prefix=${encodeURIComponent(`${prefix}/cycles/${tool}/`)}`, { signal: AbortSignal.timeout(TIMEOUT) });
  if (res.ok) stored = stored.concat(cycleKeys(await res.text(), prefix, tool));
  for (const n of cyclesToPrune(stored)) {
    const del = await fetch(`${bucket}/${prefix}/cycles/${tool}/${n}.json`, { method: "DELETE", signal: AbortSignal.timeout(TIMEOUT) });
    if (!del.ok && del.status !== 404) console.error(`cycles: could not delete cycle ${n} of ${tool}: ${del.status}`);
  }
}

main().catch((e: Error) => {
  console.error(`cycles: ${e.message}`);
  process.exit(1);
});
