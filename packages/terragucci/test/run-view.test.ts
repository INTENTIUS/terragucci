import { describe, expect, it } from "vitest";
import { waveReads, waveState } from "../src/apply";
import { StoreConflict, type ObjectStore, type StoreCondition } from "../src/report/object-store";
import { renderRunHtml, RUN_SCHEMA, runSkeleton, runViewKey, updateRunView, withWave, type RunView } from "../src/report/run-view";
import { unitEdges } from "../src/terragrunt";
import { tmp, write } from "./helpers";

const backend = (key: string): string => `terraform {\n  backend "s3" {\n    bucket = "s"\n    key    = "${key}"\n  }\n}\n`;
const reads = (name: string, key: string): string => `data "terraform_remote_state" "${name}" {\n  backend = "s3"\n  config = {\n    bucket = "s"\n    key    = "${key}"\n  }\n}\n`;

/** An in-memory bucket with ETags, as the stores' conditional writes see one. */
function memoryStore(): ObjectStore & { objects: Map<string, { body: string; etag: string }> } {
  const objects = new Map<string, { body: string; etag: string }>();
  let n = 0;
  return {
    location: "s3://mem",
    objects,
    async put(key: string, body: string | Uint8Array, _type: string, when?: StoreCondition) {
      const cur = objects.get(key);
      if (when && "ifNoneMatch" in when && cur) throw new StoreConflict("exists");
      if (when && "ifMatch" in when && cur?.etag !== when.ifMatch) throw new StoreConflict("moved");
      const etag = `e${++n}`;
      objects.set(key, { body: typeof body === "string" ? body : Buffer.from(body).toString(), etag });
      return { etag };
    },
    async read(key: string) {
      const o = objects.get(key);
      return o ? { body: o.body, etag: o.etag } : {};
    },
    async get(key: string) {
      return objects.get(key)?.body;
    },
    async presign() {
      return { url: "", expires: new Date(0) };
    },
  };
}

const waves = [["net"], ["app", "web"]];
const deps = new Map([["app", new Set(["net"])], ["web", new Set<string>()], ["net", new Set<string>()]]);

describe("the run view", () => {
  it("starts from every wave, the roots in each and what they read, none started", () => {
    const v = runSkeleton("forge/acme/infra", "abc", waves, deps);
    expect(v.roots).toEqual([
      { root: "net", wave: 1, reads: [] },
      { root: "app", wave: 2, reads: ["net"] },
      { root: "web", wave: 2, reads: [] },
    ]);
    expect(v.waves).toEqual([
      { number: 1, roots: ["net"], reads: [], state: "not-started", gate: "wave-1" },
      { number: 2, roots: ["app", "web"], reads: [1], state: "not-started", gate: "wave-2" },
    ]);
    expect(runViewKey("forge/acme/infra", "abc", "/reports/")).toBe("reports/forge/acme/infra/runs/abc");
  });

  it("a Terragrunt repo's units read the units their dependency blocks name, and the blast radius follows them", () => {
    const units = [
      { path: "live/vpc", dependencies: [] },
      { path: "live/app", dependencies: ["live/vpc"] },
      { path: "live/web", dependencies: ["live/app", "outside/dns"] },
    ];
    const v = runSkeleton("p", "c", [["live/vpc"], ["live/app"], ["live/web"]], unitEdges(units));
    // An edge to a unit no wave holds is left out.
    expect(v.roots.map((r) => [r.root, r.reads])).toEqual([["live/vpc", []], ["live/app", ["live/vpc"]], ["live/web", ["live/app"]]]);
    expect(v.waves.map((w) => w.reads)).toEqual([[], [1], [2]]);
    const html = renderRunHtml(withWave(undefined, v, { number: 1, state: "applied", changed: ["live/vpc"] }, "t"));
    expect(html).toContain('<div id="blast" data-roots="1" data-downstream="2">');
    expect(html).toContain('<path class="edge" data-from="p live/app" data-to="p live/web"');
  });

  it("replaces one wave's row and keeps the rows other jobs wrote", () => {
    const skeleton = runSkeleton("p", "c", waves, deps);
    const one = withWave(undefined, skeleton, { number: 1, state: "applied", digest: "d1" }, "t1");
    const two = withWave(JSON.stringify(one), skeleton, { number: 2, state: "waiting", command: "terragucci approve wave-2 --plan d2" }, "t2");
    expect(two.waves.map((w) => [w.number, w.state])).toEqual([[1, "applied"], [2, "waiting"]]);
    expect(two.waves[0]).toMatchObject({ digest: "d1", updated: "t1" });
    expect(two.updated).toBe("t2");
    // Something else at the key is read as nothing.
    expect(withWave("not json", skeleton, { number: 2, state: "applying" }, "t3").waves[0].state).toBe("not-started");
  });

  it("marks a split wave applied once every share has applied, and a failed share keeps it failed", () => {
    const skeleton = runSkeleton("p", "c", waves, deps);
    let v: RunView = withWave(undefined, skeleton, { number: 2, state: "applying", shares: 2 }, "t");
    v = withWave(JSON.stringify(v), skeleton, { number: 2, shares_applied: [2] }, "t");
    expect(v.waves[1]).toMatchObject({ state: "applying", shares_applied: [2] });
    const failed = withWave(JSON.stringify(withWave(JSON.stringify(v), skeleton, { number: 2, state: "failed" }, "t")), skeleton, { number: 2, shares_applied: [1] }, "t");
    expect(failed.waves[1].state).toBe("failed");
    v = withWave(JSON.stringify(v), skeleton, { number: 2, shares_applied: [1] }, "t");
    expect(v.waves[1]).toMatchObject({ state: "applied", shares_applied: [1, 2] });
  });

  it("keeps a wave past the ones this job knows", () => {
    const skeleton = runSkeleton("p", "c", [["a"]], new Map());
    const v = withWave(undefined, skeleton, { number: 3, state: "applied" }, "t");
    expect(v.waves.map((w) => w.number)).toEqual([1, 3]);
  });

  it("renders each wave with its state, gate, the roots and what each reads, and carries the view as JSON", () => {
    const skeleton = runSkeleton("p", "c0ffee", waves, deps);
    const v = withWave(undefined, skeleton, { number: 2, state: "waiting", policy: "always", approval: "waiting", command: "terragucci approve wave-2 --plan d", report: "2026/10/c0ffee/tf-apply-wave-2" }, "t");
    const html = renderRunHtml(v);
    expect(html).toContain('data-wave="2" data-state="waiting"');
    expect(html).toContain("waiting for an approval");
    expect(html).toContain("gate <code>wave-2</code>, always, waiting");
    expect(html).toContain("<code>terragucci approve wave-2 --plan d</code>");
    expect(html).toContain('href="../../2026/10/c0ffee/tf-apply-wave-2/report.html"');
    expect(html).toContain("reads <code>net</code>");
    expect(html).toContain("after wave 1");
    expect(html).toContain('data-wave="1" data-state="not-started"');
    const json = html.slice(html.indexOf('id="terragucci-run">') + 'id="terragucci-run">'.length, html.indexOf("</script>"));
    expect(JSON.parse(json).schema).toBe(RUN_SCHEMA);
  });

  it("writes run.json and run.html in the bucket, wave by wave", async () => {
    const store = memoryStore();
    const skeleton = runSkeleton("p", "c", waves, deps);
    expect(await updateRunView(store, "r", skeleton, { number: 1, state: "applied" }, "t1")).toBe("r/p/runs/c/run.html");
    await updateRunView(store, "r", skeleton, { number: 2, state: "applying" }, "t2");
    const view = JSON.parse(store.objects.get("r/p/runs/c/run.json")!.body) as RunView;
    expect(view.waves.map((w) => w.state)).toEqual(["applied", "applying"]);
    expect(store.objects.get("r/p/runs/c/run.html")!.body).toContain('data-wave="2" data-state="applying"');
  });
});

describe("a wave's state and reads", () => {
  it("names where a wave stands from how it ended", () => {
    expect(waveState(0, {})).toBe("applied");
    expect(waveState(0, { decided: true })).toBe("applying");
    expect(waveState(3, {})).toBe("waiting");
    expect(waveState(4, {})).toBe("refused");
    expect(waveState(1, { refused: { reason: "policy", roots: ["a"] } })).toBe("refused");
    expect(waveState(1, {})).toBe("failed");
  });

  it("reads each root's remote state blocks as applied state, and the waves they come from", () => {
    const repo = write(tmp(), { "net/main.tf": backend("net.tfstate"), "app/main.tf": backend("app.tfstate") + reads("net", "net.tfstate"), "web/main.tf": backend("web.tfstate") });
    const r = waveReads(repo, waves, ["app", "web"], 2);
    expect(r.waves).toEqual([1]);
    expect(r.reads.get("app")).toEqual([{ upstream: "net", data: "net", outputs: "applied" }]);
    expect(r.reads.get("web")).toEqual([]);
  });
});
