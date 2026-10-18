// The demo's operator and the pipeline's apply of app-01, started together
// (stack/demo.sh, fan-out-choudoufu). Each side marks when it is ready, when
// its apply starts and when it ends, as objects under TG_DEMO_OPERATOR_MARKERS
// (the reports bucket in floci, path-style, unsigned), keyed by the cycle the
// driver names in <markers>/expected before it merges the fix:
//
//   node ci/operator-gate.mjs pipeline-before   app-01's before-apply step: marks pipeline-ready, waits up to
//                                               60 s for operator-applying, then marks pipeline-applying
//   node ci/operator-gate.mjs pipeline-after    app-01's after-apply step: marks pipeline-applied
//   node ci/operator-gate.mjs operator-before   the operator, before its apply: waits up to 300 s for
//                                               pipeline-ready, then marks operator-applying
//   node ci/operator-gate.mjs operator-after    the operator, after its apply: marks operator-applied
//
// With no expected cycle, or a cycle whose operator already applied, nothing
// waits. A wait that runs out goes on: it never fails the apply.
const [what] = process.argv.slice(2);
const base = (process.env.TG_DEMO_OPERATOR_MARKERS ?? "").replace(/\/$/, "");
if (!base) process.exit(0);

const get = async (key) => {
  try {
    const r = await fetch(`${base}/${key}`);
    return r.ok ? (await r.text()).trim() : undefined;
  } catch {
    return undefined;
  }
};
const put = async (key, body) => {
  try {
    await fetch(`${base}/${key}`, { method: "PUT", headers: { "content-type": "text/plain" }, body });
  } catch (e) {
    console.error(`operator-gate: could not mark ${key} (${e.message})`);
  }
};
const until = async (key, seconds) => {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (await get(key)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};
const now = () => new Date().toISOString();

const cycle = await get("expected");
if (!cycle) process.exit(0);
const at = (name) => `${cycle}/${name}`;

switch (what) {
  case "pipeline-before":
    if (await get(at("pipeline-applied"))) break;
    await put(at("pipeline-ready"), now());
    console.error(`operator-gate: cycle ${cycle}: app-01 waits for the operator's apply to start`);
    if (!(await until(at("operator-applying"), 60))) console.error("operator-gate: no operator apply started within 60 s; app-01 applies alone");
    await put(at("pipeline-applying"), now());
    break;
  case "pipeline-after":
    await put(at("pipeline-applied"), now());
    break;
  case "operator-before":
    if (!(await until(at("pipeline-ready"), 300))) console.error("operator-gate: the pipeline's app-01 was not ready within 300 s; the operator applies alone");
    await put(at("operator-applying"), now());
    break;
  case "operator-after":
    await put(at("operator-applied"), now());
    break;
  default:
    console.error("usage: node ci/operator-gate.mjs pipeline-before|pipeline-after|operator-before|operator-after");
    process.exit(2);
}
