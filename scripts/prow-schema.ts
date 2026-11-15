// Writes the vendored copy of Prow's ProwJob spec schema the Prow job tests
// validate against (packages/terragucci/test/prow.test.ts).
//   npx tsx scripts/prow-schema.ts <prowjob_customresourcedefinition.yaml> <prow commit>
// The CRD is config/prow/cluster/prowjob-crd/ in sigs.k8s.io/prow (Apache-2.0).
// The copy keeps `spec` of the CRD's openAPIV3Schema, drops descriptions and
// formats, spells x-kubernetes-int-or-string as integer or string, and closes
// every object that lists its properties and does not preserve unknown fields:
// where the API server prunes a field the CRD does not name, the copy refuses it.
import { readFileSync, writeFileSync } from "node:fs";
import { parseYAML } from "@intentius/chant/yaml";

const [crdPath, commit] = process.argv.slice(2);
if (!crdPath || !commit) throw new Error("usage: npx tsx scripts/prow-schema.ts <crd.yaml> <prow commit>");
const OUT = "packages/terragucci/test/fixtures/prow/prowjob-spec.schema.json";

type Node = Record<string, unknown>;
const crd = parseYAML(readFileSync(crdPath, "utf8")) as Node;
const version = ((crd.spec as Node).versions as Node[])[0]!;
const spec = (((version.schema as Node).openAPIV3Schema as Node).properties as Node).spec as Node;

function tidy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(tidy);
  if (v === null || typeof v !== "object") return v;
  const n = v as Node;
  const out: Node = {};
  for (const [k, x] of Object.entries(n)) {
    if (k === "description" || k === "format" || k === "x-kubernetes-list-type" || k === "x-kubernetes-list-map-keys" || k === "x-kubernetes-map-type") continue;
    if (k === "x-kubernetes-int-or-string") continue;
    if (k === "x-kubernetes-preserve-unknown-fields") continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(x as Node).map(([p, s]) => [p, tidy(s)])) : tidy(x);
  }
  if (n["x-kubernetes-int-or-string"] === true) {
    delete out.type;
    out.anyOf = [{ type: "integer" }, { type: "string" }];
  }
  if (out.type === "object" && out.properties && n["x-kubernetes-preserve-unknown-fields"] !== true && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

const schema = {
  $comment: `ProwJob .spec from sigs.k8s.io/prow ${commit}, config/prow/cluster/prowjob-crd (Apache-2.0), written by scripts/prow-schema.ts`,
  $schema: "http://json-schema.org/draft-07/schema#",
  ...(tidy(spec) as Node),
};
writeFileSync(OUT, `${JSON.stringify(schema)}\n`);
console.log(`wrote ${OUT}`);
