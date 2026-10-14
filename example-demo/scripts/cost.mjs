// A cost stub for the demo: no pricing service, no key. It prices each
// terraform_data in a root's plan from the fixed table below and prints the
// fields terragucci reads from Infracost's JSON (cost.command in
// terragucci.yml; docs-site/src/content/docs/guides/estimate-cost.mdx):
//
//   { "currency": "USD", "pastTotalMonthlyCost": "25.00",
//     "totalMonthlyCost": "27.50", "diffTotalMonthlyCost": "2.50" }
//
// The figures are made up. The plan note names the estimator after the
// command's first word, so terragucci.yml runs this through scripts/cost-stub
// and the note reads "from cost-stub".
//
// It reads the plan (`show -json`) from the file TG_PLAN_JSON names, else
// from stdin, and the root from TG_ROOT.
import { readFileSync } from "node:fs";

// Monthly price of each terraform_data, by root and resource name. One the
// table does not name costs DEFAULT_PRICE.
const PRICES = {
  "network/terraform_data.http_proxy_port": 12.0,
  "network/terraform_data.release": 1.0,
  "app/terraform_data.listener_port": 20.0,
  "app/terraform_data.migration": 2.5,
  "edge/terraform_data.upstream": 8.0,
  "other/terraform_data.backup_schedule": 4.0,
};
const DEFAULT_PRICE = 1.0;

const file = process.env.TG_PLAN_JSON;
const plan = JSON.parse(readFileSync(file ? file : 0, "utf-8"));
const root = (process.env.TG_ROOT ?? "").replace(/^\.\/|\/+$/g, "");

let before = 0;
let after = 0;
for (const rc of plan.resource_changes ?? []) {
  if (rc.mode !== "managed" || rc.type !== "terraform_data") continue;
  const price = PRICES[`${root}/${rc.type}.${rc.name}`] ?? DEFAULT_PRICE;
  const actions = rc.change?.actions ?? [];
  // A create did not exist before, a delete does not exist after; no-op,
  // update and a replace exist on both sides.
  const created = actions.length === 1 && actions[0] === "create";
  const deleted = actions.length === 1 && actions[0] === "delete";
  if (!created) before += price;
  if (!deleted) after += price;
}

const money = (n) => n.toFixed(2);
process.stdout.write(
  JSON.stringify({
    currency: "USD",
    pastTotalMonthlyCost: money(before),
    totalMonthlyCost: money(after),
    diffTotalMonthlyCost: money(after - before),
  }) + "\n",
);
