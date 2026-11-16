// One ProwJob of the generated job config, with refs that point at the
// fake GitHub's repository inside the cluster, as mkpj makes one.
//
//   node prowjobs.mjs <prowjobs.jsonl> <type> <job> <name> <clone uri> <base sha> [<pull number> <pull sha> <author>]
//
// <prowjobs.jsonl> is what Prow's own loader and pjutil.NewProwJob made of
// the job config (packages/terragucci/test/fixtures/prow/check), one
// ProwJob per line with placeholder refs. This keeps everything Prow put
// in the spec (the pod spec, decoration, cluster, labels) and replaces
// only the name and the refs, so the job runs the generated YAML as
// written. Prints the ProwJob as JSON.
//
// With PROWJOB_ORIGIN set, the job's container also gets an `origin` remote
// at that address, through git's environment config (GIT_CONFIG_COUNT):
// clonerefs leaves the checkout with no remote, and the apply job reads its
// gate ledger, chant/lifecycle, from origin. The smoke test says when it
// does this; the job's script is unchanged.
import { readFileSync } from "node:fs";

const [file, type, job, name, cloneUri, baseSha, pull, pullSha, author] = process.argv.slice(2);
if (!file || !type || !job || !name || !cloneUri || !baseSha) {
  console.error("usage: node prowjobs.mjs <prowjobs.jsonl> <type> <job> <name> <clone uri> <base sha> [<pull number> <pull sha> <author>]");
  process.exit(2);
}
const all = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
const pj = all.find((j) => j.spec.type === type && j.spec.job === job);
if (!pj) {
  console.error(`no ${type} ${job} in ${file}: ${all.map((j) => `${j.spec.type} ${j.spec.job}`).join(", ")}`);
  process.exit(1);
}

const refsOf = (r) => ({
  ...r,
  base_ref: r.base_ref ?? "main",
  base_sha: baseSha,
  clone_uri: cloneUri,
  ...(pull ? { pulls: [{ number: Number(pull), author: author ?? "someone", sha: pullSha }] } : {}),
});

pj.metadata.name = name;
const origin = process.env.PROWJOB_ORIGIN;
if (origin) {
  const c = pj.spec.pod_spec.containers[0];
  c.env = [
    ...(c.env ?? []),
    { name: "GIT_CONFIG_COUNT", value: "2" },
    { name: "GIT_CONFIG_KEY_0", value: "remote.origin.url" },
    { name: "GIT_CONFIG_VALUE_0", value: origin },
    { name: "GIT_CONFIG_KEY_1", value: "remote.origin.fetch" },
    { name: "GIT_CONFIG_VALUE_1", value: "+refs/heads/*:refs/remotes/origin/*" },
  ];
}
if (pj.spec.refs) pj.spec.refs = refsOf(pj.spec.refs);
if (pj.spec.extra_refs) pj.spec.extra_refs = pj.spec.extra_refs.map((r, i) => (i === 0 ? refsOf(r) : r));
const labels = pj.metadata.labels ?? {};
if (pull) labels["prow.k8s.io/refs.pull"] = String(pull);
labels["prow-smoke/run"] = name;
pj.metadata.labels = labels;
pj.status = { state: "triggered", startTime: new Date().toISOString() };
console.log(JSON.stringify(pj));
