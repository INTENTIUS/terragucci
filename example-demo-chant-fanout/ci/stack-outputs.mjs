// Write every deployed stack's outputs, keyed by stack name, to the file named
// on the command line, the form `chant components pr-plan|pr-apply
// --seed-outputs` reads. cfn-deploy reads no stack's outputs while it plans, so
// a pull request that changes cluster-a alone would apply it with network's
// outputs unresolved; the seed is network's outputs as floci holds them. A stack
// the run applies hands its dependents its own outputs, over the seed's.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const file = process.argv[2];
if (!file) throw new Error("usage: node ci/stack-outputs.mjs <file>");
const { Stacks = [] } = JSON.parse(execFileSync("aws", ["cloudformation", "describe-stacks", "--output", "json"], { encoding: "utf8" }));
const seeds = {};
for (const s of Stacks) {
  if (!s.Outputs?.length) continue;
  seeds[s.StackName] = Object.fromEntries(s.Outputs.map((o) => [o.OutputKey, o.OutputValue]));
}
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(seeds, null, 2) + "\n");
console.error(`stack outputs: ${Object.keys(seeds).length} stacks with outputs, written to ${file}`);
