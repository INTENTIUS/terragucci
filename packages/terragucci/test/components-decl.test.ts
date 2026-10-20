import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { opWaveShare } from "@intentius/chant/op";
import { resolveComponentGraph } from "@intentius/chant/components";
import { comp003MutatingNoRollbackRule } from "@intentius/chant/lint/rules/comp/comp003-mutating-no-rollback";
import { terraformApplyCapability } from "@intentius/chant-lexicon-terraform/components/capability-plugin";
import { applyWaves } from "../src/apply";
import { COMPONENTS_PATH, NO_ROLLBACK, componentsDecl, componentsWrittenByTerragucci, type ComponentsDecl } from "../src/components-decl";
import type { ForgeName, ProjectSettings } from "../src/config";
import { applyGroups } from "../src/groups";
import { withEnvironmentRoles } from "../src/environments";
import { init } from "../src/init";
import { renderPipeline, shareRoots, type PipelineInput } from "../src/render";
import { tmp, write } from "./helpers";

const DEMO = join(__dirname, "..", "..", "..", "example-demo");

/** The demo's base tree in a scratch directory, so init's files land there: example-demo/ less its scenarios, as stack/demo.sh pushes it. */
function demoRepo(): string {
  const dir = tmp();
  cpSync(DEMO, dir, { recursive: true, filter: (src) => !src.startsWith(join(DEMO, "scenarios")) });
  return dir;
}

const sortWaves = (waves: string[][]): string[][] => waves.map((w) => [...w].sort());
/** chant's waves for the declared components. */
const chantWaves = (d: ComponentsDecl): string[][] => sortWaves(resolveComponentGraph(d.components).waves);

/** The job keys of a rendered pipeline that apply roots on a push or, under apply.when: pull-request, an open pull request. */
function applyKeys(text: string, forge: ForgeName): string[] {
  const doc = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
  const jobs = Object.keys(forge === "gitlab" ? doc : doc.jobs);
  return jobs.filter((k) => /^apply-(wave-\d|rest$|done$)/.test(k));
}

function needsOf(text: string, forge: ForgeName, job: string): string[] {
  const doc = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
  const n = (forge === "gitlab" ? doc : doc.jobs)[job].needs;
  if (n === undefined) return [];
  return (Array.isArray(n) ? n : [n]).map((x: any) => (typeof x === "string" ? x : x.job));
}

const PROD = { plan_role: "arn:aws:iam::222222222222:role/prod-plan", apply_role: "arn:aws:iam::222222222222:role/prod-apply" };
const DEV = { plan_role: "arn:aws:iam::111111111111:role/dev-plan", apply_role: "arn:aws:iam::111111111111:role/dev-apply" };
const ENVS: ProjectSettings = { environments: { prod: { roots: ["envs/prod/**"], gate: "always", oidc: PROD }, dev: { roots: ["envs/dev/**"], oidc: DEV } } };
const LAYERS = [["envs/dev/network", "envs/prod/network", "shared/dns"], ["envs/dev/app", "envs/prod/app"]];
const ORDER = new Map([["envs/dev/app", new Set(["envs/dev/network"])], ["envs/prod/app", new Set(["envs/prod/network", "shared/dns"])]]);

const base = (forge: ForgeName, extra: Partial<PipelineInput> = {}): PipelineInput => ({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: LAYERS, env: {}, ...extra }) as PipelineInput;
const grouped = (forge: ForgeName, extra: Partial<PipelineInput> = {}): PipelineInput => {
  const groups = applyGroups(ENVS, LAYERS.flat())!;
  return base(forge, { oidc: withEnvironmentRoles(undefined, ENVS.environments), applyGroups: groups, ...extra });
};

const CASES: [string, PipelineInput][] = [];
for (const forge of ["github", "forgejo", "gitlab"] as ForgeName[]) {
  CASES.push([`${forge}: one job a wave`, base(forge)]);
  CASES.push([`${forge}: waves.canary`, base(forge, { canary: ["envs/dev/**"] })]);
  CASES.push([`${forge}: waves.jobs 2`, base(forge, { waveJobs: 2 })]);
  CASES.push([`${forge}: environments`, grouped(forge)]);
  CASES.push([`${forge}: environments and waves.jobs 2`, grouped(forge, { waveJobs: 2 })]);
}

const DEMO_TG = join(__dirname, "..", "..", "..", "example-demo-terragrunt");

/** The Terragrunt demo's base tree in a scratch directory, as stack/demo.sh pushes it; with `pull`, its scenario's files over it. */
function demoTgRepo(pull?: string): string {
  const dir = tmp();
  cpSync(DEMO_TG, dir, { recursive: true, filter: (src) => !src.startsWith(join(DEMO_TG, "scenarios")) });
  if (pull) cpSync(join(DEMO_TG, "scenarios", pull, "pull"), dir, { recursive: true });
  return dir;
}

describe("terragucci.components.json", () => {
  it("example-demo-terragrunt: init's waves are network / app, and the pull request's are ledger+network / app+billing; the committed file is init's", async () => {
    // Discovery by the files, as on a host with no terragrunt; the jobs run terragrunt find.
    const opts = { dryRun: true, terragrunt: join(tmp(), "no-terragrunt") };
    const r = await init(demoTgRepo(), opts);
    expect(sortWaves(applyWaves(r.layers))).toEqual([["live/network"], ["live/app"]]);
    const file = r.files.find((f) => f.path.endsWith(COMPONENTS_PATH))!;
    const made = JSON.parse(file.content) as ComponentsDecl & { generated_by?: string };
    const committed = JSON.parse(readFileSync(join(DEMO_TG, COMPONENTS_PATH), "utf-8")) as ComponentsDecl & { generated_by?: string };
    expect({ ...committed, generated_by: "" }).toEqual({ ...made, generated_by: "" });
    expect(Object.fromEntries(made.components.map((c) => [c.name, c.dependsOn]))).toEqual({ "live/network": [], "live/app": ["live/network"] });

    const pulled = await init(demoTgRepo("tg-planned-outputs"), opts);
    expect(sortWaves(applyWaves(pulled.layers))).toEqual([["live/ledger", "live/network"], ["live/app", "live/billing"]]);
  });

  it("example-demo: init writes it beside the workflow, with the waves network+other / app / edge that terragucci computes", async () => {
    const dir = demoRepo();
    const r = await init(dir, { dryRun: true });
    const file = r.files.find((f) => f.path === join(dir, COMPONENTS_PATH))!;
    expect(file.status).toBe("created");
    const decl = JSON.parse(file.content) as ComponentsDecl;
    const waves = applyWaves(r.layers);
    expect(sortWaves(waves)).toEqual([["network", "other"], ["app"], ["edge"]]);
    expect(chantWaves(decl)).toEqual(sortWaves(waves));
    expect(decl.schema).toBe("terragucci.components/v1");
    expect(decl.roots).toEqual({ network: { dir: "network" }, other: { dir: "other" }, app: { dir: "app" }, edge: { dir: "edge" } });
    expect(Object.fromEntries(decl.components.map((c) => [c.name, c.dependsOn]))).toEqual({ network: [], other: [], app: ["network"], edge: ["app"] });
    const pipeline = r.files.find((f) => f.path === join(dir, ".forgejo/workflows/terragucci.yml"))!;
    expect(decl.pipeline.path).toBe(".forgejo/workflows/terragucci.yml");
    expect(decl.pipeline.jobs.map((j) => j.name)).toEqual(applyKeys(pipeline.content, "forgejo"));
    expect(decl.pipeline.jobs).toEqual([
      { name: "apply-wave-1", needs: ["check"], wave: 1, applies: ["network", "other"] },
      { name: "apply-wave-2", needs: ["apply-wave-1"], wave: 2, applies: ["app"] },
      { name: "apply-wave-3", needs: ["apply-wave-2"], wave: 3, applies: ["edge"] },
    ]);
  });

  it("example-demo: written, then unchanged on the next init; a file terragucci did not write is refused, and --force replaces it", async () => {
    const dir = demoRepo();
    await init(dir, {});
    const path = join(dir, COMPONENTS_PATH);
    const text = readFileSync(path, "utf-8");
    expect(componentsWrittenByTerragucci(text)).toBe(true);
    const again = await init(dir, {});
    expect(again.files.find((f) => f.path === path)?.status).toBe("unchanged");
    writeFileSync(path, '{ "mine": true }\n');
    await expect(init(dir, { dryRun: true })).rejects.toThrow(`${COMPONENTS_PATH} exists and terragucci did not write it; move it aside or pass --force`);
    const forced = await init(dir, { force: true });
    expect(forced.files.find((f) => f.path === path)?.status).toBe("updated");
    expect(readFileSync(path, "utf-8")).toBe(text);
  });

  it("waves.after joins the dependsOn, and init's waves still equal chant's", async () => {
    const dir = write(demoRepo(), { "terragucci.yml": "forge: forgejo\nbinary: tofu\nwaves:\n  after:\n    other: [edge]\n" });
    const r = await init(dir, { dryRun: true });
    const decl = JSON.parse(r.files.find((f) => f.path === join(dir, COMPONENTS_PATH))!.content) as ComponentsDecl;
    expect(decl.components.find((c) => c.name === "other")!.dependsOn).toEqual(["edge"]);
    expect(chantWaves(decl)).toEqual(sortWaves(applyWaves(r.layers)));
    expect(chantWaves(decl)).toEqual([["network"], ["app"], ["edge"], ["other"]]);
  });

  it.each(CASES)("%s: the waves equal applyWaves(layers, canary), the job names equal the workflow's, and each root applies in one job", (_, input) => {
    const rendered = renderPipeline(input);
    const waves = applyWaves(input.layers, input.canary);
    const decl = componentsDecl({ waves, order: ORDER, pipeline: { path: rendered.path, forge: input.forge, applyJobs: rendered.applyJobs } });
    expect(chantWaves(decl)).toEqual(sortWaves(waves));
    expect(decl.pipeline.jobs.map((j) => j.name)).toEqual(applyKeys(rendered.content, input.forge));
    for (const j of decl.pipeline.jobs) expect(j.needs).toEqual(needsOf(rendered.content, input.forge, j.name));
    // Every root applies in exactly one job, in its own wave's.
    const applied = decl.pipeline.jobs.flatMap((j) => j.applies.map((r) => [r, j.wave]));
    expect(applied.map(([r]) => r).sort()).toEqual(input.layers.flat().sort());
    for (const [r, w] of applied) expect(waves[(w as number) - 1]).toContain(r);
  });

  it("waves.canary reorders the waves, so each wave's roots also follow the wave before", () => {
    const waves = applyWaves(LAYERS, ["envs/dev/**"]);
    expect(waves).toEqual([["envs/dev/network"], ["envs/dev/app"], ["envs/prod/network", "shared/dns"], ["envs/prod/app"]]);
    const rendered = renderPipeline(base("github", { canary: ["envs/dev/**"] }));
    const decl = componentsDecl({ waves, order: ORDER, pipeline: { path: rendered.path, forge: "github", applyJobs: rendered.applyJobs } });
    expect(Object.fromEntries(decl.components.map((c) => [c.name, c.dependsOn]))).toEqual({
      "envs/dev/network": [],
      "envs/dev/app": ["envs/dev/network"],
      "envs/prod/network": ["envs/dev/app"],
      "shared/dns": ["envs/dev/app"],
      "envs/prod/app": ["envs/prod/network", "shared/dns"],
    });
    expect(chantWaves(decl)).toEqual(sortWaves(waves));
  });

  it("apply.when: pull-request: the one job that applies a pull request lists every root", () => {
    for (const forge of ["github", "gitlab"] as ForgeName[]) {
      const rendered = renderPipeline(base(forge, { applyWhen: "pull-request", ...(forge === "gitlab" ? { comments: "*/5 * * * *", applyMergeTokenEnv: "MERGE_TOKEN" } : {}) }));
      const name = forge === "gitlab" ? "mr-apply" : "apply-comment";
      expect(rendered.applyJobs).toEqual([{ name, needs: [], applies: LAYERS.flat().sort() }]);
      expect(rendered.content).toMatch(new RegExp(`^ *${name}:`, "m"));
    }
  });

  it("a Terragrunt repo's waves are its layers, and its last wave's shares end in apply-rest", () => {
    const layers = [["live/a", "live/b", "live/c"]];
    const rendered = renderPipeline(base("github", { layers, waveJobs: 2, terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] } }));
    const decl = componentsDecl({ waves: layers, order: new Map(), pipeline: { path: rendered.path, forge: "github", applyJobs: rendered.applyJobs } });
    expect(decl.pipeline.jobs.map((j) => j.name)).toEqual(applyKeys(rendered.content, "github"));
    expect(decl.pipeline.jobs.map((j) => [j.name, j.applies])).toEqual([["apply-wave-1", []], ["apply-wave-1-share-1", ["live/a", "live/b"]], ["apply-wave-1-share-2", ["live/c"]], ["apply-rest", []]]);
    expect(chantWaves(decl)).toEqual(layers);
  });

  it("each step carries noRollback, so chant's lint (COMP003) passes the components, and refuses them without it", async () => {
    const dir = demoRepo();
    const r = await init(dir, { dryRun: true });
    const decl = JSON.parse(r.files.find((f) => f.path === join(dir, COMPONENTS_PATH))!.content) as ComponentsDecl;
    for (const c of decl.components) expect(c.deploy).toEqual([{ phase: "Apply", steps: [{ kind: "terraform-apply", root: c.name, noRollback: NO_ROLLBACK }] }]);
    // terraform-apply's own disposition, from the terraform lexicon that registers it.
    const policy = terraformApplyCapability.rollbackPolicy;
    expect(policy).toBe("needs-opt-out");
    const lint = (components: ComponentsDecl["components"]) =>
      comp003MutatingNoRollbackRule.check({ components: new Map(components.map((c) => [c.name, { component: c as never, filePath: COMPONENTS_PATH }])), rollbackPolicies: new Map([["terraform-apply", policy!]]) });
    expect(lint(decl.components)).toEqual([]);
    const bare = decl.components.map((c) => ({ ...c, deploy: c.deploy.map((p) => ({ ...p, steps: p.steps.map(({ noRollback: _, ...s }) => s) })) }));
    expect(lint(bare as never)).toHaveLength(decl.components.length);
  });

  it("shares cut as chant's opWaveShare cuts them", () => {
    const roots = ["e", "a", "d", "b", "c"];
    for (let n = 1; n <= 5; n++) for (let s = 1; s <= n; s++) expect(shareRoots(roots, s, n)).toEqual(opWaveShare(roots.map((target) => ({ target })), s, n).map((r) => r.target));
  });
});
