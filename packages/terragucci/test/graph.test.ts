import { describe, expect, it } from "vitest";
import { waveSpans } from "../src/apply";
import { rootStates } from "../src/detect";
import { buildEstate, renderEstateHtml, type ProjectIndex } from "../src/report/estate";
import { blastRadius, phaseTotals, renderGraphSvg, renderTimelineSvg } from "../src/report/graph";
import { mergeSpans, renderRunHtml, runBlast, runSkeleton, SPANS_KEPT, withWave, type RunView } from "../src/report/run-view";
import type { IndexEntry } from "../src/report/store";
import { tmp, write } from "./helpers";

const backend = (bucket: string, key: string): string => `terraform {\n  backend "s3" {\n    bucket = "${bucket}"\n    key    = "${key}"\n  }\n}\n`;
const reads = (name: string, bucket: string, key: string): string => `data "terraform_remote_state" "${name}" {\n  backend = "s3"\n  config = {\n    bucket = "${bucket}"\n    key    = "${key}"\n  }\n}\n`;
const t = (m: number, s = 0): string => `2026-10-09T10:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;

describe("the blast radius", () => {
  // platform <- orders <- billing; platform <- search; email reads nothing.
  const deps = new Map<string, string[]>([
    ["platform", []],
    ["orders", ["platform"]],
    ["search", ["platform"]],
    ["billing", ["orders"]],
    ["email", []],
  ]);

  it("follows every reader of a changed root through, nearest first, with what each reads in the radius", () => {
    const b = blastRadius(deps, ["platform"], { waveOf: new Map([["platform", 1], ["orders", 2], ["search", 2], ["billing", 3]]), planned: new Set(["platform", "orders"]) });
    expect(b).toEqual({
      roots: ["platform"],
      downstream: [
        { root: "orders", reads: ["platform"], depth: 1, wave: 2, planned: true },
        { root: "search", reads: ["platform"], depth: 1, wave: 2, planned: false },
        { root: "billing", reads: ["orders"], depth: 2, wave: 3, planned: false },
      ],
    });
  });

  it("is the changed roots alone when nothing reads them, and a changed root is never downstream", () => {
    expect(blastRadius(deps, ["email"])).toEqual({ roots: ["email"], downstream: [] });
    expect(blastRadius(deps, ["orders", "platform"]).downstream.map((d) => [d.root, d.depth])).toEqual([["billing", 1], ["search", 1]]);
  });
});

describe("each root's state and its reads outside the project", () => {
  it("names the state a backend holds, and the reads no root of the repo holds", () => {
    const repo = write(tmp(), {
      "net/main.tf": backend("state", "net.tfstate"),
      "app/main.tf": backend("state", "app.tfstate") + reads("net", "state", "net.tfstate") + reads("dns", "shared", "dns/zone.tfstate"),
    });
    const s = rootStates(repo, ["net", "app"]);
    expect(s.get("net")).toEqual({ state: { bucket: "state", key: "net.tfstate" }, external: [] });
    expect(s.get("app")).toEqual({ state: { bucket: "state", key: "app.tfstate" }, external: [{ data: "dns", bucket: "shared", key: "dns/zone.tfstate" }] });
    // The run view carries both.
    const v = runSkeleton("p", "c", [["net"], ["app"]], new Map([["app", new Set(["net"])]]), s);
    expect(v.roots).toEqual([
      { root: "net", wave: 1, reads: [], state: { bucket: "state", key: "net.tfstate" } },
      { root: "app", wave: 2, reads: ["net"], state: { bucket: "state", key: "app.tfstate" }, external: [{ data: "dns", bucket: "shared", key: "dns/zone.tfstate" }] },
    ]);
  });
});

describe("under choudoufu, each root's estate and its reads of estates outside the project", () => {
  it("names the records of the estate a live block owns, and the estate output reads no root of the repo owns", () => {
    const live = (estate: string): string => `terraform {\n  live {\n    estate = "${estate}"\n\n    record_store "s3" {\n      bucket = "records"\n    }\n  }\n}\n`;
    const out = (name: string, estate: string): string => `data "terraform_estate_outputs" "${name}" {\n  estate = "${estate}"\n  names  = ["x"]\n}\n`;
    const repo = write(tmp(), {
      "net/main.tf": live("shop-net"),
      "app/main.tf": live("shop-app") + out("net", "shop-net") + out("dns", "shared-dns"),
    });
    const s = rootStates(repo, ["net", "app"]);
    expect(s.get("net")).toEqual({ state: { key: "tofu-records/shop-net" }, external: [] });
    expect(s.get("app")).toEqual({ state: { key: "tofu-records/shop-app" }, external: [{ data: "dns", key: "tofu-records/shared-dns" }] });
    // Another project's root that owns shared-dns is the one app reads.
    const views = (project: string, view: RunView): ProjectIndex => ({ project, base: `${project}/`, reports: [apply(project, view.commit)], run: view });
    const shop = runSkeleton("forge/acme/shop", "a1", [["net"], ["app"]], new Map([["app", new Set(["net"])]]), s);
    const dns = runSkeleton("forge/acme/dns", "d1", [["zone"]], new Map(), rootStates(write(tmp(), { "zone/main.tf": live("shared-dns") }), ["zone"]));
    expect(buildEstate([views("forge/acme/shop", shop), views("forge/acme/dns", dns)], NOW).graph!.edges).toContainEqual({ from: { project: "forge/acme/dns", root: "zone" }, to: { project: "forge/acme/shop", root: "app" } });
  });
});

const NOW = new Date("2026-10-09T12:00:00.000Z");
const apply = (project: string, commit: string): IndexEntry => ({
  project,
  commit,
  stage: "tf-apply",
  wave: 1,
  path: `2026/10/${commit}/tf-apply-wave-1`,
  finished: "2026-10-09T11:00:00.000Z",
  roots: 1,
  groups: 1,
  totals: { create: 1, update: 0, replace: 0, delete: 0 },
  refused: 0,
  destroys: [],
});

/** Two projects: shop's platform is read by its orders, and by billing's invoices from another repo. */
function twoProjects(): ProjectIndex[] {
  const shop: RunView = runSkeleton(
    "forge/acme/shop",
    "a1",
    [["envs/dev/platform"], ["envs/dev/orders"]],
    new Map([["envs/dev/orders", new Set(["envs/dev/platform"])]]),
    new Map([
      ["envs/dev/platform", { state: { bucket: "shop-state", key: "envs/dev/platform.tfstate" }, external: [] }],
      ["envs/dev/orders", { state: { bucket: "shop-state", key: "envs/dev/orders.tfstate" }, external: [] }],
    ]),
  );
  const billing: RunView = runSkeleton(
    "forge/acme/billing",
    "b2",
    [["invoices"]],
    new Map(),
    new Map([["invoices", { state: { bucket: "billing-state", key: "invoices.tfstate" }, external: [{ data: "platform", bucket: "shop-state", key: "envs/dev/platform.tfstate" }, { data: "nowhere", bucket: "x", key: "gone.tfstate" }] }]]),
  );
  return [
    { project: "forge/acme/shop", base: "forge/acme/shop/", reports: [apply("forge/acme/shop", "a1")], run: { ...shop, updated: t(5) } },
    { project: "forge/acme/billing", base: "forge/acme/billing/", reports: [apply("forge/acme/billing", "b2")], run: { ...billing, updated: t(6) } },
  ];
}

describe("the estate's dependency graph", () => {
  it("has each project's roots by wave, its own edges, and an edge from a root to a root of another project that reads its state", () => {
    const e = buildEstate(twoProjects(), NOW);
    expect(e.graph!.nodes).toEqual([
      { project: "forge/acme/shop", root: "envs/dev/platform", wave: 1 },
      { project: "forge/acme/shop", root: "envs/dev/orders", wave: 2 },
      { project: "forge/acme/billing", root: "invoices", wave: 1 },
    ]);
    expect(e.graph!.edges).toEqual([
      { from: { project: "forge/acme/shop", root: "envs/dev/platform" }, to: { project: "forge/acme/shop", root: "envs/dev/orders" } },
      { from: { project: "forge/acme/shop", root: "envs/dev/platform" }, to: { project: "forge/acme/billing", root: "invoices" } },
    ]);
    expect(e.projects[0].run_view).toEqual({ commit: "a1", updated: t(5), page: "forge/acme/shop/runs/a1/run.html" });
  });

  it("draws each edge, the one between projects dashed, and lists the edges between projects", () => {
    const e = buildEstate(twoProjects(), NOW);
    const html = renderEstateHtml(e);
    expect(html).toContain('<h2 id="dependencies">Dependencies</h2>');
    expect(html).toContain('<path class="edge" data-from="forge/acme/shop envs/dev/platform" data-to="forge/acme/shop envs/dev/orders"');
    expect(html).toContain('<path class="edge cross" data-from="forge/acme/shop envs/dev/platform" data-to="forge/acme/billing invoices"');
    expect(html).toContain('<li data-from="forge/acme/shop envs/dev/platform" data-to="forge/acme/billing invoices">forge/acme/billing: <code>invoices</code> reads forge/acme/shop: <code>envs/dev/platform</code></li>');
    expect(html).toContain("3 roots by wave, 1 read within a project and 1 between projects");
    expect(html).toContain('<a href="forge/acme/shop/runs/a1/run.html">run view</a>');
    expect(html.match(/<g class="node"/g)!.length).toBe(3);
    // No script from anywhere: the picture is SVG in the page.
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it("leaves the graph out when no project has a run view, and a project whose run view is another's", () => {
    const [shop, billing] = twoProjects();
    expect(buildEstate([{ ...shop, run: undefined }], NOW).graph).toBeUndefined();
    expect(buildEstate([{ ...billing, run: shop.run }], NOW).graph).toBeUndefined();
    expect(renderEstateHtml(buildEstate([{ ...shop, run: undefined }], NOW))).toContain("No apply has written a run view yet");
  });

  it("draws nothing for no roots, and skips an edge to a root it does not show", () => {
    expect(renderGraphSvg([], [])).toBe("");
    const svg = renderGraphSvg([{ project: "p", roots: [{ root: "a", wave: 1 }] }], [{ from: { project: "p", root: "a" }, to: { project: "q", root: "b" } }]);
    expect(svg).not.toContain('class="edge');
  });
});

describe("the run view's blast radius and timeline", () => {
  const skeleton = runSkeleton("p", "c", [["net"], ["app", "web"], ["edge"]], new Map([["app", new Set(["net"])], ["edge", new Set(["app"])]]));

  it("starts from the roots the waves' plans change and follows their readers", () => {
    let v = withWave(undefined, skeleton, { number: 1, state: "applied", changed: ["net"] }, t(3));
    v = withWave(JSON.stringify(v), skeleton, { number: 2, state: "waiting", changed: [] }, t(4));
    expect(runBlast(v)).toEqual({
      roots: ["net"],
      downstream: [
        { root: "app", reads: ["net"], depth: 1, wave: 2 },
        { root: "edge", reads: ["app"], depth: 2, wave: 3 },
      ],
    });
    const html = renderRunHtml(v);
    expect(html).toContain('<div id="blast" data-roots="1" data-downstream="2">');
    expect(html).toContain('<li class="downstream" data-root="edge" data-depth="2"><code>edge</code>, wave 3: reads <code>app</code></li>');
    expect(html).toContain('<g class="node changed" data-project="p" data-root="net"');
    expect(html).toContain('<g class="node downstream" data-project="p" data-root="app"');
    expect(html).toContain('<path class="edge" data-from="p net" data-to="p app"');
  });

  it("says when no wave has planned yet", () => {
    expect(renderRunHtml(withWave(undefined, skeleton, { number: 1, state: "applying" }, t(1)))).toContain("No wave has planned yet");
  });

  it("draws each wave's plan, gate wait and apply on one axis, and a wait that has not ended as open", () => {
    let v = withWave(undefined, skeleton, { number: 1, state: "waiting", spans: [{ phase: "plan", start: t(0), end: t(2) }, { phase: "gate", start: t(2) }] }, t(2));
    // The approval closes the wait the first job opened; the second job plans again and applies.
    v = withWave(JSON.stringify(v), skeleton, { number: 1, state: "applied", spans: [{ phase: "plan", start: t(10), end: t(11) }, { phase: "gate", start: t(2), end: t(9) }, { phase: "apply", start: t(11), end: t(14) }] }, t(14));
    v = withWave(JSON.stringify(v), skeleton, { number: 2, state: "waiting", spans: [{ phase: "plan", start: t(14), end: t(15) }, { phase: "gate", start: t(15) }] }, t(15));
    expect(v.waves[0].spans).toEqual([
      { phase: "plan", start: t(0), end: t(2) },
      { phase: "gate", start: t(2), end: t(9) },
      { phase: "plan", start: t(10), end: t(11) },
      { phase: "apply", start: t(11), end: t(14) },
    ]);
    expect(phaseTotals(v.waves[0].spans!, v.updated)).toEqual({ plan: 180, gate: 420, apply: 180, waiting: false });
    expect(phaseTotals(v.waves[1].spans!, t(20))).toEqual({ plan: 60, gate: 300, waiting: true });
    const html = renderRunHtml({ ...v, updated: t(20) });
    expect(html.match(/<rect class="span plan"/g)!.length).toBe(3);
    expect(html).toContain('<rect class="span gate open" data-phase="gate" data-open');
    expect(html).toContain("wave 2: gate wait 5m 0s, still waiting");
    expect(html).toContain('<tr data-wave="1"><td>1</td><td>3m 0s</td><td>7m 0s</td><td>3m 0s</td></tr>');
    expect(html).toContain('<tr data-wave="2"><td>2</td><td>1m 0s</td><td>5m 0s (waiting)</td><td></td></tr>');
  });

  it("keeps the newest spans, and draws nothing with none", () => {
    const many = Array.from({ length: SPANS_KEPT + 5 }, (_, i) => ({ phase: "plan" as const, start: t(i), end: t(i, 30) }));
    const kept = mergeSpans([], many);
    expect(kept.length).toBe(SPANS_KEPT);
    expect(kept[0].start).toBe(t(5));
    expect(renderTimelineSvg([{ number: 1 }], t(0))).toBe("");
    expect(renderRunHtml(withWave(undefined, skeleton, { number: 1, state: "applying" }, t(1)))).toContain("No wave has a recorded time yet");
  });
});

describe("a wave job's spans", () => {
  it("are its plan, its open wait while it waits, and its apply once it applies", () => {
    expect(waveSpans({ started: t(0), plannedAt: t(1), gateSince: t(1), state: "waiting", ended: t(1, 5) })).toEqual([
      { phase: "plan", start: t(0), end: t(1) },
      { phase: "gate", start: t(1) },
    ]);
    expect(waveSpans({ started: t(9), plannedAt: t(10), gateSince: t(1), approvedAt: t(8), applyStarted: t(10), state: "applying" })).toEqual([
      { phase: "plan", start: t(9), end: t(10) },
      { phase: "gate", start: t(1), end: t(8) },
      { phase: "apply", start: t(10) },
    ]);
    expect(waveSpans({ started: t(9), plannedAt: t(10), applyStarted: t(10), ended: t(12), state: "applied", share: 2 })).toEqual([
      { phase: "plan", start: t(9), end: t(10), share: 2 },
      { phase: "apply", start: t(10), end: t(12), share: 2 },
    ]);
  });
});
