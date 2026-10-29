// Writes EVIDENCE.md at the repo root: every claim terragucci checks, what it
// checks, where it runs and its last recorded result, from the same records the
// recorders write (stack/evidence/smoke.json and validation.json) and the
// harness scenarios under stack/harness/scenarios. The docs site does not
// show any of this; EVIDENCE.md is updated with each release.
//   npx tsx scripts/evidence.ts          write EVIDENCE.md
//   npx tsx scripts/evidence.ts --check  exit 1 when EVIDENCE.md is out of date
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AREAS, LIMITS, gaps, rows, type Row, type Status } from "../stack/evidence/coverage";
import { readIndex, scenarioIds, scenarioPath } from "../stack/harness/scenarios";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "EVIDENCE.md");
const json = (f: string) => JSON.parse(readFileSync(join(ROOT, f), "utf8"));

const smoke = json("stack/evidence/smoke.json") as { recorded: string; commit: string; claims: { claim: string; says: string; verdict: string; break: string | null; forge?: string; binary?: string }[] };
const validation = json("stack/evidence/validation.json") as { recorded: Record<string, string> };

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const RESULT: Record<Status, string> = {
  proven: "proven",
  passes: "passes",
  fails: "fails",
};
const RANK: Record<Status, number> = { fails: 0, passes: 1, proven: 2 };
const BINARY: Record<string, string> = { tofu: "OpenTofu", terraform: "Terraform", choudoufu: "choudoufu" };

/** Where one row ran: the forge, and the binary when it is not OpenTofu. */
const where = (r: Row) => `${r.githubCom ? "github.com" : r.forge}${r.binary === "tofu" ? "" : ` (${BINARY[r.binary]})`}`;

const out: string[] = [];
const line = (s = "") => out.push(s);

line("# Evidence");
line();
line("What terragucci checks, how, and the last result of each check. The docs site does not carry these results. This file is updated with each release.");
line();
line("It is generated: `npx tsx scripts/evidence.ts` rewrites it from the records the validation stack writes, and `npx tsx scripts/evidence.ts --check` fails when it is out of date.");
line();
line("## How a claim is verified");
line();
line("A claim is one sentence about the pipeline, such as \"a merge request that changes one of two roots plans that root alone\". Each claim runs twice on a local stack of CI, a forge and an AWS emulator:");
line();
line("1. As written, it must pass.");
line("2. With its property broken on purpose (the BREAK run), it must fail. A claim whose BREAK run is caught is `proven`. A claim with no BREAK run only `passes`.");
line();
line("The records:");
line();
line(`- \`stack/evidence/smoke.json\`: the claims run on Forgejo with OpenTofu, and the ones also run on GitLab, Terraform and choudoufu. Recorded ${smoke.recorded} at commit ${smoke.commit}; each row carries the commit it ran at.`);
line(`- \`stack/evidence/validation.json\`: the per-forge claims. Recorded ${Object.entries(validation.recorded).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
line("- `stack/evidence/claim-areas.json`: the feature area of each claim, and the forge or binary a claim's own config sets.");
line();
line("| Forge | What runs |");
line("|---|---|");
line("| Forgejo | a Forgejo server and its runner |");
line("| GitHub | the generated workflow, run by `act` against a mock GitHub API |");
line("| github.com | the published release's generated workflow on GitHub-hosted runners, in a public plan-only repo |");
line("| GitLab | GitLab CE and its runner |");
line();
line("The Terraform and choudoufu results are the core claims run again on that binary in its CI image. They use `binary:` in each repo's `terragucci.yml`, on a copy of the repo written for the binary.");
line();
line("Run them with `just claims <name>`, `just claims-affected` and `just coverage-fill`; CONTRIBUTING.md has the details.");
line();
line("### Limits of the github.com claims");
line();
line("Every resource there is a `terraform_data`, so nothing needs a cloud account.");
line();
line("| Limit | What runs instead |");
line("|---|---|");
line("| no cloud role | `oidc/job` checks each job's token against GitHub's published keys, its repo, run, audience and role, and trades it with nothing; the trade with STS is proven on Forgejo |");
line("| no bucket | `report/keys`, `report/oidc` and `estate/job` write to floci, the AWS emulator, run in the job beside a stand-in for STS |");
line("| one GitHub account | the refusals of a commenter with no write access and of a pull request from a fork are proven on Forgejo |");
line("| no model key | the agent comment and the refused-wave job run a stand-in agent |");
line("| BREAK for the locking and report claims alone | the other github.com claims have no BREAK run, so they read `passes` |");
line();

// Claims by area.
line("## Claims by feature area");
line();
line("One row per claim. The result is the weakest of its runs. Where it runs lists every forge (and non-OpenTofu binary) the claim has a recorded run on.");
line();
for (const area of AREAS) {
  const byClaim = new Map<string, Row[]>();
  for (const r of rows.filter((x) => x.area === area)) byClaim.set(r.claim, [...(byClaim.get(r.claim) ?? []), r]);
  line(`### ${area}`);
  line();
  line(`${byClaim.size} claims.`);
  line();
  line("| Claim | What it checks | Where it runs | Result |");
  line("|---|---|---|---|");
  for (const [claim, rs] of [...byClaim].sort(([a], [b]) => a.localeCompare(b))) {
    const weakest = rs.map((r) => r.status).reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
    const runs = [...new Set(rs.map(where))];
    line(`| \`${claim}\` | ${cell(rs[0]!.says)} | ${runs.join(", ")} | ${RESULT[weakest]} |`);
  }
  line();
}

// Rows the tables above leave out.
const shown = new Set(rows.map((r) => r.claim));
const other = smoke.claims.filter((c) => !shown.has(c.claim));
if (other.length) {
  line("### Recorded but not in a feature area");
  line();
  line("| Claim | What it checks | Result |");
  line("|---|---|---|");
  for (const c of other) line(`| \`${c.claim}\` | ${cell(c.says)} | ${c.verdict === "pass" ? (c.break === "caught" ? "proven" : "passes") : c.verdict === "pending" ? "not run yet" : "fails"} |`);
  line();
}

// Gaps.
const list = gaps();
line("## Not yet proven");
line();
line(`${list.length} ${list.length === 1 ? "cell" : "cells"} of the feature-area grids (feature area by tool, and by forge) have no proven claim. "same code" means the area runs the same code on that binary as on OpenTofu and has no claim of its own there.`);
line();
line("| Tool or forge | Feature area | Now |");
line("|---|---|---|");
const WORD: Record<string, string> = { none: "none", same: "same code", passes: "passes", fails: "fails" };
for (const g of list) line(`| ${g.column} | ${g.area} | ${WORD[g.state] ?? g.state} |`);
line();
line("`npx tsx scripts/coverage-gaps.ts` prints the same list with what fills each cell.");
line();

line("## Refused by design");
line();
line("| Tool or forge | Feature area | What is refused |");
line("|---|---|---|");
for (const l of LIMITS) line(`| ${l.column} | ${l.area} | ${cell(l.text)} |`);
line();

// Harness scenarios.
const index = readIndex();
const recorded = new Map(smoke.claims.map((c) => [c.claim, c]));
line("## Harness scenarios");
line();
line("Longer runs on the same stack, driven by chant's e2e harness: each is a file under `stack/harness/scenarios/<id>/scenario.json` that opens pull requests, merges, kills jobs and checks the forge, then runs again with its property broken. `npx tsx stack/harness/harness.ts lint` checks the files. Results are recorded as claim rows when `stack/harness/harness.ts run <id> --record` runs; a scenario with no row has not been recorded yet.");
line();
line("| Scenario | Claim | Binary | What it checks | Result |");
line("|---|---|---|---|---|");
for (const id of scenarioIds()) {
  const file = scenarioPath(id);
  if (!existsSync(file)) continue;
  const s = JSON.parse(readFileSync(file, "utf8")) as { claim?: string; title?: string };
  const row = s.claim ? recorded.get(s.claim) : undefined;
  const result = !row ? "not recorded" : row.verdict === "pass" ? (row.break === "caught" ? "proven" : "passes") : "fails";
  line(`| \`${id}\` | ${s.claim ? `\`${s.claim}\`` : ""} | ${BINARY[index[id]?.binary ?? "tofu"]} | ${cell(s.title ?? "")} | ${result} |`);
}
line();

const text = `${out.join("\n").replace(/\n+$/, "")}\n`;
if (process.argv.includes("--check")) {
  if (!existsSync(OUT) || readFileSync(OUT, "utf8") !== text) {
    console.error("EVIDENCE.md is out of date; run: npx tsx scripts/evidence.ts");
    process.exit(1);
  }
  console.log("EVIDENCE.md is current");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote EVIDENCE.md (${rows.length} recorded runs, ${out.length} lines)`);
}
