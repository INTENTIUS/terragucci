// Ask a running terragucci-decide the three typed-decision uses' questions
// (terragucci#30, #31, #32) through terragucci's own client, and check that it
// answers on CPU as the pinned model (terragucci#29).
//   npx tsx scripts/decide-ask.ts [http://localhost:8790]
// stack/decide.sh ask runs it. The states are stack/fixtures/decide/*.json.
// Each line prints the decision and the answer the fixture expects; the run
// fails when the service is not on CPU, answers as another model, or gives no
// usable answer. A judgment that differs from the expected one is printed, not
// failed: the uses' own claims decide what a wrong answer costs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decide, summarize } from "../packages/terragucci/src/decide";
import { QUESTIONS } from "../packages/terragucci/src/decide/questions";
import { LAYA_MODEL } from "../packages/terragucci/src/images";

const url = (process.argv[2] ?? "http://localhost:8790").replace(/\/+$/, "");
const dir = join(import.meta.dirname, "../stack/fixtures/decide");
let failed = false;
const fail = (why: string): void => {
  failed = true;
  console.log(`FAIL ${why}`);
};

const health = (await (await fetch(`${url}/health`)).json()) as { loaded?: string[]; checkpoint_devices?: Record<string, string>; revisions?: Record<string, string> };
const devices = Object.entries(health.checkpoint_devices ?? {});
if (devices.length === 0) fail(`${url}/health lists no loaded checkpoint`);
for (const [name, device] of devices) {
  if (device === "cpu") console.log(`ok   ${name} runs on cpu at revision ${health.revisions?.[name] ?? "unknown"}`);
  else fail(`${name} runs on ${device}, not cpu`);
}
const models = (await (await fetch(`${url}/v1/models`)).json()) as { data?: Array<{ id: string }> };
const served = models.data?.map((m) => m.id) ?? [];
if (served.length === 1 && served[0] === LAYA_MODEL) console.log(`ok   serves ${LAYA_MODEL}`);
else fail(`serves ${served.join(", ") || "nothing"}, not ${LAYA_MODEL}`);

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const f = JSON.parse(readFileSync(join(dir, file), "utf-8")) as { use: string; question: keyof typeof QUESTIONS; expect: string; state: Record<string, unknown> };
  const r = await decide({ backend: "laya", url }, f.state, { [f.question]: QUESTIONS[f.question] }, { timeoutMs: 120_000 });
  const d = r.decisions[f.question];
  const line = `${file}: ${f.use}\n     ${summarize(d, r)} in ${r.ms ?? 0} ms; expected ${f.expect}${d.answer === f.expect ? "" : " (differs)"}`;
  if (d.status === "unavailable") fail(line);
  else console.log(`ok   ${line}`);
}
process.exit(failed ? 1 : 0);
