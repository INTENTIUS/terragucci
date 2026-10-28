import { afterEach, describe, expect, it } from "vitest";
import { BUILT_IN, type ResolvedSettings } from "../src/config";
import { chantModuleCatalog, overrideChantNext, type ChantModuleCatalog, type ChantModuleCompatibility } from "../src/chant-next";
import { buildEstate, compatCell, renderEstateHtml, type ProjectIndex } from "../src/report/estate";
import { loadHclParser } from "../src/rollout/parser";
import { MODULE_TABLE_TIP, moduleTableMessage, repoTips, type TipOptions } from "../src/tips";
import { tmp, write } from "./helpers";

// The catalog's answers stand in for chant's terraform lexicon (chant#4560):
// terragucci decides nothing, so the tests hand it the answers and read the words.
const PAGE = "https://intentius.io/choudoufu/aws/compatibility/#modules";

const answer = (over: Partial<ChantModuleCompatibility>): ChantModuleCompatibility => ({
  module: "terraform-aws-modules/eks/aws",
  version: "21.29.0",
  tier: "static",
  status: "refused",
  examples: 6,
  clearExamples: 0,
  refusedExamples: 6,
  refusals: [{ id: "unadmitted-type", sites: 9, docsUrl: "https://github.com/INTENTIUS/choudoufu/blob/main/live/LIMITATIONS.md#unadmitted-type", examples: ["examples/karpenter"] }],
  measuredVersions: ["21.29.0"],
  ...over,
});

const fakeCatalog = (answers: Record<string, ChantModuleCompatibility>): ChantModuleCatalog => ({
  moduleCompatibility: (source: string, version: string) => answers[`${source} ${version}`],
  MODULE_COMPATIBILITY_PAGE: PAGE,
  MODULE_CATALOG_SOURCE: { date: "2026-10-27", awsProvider: "6.59.0", commit: "0".repeat(40) },
});

const index = (project: string, binary: string, modules: { call: string; source: string; version?: string }[]): ProjectIndex => ({
  project,
  reports: [],
  versions: {
    schema: "terragucci.versions/v1",
    roots: [{ root: "net", commit: "abc", finished: "2026-10-27T00:00:00Z", path: "runs/1", binary: { name: binary }, providers: [], modules }],
  } as unknown as ProjectIndex["versions"],
});

describe("the estate page's module table column (terragucci#1286)", () => {
  const eks = { call: "module.eks", source: "terraform-aws-modules/eks/aws", version: "21.29.0" };
  const catalog = fakeCatalog({ "terraform-aws-modules/eks/aws 21.29.0": answer({}) });

  it("puts the catalog's answer on a module version a choudoufu root runs, tier included", () => {
    const page = buildEstate([index("acme/infra", "choudoufu", [eks])], new Date("2026-10-27T01:00:00Z"), catalog);
    const row = page.versions!.modules[0].versions[0];
    expect(row.compat).toEqual({ tier: "static", status: "refused", examples: 6, refused: 6, refusals: [{ id: "unadmitted-type", sites: 9 }], page: PAGE });
    const html = renderEstateHtml(page);
    expect(html).toContain("<th>On choudoufu</th>");
    expect(html).toContain('data-compat="refused"');
    expect(html).toContain(`<a href="${PAGE}"><code>unadmitted-type</code></a> (9 sites)`);
    expect(html).toContain('<small class="tier">static</small>');
  });

  it("leaves a root that runs tofu without a cell, and the column out when no row has one", () => {
    const page = buildEstate([index("acme/infra", "tofu", [eks])], new Date(), catalog);
    expect(page.versions!.modules[0].versions[0].compat).toBeUndefined();
    expect(renderEstateHtml(page)).not.toContain("On choudoufu");
  });

  it("leaves the column out when the installed chant has no catalog", () => {
    const page = buildEstate([index("acme/infra", "choudoufu", [eks])], new Date());
    expect(page.versions!.modules[0].versions[0].compat).toBeUndefined();
  });

  it("words every status with its tier first", () => {
    const base = { tier: "static", examples: 0, refused: 0, refusals: [], page: PAGE };
    expect(compatCell({ ...base, status: "clear", examples: 3 })).toBe('<small class="tier">static</small> plans in 3 examples');
    expect(compatCell({ ...base, status: "unknown-version", measured: ["6.6.1"] })).toContain("no row at this version</a>; measured <code>6.6.1</code>");
    expect(compatCell({ ...base, status: "unknown-module" })).toContain("no row for this module");
  });
});

describe("the module table tip (terragucci#1286)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("words each status, and stays quiet on a clear version", () => {
    expect(moduleTableMessage(answer({}))).toContain("is refused in 6 of 6 examples in choudoufu's module table (static tier): unadmitted-type (9 sites)");
    expect(moduleTableMessage(answer({ status: "unknown-version", version: "20.0.0", measuredVersions: ["21.29.0"] }))).toContain("has no row for terraform-aws-modules/eks/aws 20.0.0; it measured 21.29.0");
    expect(moduleTableMessage(answer({ status: "unknown-module", module: "cloudposse/label/null" }))).toContain("has no row for cloudposse/label/null");
    expect(moduleTableMessage(answer({ status: "clear" }))).toBeUndefined();
  });

  it("tips a choudoufu root's refused pin, and no tofu root's", async () => {
    restore = overrideChantNext("moduleCatalog", fakeCatalog({ "terraform-aws-modules/eks/aws 21.29.0": answer({}) }));
    const hcl = 'module "eks" {\n  source  = "terraform-aws-modules/eks/aws"\n  version = "21.29.0"\n}\n';
    const repo = write(tmp(), { "live/main.tf": hcl, "stock/main.tf": hcl });
    const parser = await loadHclParser();
    const settings = { ...BUILT_IN } as ResolvedSettings as TipOptions["settings"];
    const tips = await repoTips(repo, ["live", "stock"], { settings, parser, rules: [], choudoufuRoots: ["live"] });
    const table = tips.filter((t) => t.rule === MODULE_TABLE_TIP);
    expect(table.map((t) => t.root)).toEqual(["live"]);
    expect(table[0].url).toContain("#terragucci-module-table");
  });

  it("gives no module table tip when the installed chant has no catalog", async () => {
    restore = overrideChantNext("moduleCatalog", null);
    const repo = write(tmp(), { "live/main.tf": 'module "eks" {\n  source  = "terraform-aws-modules/eks/aws"\n  version = "21.29.0"\n}\n' });
    const tips = await repoTips(repo, ["live"], { settings: { ...BUILT_IN, binary: "choudoufu" } as TipOptions["settings"], parser: await loadHclParser(), rules: [] });
    expect(tips.filter((t) => t.rule === MODULE_TABLE_TIP)).toEqual([]);
  });

  it("reads chant's own catalog when the installed chant has one", async () => {
    const lib = await chantModuleCatalog();
    if (!lib) return;
    expect(lib.moduleCompatibility("terraform-aws-modules/sqs/aws", "5.2.2")?.status).toBe("clear");
    expect(lib.moduleCompatibility("terraform-aws-modules/eks/aws", "21.29.0")?.tier).toBe("static");
  });
});
