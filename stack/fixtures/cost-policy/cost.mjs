// A cost estimator with no account: 10.00 a month for each resource the plan
// creates, printed as Infracost's JSON.
import { readFileSync } from "node:fs";
const plan = JSON.parse(readFileSync(process.env.TG_PLAN_JSON, "utf-8"));
const created = (plan.resource_changes ?? []).filter((r) => (r.change?.actions ?? []).includes("create")).length;
const cost = (created * 10).toFixed(2);
process.stdout.write(JSON.stringify({ version: "0.2", currency: "USD", totalMonthlyCost: cost, pastTotalMonthlyCost: "0", diffTotalMonthlyCost: cost, projects: [] }));
