import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// docs-site/src/data/claim-areas.json gives each claim the feature area the
// coverage grids (docs-site/src/components/CoverageGrid.astro) count it under.
// The recorders rewrite smoke.json and validation.json, so the areas live in a
// file of their own, keyed by claim name. A claim added to any claim table, or
// a row recorded for one, fails here until the map names its area.
const ROOT = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

type AreaMap = { areas: string[]; claims: Record<string, string>; binary: Record<string, string>; forge: Record<string, string> };
const map = JSON.parse(read("docs-site/src/data/claim-areas.json")) as AreaMap;

/** The lines of a single-quoted shell table NAME='...'. */
function table(file: string, name: string): string[] {
  const src = read(file);
  const start = src.indexOf(`\n${name}='`);
  if (start < 0) throw new Error(`no ${name}=' in ${file}`);
  const body = src.slice(start + name.length + 3);
  return body.slice(0, body.indexOf("'")).split("\n").filter((l) => l.trim() !== "");
}

// name|says|issue in smoke.sh and smoke-gitlab.sh; forge|name|says in
// validation.sh and sandbox-github.sh.
const named = new Map<string, string>();
const add = (name: string, where: string) => { if (!named.has(name)) named.set(name, where); };
for (const l of table("stack/smoke.sh", "CLAIMS")) add(l.split("|")[0]!, "CLAIMS in stack/smoke.sh");
for (const l of table("stack/smoke-gitlab.sh", "GITLAB_CLAIMS")) add(l.split("|")[0]!, "GITLAB_CLAIMS in stack/smoke-gitlab.sh");
for (const l of table("stack/validation.sh", "CLAIMS")) add(l.split("|")[1]!, "CLAIMS in stack/validation.sh");
for (const l of table("stack/sandbox-github.sh", "PROVE_CLAIMS")) add(l.split("|")[1]!, "PROVE_CLAIMS in stack/sandbox-github.sh");
for (const f of ["docs-site/src/data/smoke.json", "docs-site/src/data/validation.json"]) {
  for (const r of (JSON.parse(read(f)) as { claims: { claim: string }[] }).claims) add(r.claim, f);
}

describe("claim-areas.json", () => {
  it("gives every claim an area", () => {
    const missing = [...named].filter(([n]) => !map.claims[n]).map(([n, where]) => `${n} (${where})`);
    expect(missing, "add each to docs-site/src/data/claim-areas.json").toEqual([]);
  });

  it("names only areas it lists", () => {
    const wrong = Object.entries(map.claims).filter(([, a]) => !map.areas.includes(a));
    expect(wrong).toEqual([]);
  });

  it("names no claim that no table or record has", () => {
    const stale = [...Object.keys(map.claims), ...Object.keys(map.binary), ...Object.keys(map.forge)].filter((n) => !named.has(n));
    expect(stale).toEqual([]);
  });

  it("gives each claim that sets its own binary that binary", () => {
    expect(Object.values(map.binary).every((b) => b === "terraform" || b === "choudoufu")).toBe(true);
    // A claim whose description sets the binary in its config runs on it.
    const says = new Map<string, string>();
    for (const l of table("stack/smoke.sh", "CLAIMS")) says.set(l.split("|")[0]!, l.split("|")[1]!);
    for (const [n, s] of says) {
      const m = /\bwith binary: (terraform|choudoufu)\b/.exec(s);
      if (m) expect(map.binary[n], n).toBe(m[1]);
      if (n.startsWith("cdf-")) expect(map.binary[n], n).toBe("choudoufu");
    }
  });
});
