// Joins the per-component `show -json` documents of one Atmos run into the one
// plan document chant's `terraform report` reads (a root whose only content is
// `module.<component>` calls). Only the report step uses this: Atmos and
// choudoufu need none of it.
//
//   node composed-plan.mjs network app edge > plan.json
//
// Each component's planfile is the stub choudoufu leaves in the component's
// directory; `choudoufu show -json` of it is that component's slice of the
// joint plan, with addresses relative to the component.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const root = "components/terraform";
const names = process.argv.slice(2);
const pre = (m, a) => (a === undefined ? a : `module.${m}${a ? "." + a : ""}`);

const out = { format_version: "1.2", resource_changes: [], output_changes: {}, configuration: { root_module: { module_calls: {} } }, prior_state: { format_version: "1.0", values: { root_module: { child_modules: [] } } } };
for (const m of names) {
  const dir = join(root, m);
  const planfile = readdirSync(dir).filter((f) => f.endsWith(".planfile")).sort()[0];
  if (!planfile) throw new Error(`no planfile in ${dir}`);
  const doc = JSON.parse(execFileSync("choudoufu", ["show", "-json", planfile], { cwd: dir, maxBuffer: 1 << 28 }).toString());
  out.terraform_version ??= doc.terraform_version;
  if (doc.errored) out.errored = true;
  for (const rc of doc.resource_changes ?? []) {
    out.resource_changes.push({ ...rc, address: pre(m, rc.address), module_address: pre(m, rc.module_address ?? ""), ...(rc.previous_address ? { previous_address: pre(m, rc.previous_address) } : {}) });
  }
  for (const [k, v] of Object.entries(doc.output_changes ?? {})) out.output_changes[`${m}__${k}`] = v;
  out.configuration.root_module.module_calls[m] = { source: `./${m}`, module: doc.configuration?.root_module ?? {} };
  const res = (doc.prior_state?.values?.root_module?.resources ?? []).map((r) => ({ ...r, address: pre(m, r.address) }));
  out.prior_state.values.root_module.child_modules.push({ address: `module.${m}`, resources: res });
}
process.stdout.write(JSON.stringify(out));
