// The validation stack on chant's e2e harness (terragucci#1295): the forge
// services under the stack's names, the fallback file that stands in on a
// chant without the harness, the gate between them, the scenarios' lint, and
// smoke.sh's verdicts as claim rows. Nothing here starts a container.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_VERSIONS } from "../packages/terragucci/src/images";
import { bareVersion, breakVerdict, parseClaimsTable, parseSmokeLine, plainVerdict, rowEngine, saysBinary, smokeClaimRun, smokeRows, smokeScenario } from "../stack/harness/rows";
import { localFindings, overlayFiles, readIndex, scenarioIds, scenarioPath, SOURCE_PATTERN, TERRAGUCCI_STEPS, TREE_OVERLAY } from "../stack/harness/scenarios";
import { forgeServices, JOB_CACHE_VOLUME, PROFILES, STACK_PORTS, type HarnessStackFn, type ServiceSpec } from "../stack/harness/stack-spec";

const root = join(__dirname, "..");
const stack = join(root, "stack");

/** chant's harnessStack, as packages/core/src/e2e-harness/stack.ts shapes it, cut to what forgeServices reads. */
const fakeHarness: HarnessStackFn = (o) => {
  const p = o.project;
  const prefix = o.envPrefix ?? "CHANT_E2E";
  const key = o.networkKey ?? "harness";
  const bind = o.bind === undefined ? "127.0.0.1" : o.bind;
  const publish = (svc: string, port: number, inner: number) => `${bind ? `${bind}:` : ""}\${${prefix}_${svc}_PORT:-${port}}:${inner}`;
  const on = (...aliases: string[]) => ({ [key]: { aliases } });
  const svc = (s: Omit<ServiceSpec, "networks"> & { networks?: ServiceSpec["networks"] }, ...aliases: string[]): ServiceSpec => ({ networks: on(...aliases), ...s });
  return {
    project: p,
    network: { name: p },
    networkKey: key,
    volumes: { forgejoData: { name: `${p}-forgejo-data` }, runnerData: { name: `${p}-runner-data` } },
    services: {
      floci: svc({ image: o.flociImage ?? "ghcr.io/lex00/floci@sha256:5ec92ae8", container_name: `${p}-floci`, ports: [publish("FLOCI", o.ports?.floci ?? 4591, 4566)] }, "floci", "000000000000.floci"),
      forgejo: svc({ image: "codeberg.org/forgejo/forgejo:16.0.5", container_name: `${p}-forgejo`, environment: { FORGEJO__actions__ENABLED: "true" }, ports: [publish("FORGEJO", o.ports?.forgejo ?? 3391, 3000)], volumes: ["forgejoData:/data"] }, "forgejo"),
      forgejoRunner: svc({ image: "data.forgejo.org/forgejo/runner:13.2.0", container_name: `${p}-forgejo-runner`, volumes: ["/var/run/docker.sock:/var/run/docker.sock", "runnerData:/data"] }, "forgejo-runner"),
    },
  };
};

describe("the forge services from the harness", () => {
  const f = forgeServices(fakeHarness, { project: "terragucci" });

  it("keeps the stack's compose keys, container names, network and volumes", () => {
    expect(Object.keys(f.services).sort()).toEqual(["floci", "forgejo", "forgejo-runner"]);
    expect(f.services.floci.container_name).toBe("terragucci-floci");
    expect(f.services["forgejo-runner"].container_name).toBe("terragucci-forgejo-runner");
    expect(f.network.name).toBe("terragucci");
    expect(f.volumes["forgejo-data"].name).toBe("terragucci-forgejo-data");
    expect(f.volumes["forgejo-runner-data"].name).toBe("terragucci-forgejo-runner-data");
    expect(f.volumes["job-cache"].name).toBe(JOB_CACHE_VOLUME);
    expect(f.services.floci.networks).toEqual({ default: { aliases: ["floci", "000000000000.floci"] } });
  });

  it("publishes the stack's own ports under its own variables, on loopback", () => {
    expect(f.services.floci.ports).toEqual([`127.0.0.1:\${TERRAGUCCI_FLOCI_PORT:-${STACK_PORTS.floci}}:4566`]);
    expect(f.services.forgejo.ports).toEqual([`127.0.0.1:\${TERRAGUCCI_FORGEJO_PORT:-${STACK_PORTS.forgejo}}:3000`]);
    expect(forgeServices(fakeHarness, { project: "terragucci", bindAll: true }).services.floci.ports).toEqual(["${TERRAGUCCI_FLOCI_PORT:-4580}:4566"]);
  });

  it("mounts the stack's volumes by its keys, and the job cache in the runner", () => {
    expect(f.services.forgejo.volumes).toEqual(["forgejo-data:/data"]);
    expect(f.services["forgejo-runner"].volumes).toEqual(["/var/run/docker.sock:/var/run/docker.sock", "forgejo-runner-data:/data", "job-cache:/cache"]);
  });

  it("starts each service under the profiles the fallback file gives it", () => {
    expect(f.services.floci.profiles).toEqual([...PROFILES.floci]);
    expect(f.services.forgejo.profiles).toEqual(["forgejo"]);
    expect(f.services["forgejo-runner"].profiles).toEqual(["forgejo"]);
    expect(f.services.floci.environment?.FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED).toBe("${TERRAGUCCI_FLOCI_IAM_ENFORCEMENT:-false}");
  });

  it("takes floci from the harness's pin unless another image is named", () => {
    expect(f.services.floci.image).toContain("5ec92ae8");
    expect(forgeServices(fakeHarness, { project: "terragucci", flociImage: "floci:other" }).services.floci.image).toBe("floci:other");
  });

  it("names everything after the capture stack's project there", () => {
    const c = forgeServices(fakeHarness, { project: "terragucci-capture" });
    expect(c.services.forgejo.container_name).toBe("terragucci-capture-forgejo");
    expect(c.volumes["forgejo-data"].name).toBe("terragucci-capture-forgejo-data");
    expect(c.volumes["job-cache"].name).toBe(JOB_CACHE_VOLUME);
  });
});

describe("the fallback file and docker-compose.yml", () => {
  const fallback = readFileSync(join(stack, "forge-fallback.yml"), "utf8");
  const compose = readFileSync(join(stack, "docker-compose.yml"), "utf8");
  const servicesOf = (text: string) => [...text.matchAll(/^ {2}([a-z][a-z0-9-]*):(?: &[a-z-]+)?$/gm)].map((m) => m[1]);

  it("holds floci, Forgejo and forgejo-runner, which docker-compose.yml no longer defines", () => {
    expect(servicesOf(fallback.slice(fallback.indexOf("\nservices:")))).toEqual(["floci", "forgejo", "forgejo-runner"]);
    const services = servicesOf(compose.slice(compose.indexOf("\nservices:")));
    for (const s of ["floci", "forgejo", "forgejo-runner"]) expect(services).not.toContain(s);
    expect(compose).not.toMatch(/forgejo-data:|forgejo-runner-data:/);
  });

  it("starts them under the profiles and ports the harness's services use", () => {
    expect(fallback).toMatch(/profiles: \[aws, forgejo, github, gitlab, fountain\]/);
    expect(fallback).toContain('"${TERRAGUCCI_FLOCI_PORT:-4580}:4566"');
    expect(fallback).toContain('"${TERRAGUCCI_FORGEJO_PORT:-3300}:3000"');
    expect(fallback).toContain("job-cache:/cache");
  });
});

/** Source instance.sh under `env` and run `script` after it. */
function inInstance(script: string, env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", ["-c", `set -euo pipefail; . "${stack}/instance.sh"; ${script}`], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    encoding: "utf8",
  });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

describe("the gate between the harness and the fallback", () => {
  const state = () => mkdtempSync(join(tmpdir(), "tg-harness-state-"));

  it("takes the fallback under TG_HARNESS=fallback, and reads its images", () => {
    const r = inInstance('tg_forge_compose; echo "$TG_FORGE_COMPOSE"; tg_forge_image floci; tg_forge_image forgejo-runner', { TG_HARNESS: "fallback", TG_STATE: state() });
    expect(r.status).toBe(0);
    const [file, floci, runner] = r.stdout.trim().split("\n");
    expect(file).toBe(join(stack, "forge-fallback.yml"));
    expect(floci).toMatch(/^ghcr\.io\/lex00\/floci@sha256:[0-9a-f]{64}$/);
    expect(runner).toBe("data.forgejo.org/forgejo/runner:13.2.0");
  });

  it("refuses a TG_HARNESS it does not know", () => {
    const r = inInstance("tg_forge_compose", { TG_HARNESS: "other", TG_STATE: state() });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("auto (the default), harness or fallback");
  });

  it("falls back with a line saying so when the installed chant has no harness", async () => {
    const { loadHarness } = await import("../stack/harness/harness");
    if (await loadHarness()) return; // a local chant with the harness builds its compose instead
    const r = inInstance('tg_forge_compose; echo "$TG_FORGE_COMPOSE"', { TG_STATE: state() });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(join(stack, "forge-fallback.yml"));
    expect(r.stderr).toContain("needs a chant with @intentius/chant/e2e-harness");
    const forced = inInstance("tg_forge_compose", { TG_HARNESS: "harness", TG_STATE: state() });
    expect(forced.status).not.toBe(0);
  });

  it("keeps the file per project, so the capture stack never reads the shared stack's", () => {
    const r = inInstance('TG_FORGE_COMPOSE=/elsewhere.yml TG_FORGE_COMPOSE_FOR=terragucci-capture; tg_forge_compose; echo "$TG_FORGE_COMPOSE_FOR $TG_FORGE_COMPOSE"', { TG_HARNESS: "fallback", TG_STATE: state() });
    expect(r.stdout.trim()).toBe(`terragucci ${join(stack, "forge-fallback.yml")}`);
  });
});

describe("the scenarios", () => {
  const index = readIndex();

  it("each holds the protocol and steps a terragucci pipeline completes", () => {
    const ids = scenarioIds();
    expect(ids).toEqual(Object.keys(index).sort());
    for (const id of ids) expect(localFindings(scenarioPath(id), index), id).toEqual([]);
  });

  it("each opens and breaks with overlays on disk", () => {
    for (const id of scenarioIds()) {
      const doc = JSON.parse(readFileSync(scenarioPath(id), "utf8")) as { steps: Array<{ do: string; overlay?: string }>; break: { overlay?: string } };
      for (const s of doc.steps) {
        expect(TERRAGUCCI_STEPS.has(s.do), `${id} ${s.do}`).toBe(true);
        if (s.overlay && !s.overlay.startsWith(TREE_OVERLAY)) expect(Object.keys(overlayFiles(scenarioPath(id), s.overlay)).length, `${id} ${s.overlay}`).toBeGreaterThan(0);
      }
      if (doc.break.overlay) expect(Object.keys(overlayFiles(scenarioPath(id), doc.break.overlay)).length).toBeGreaterThan(0);
    }
  });

  it("reads a sourced tree from a repo it names, at a pinned commit off INTENTIUS", () => {
    for (const [id, e] of Object.entries(index)) {
      if (!e.source) continue;
      expect(e.source, id).toMatch(SOURCE_PATTERN);
      if (e.source.includes("@")) expect(e.source, id).toMatch(/@[0-9a-f]{40}:/);
    }
    expect(index["tg-compose-cross-estate"]?.lift).toEqual(["forgejo/.forgejo:.forgejo"]);
    expect(index["tg-compose-ci-pipelines"]?.source).toBe("choudoufu:examples/ci-pipelines");
    expect(index["tg-compose-ci-pipelines"]?.lift).toEqual(["forgejo/.forgejo:.forgejo"]);
    expect(index["tg-compose-ci-pipelines"]?.recordStore).toBe("terraform/estate.chdf.hcl");
    expect(index["multi-region"]?.source).toBe("lex00/aws-bench@e8c259c23efe1a0805595ac9a340c178b427c1d3:benchmarks/arms/terraform-ec2-multiregion");
  });

  it("covers the example pipelines and the multi-region estate, each with a claim choudoufu can cite", () => {
    for (const id of ["tg-compose-cross-estate", "tg-compose-ci-pipelines", "tg-compose-terragrunt", "tg-compose-atmos", "multi-region"]) {
      const doc = JSON.parse(readFileSync(scenarioPath(id), "utf8")) as { claim: string; break: { overlay?: string } };
      expect(doc.claim, id).toMatch(/^[a-z]+\/[a-z-]+$/);
      expect(doc.break.overlay, id).toBe("break");
    }
  });

  it("drives ci-pipelines through its own gate: the approval, then the run again applying once", () => {
    const doc = JSON.parse(readFileSync(scenarioPath("tg-compose-ci-pipelines"), "utf8")) as { claim: string; steps: Array<{ id: string; command?: string[]; expect?: unknown[] }> };
    expect(doc.claim).toBe("choudoufu/ci-pipelines");
    const by = new Map(doc.steps.map((s) => [s.id, s]));
    expect(by.get("checked")!.command).toEqual(["stack/harness/check.sh", "pr-run", "add-log-group", "success", "live-check.yml"]);
    expect(by.get("planned")!.command).toEqual(["stack/harness/check.sh", "pr-run", "add-log-group", "success", "live-plan.yml"]);
    expect(by.get("gated")!.expect).toContainEqual({ ledger: { op: "live-apply", status: "gated" } });
    expect(by.get("approved")!.command).toEqual(["stack/harness/check.sh", "chant-approve", "live-apply", "approve-live-apply"]);
    expect(by.get("applied")!.expect).toContainEqual({ ledger: { op: "live-apply", status: "ok", count: 1 } });
    const ids = doc.steps.map((s) => s.id);
    expect(ids.indexOf("approved")).toBeGreaterThan(ids.indexOf("gated"));
    expect(ids.indexOf("applied")).toBeGreaterThan(ids.indexOf("approved"));
    const brk = overlayFiles(scenarioPath("tg-compose-ci-pipelines"), "break");
    expect(brk["terraform/break.tf"]).toMatch(/ignore_changes = \[tags\]/);
  });

  it("knows every check.sh command a scenario runs", () => {
    const check = readFileSync(join(stack, "harness", "check.sh"), "utf8");
    for (const id of scenarioIds()) {
      const doc = JSON.parse(readFileSync(scenarioPath(id), "utf8")) as { steps: Array<{ command?: string[] }> };
      for (const s of doc.steps) {
        if (s.command?.[0] !== "stack/harness/check.sh") continue;
        expect(check, `${id} ${s.command[1]}`).toMatch(new RegExp(`^  (?:[a-z0-9-]+\\|)*${s.command[1]}(?:\\|[a-z0-9-]+)*\\)`, "m"));
      }
    }
  });

  it("names the choudoufu its tree's workflows download as the row's engine", () => {
    const seed = readFileSync(join(stack, "harness", "seed.sh"), "utf8");
    expect(seed).toContain("choudoufu/releases/download/v[0-9]+");
    expect(seed).toContain(`jq -r '.recordStore // empty'`);
  });

  it("reads a tree: overlay from the seeded base, and refuses one before there is a base", () => {
    const base = mkdtempSync(join(tmpdir(), "tg-base-"));
    execFileSync("mkdir", ["-p", join(base, "scenarios", "act", "pull", "app")]);
    execFileSync("sh", ["-c", `printf 'x' > "${join(base, "scenarios", "act", "pull", "app", "main.tf")}"`]);
    expect(overlayFiles(scenarioPath("tg-compose-terragrunt"), "tree:scenarios/act/pull", base)).toEqual({ "app/main.tf": "x" });
    expect(() => overlayFiles(scenarioPath("tg-compose-terragrunt"), "tree:scenarios/act/pull")).toThrow(/seeded base/);
  });

  it("refuses a scenario with no claim, no BREAK arm, or a plan step", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-scenario-"));
    const bad = join(dir, "tg-bad", "scenario.json");
    execFileSync("mkdir", ["-p", join(dir, "tg-bad")]);
    execFileSync("sh", ["-c", `cat > "${bad}"`], {
      input: JSON.stringify({ $schema: "x", contract: 1, id: "tg-bad", product: "terragucci", tree: { base: "." }, reportUrl: "s3://b/p", steps: [{ id: "p", do: "plan", pull: "x" }] }),
    });
    const msgs = localFindings(bad, { "tg-bad": { binary: "tofu", needs: [], cites: [] } }).map((f) => f.message).join("\n");
    expect(msgs).toContain("no claim id");
    expect(msgs).toContain("no BREAK arm");
    expect(msgs).toContain("plan is not a step a terragucci pipeline completes");
    expect(msgs).toContain("no step expects anything");
  });

  it("plays each template scenario on the fixture registry, a product opening the pull request the driver merges", () => {
    const index = readIndex();
    const ids = ["tg-template-app", "tg-template-addon", "tg-agent-request", "tg-template-upgrade", "tg-behold-request", "tg-behold-addon", "tg-behold-action"];
    const fixture = join(stack, "harness", "fixtures", "templates", "registry");
    const catalog = JSON.parse(readFileSync(join(fixture, "catalog", "index.json"), "utf8")) as { components: { fields: { terraform: { address: string } }; versions: { version: string; attestation: { state: string } }[] }[] };
    expect(catalog.components.map((c) => c.fields.terraform.address)).toEqual(["modules.harness.local/acme/bucket/aws", "modules.harness.local/acme/cache/aws", "modules.harness.local/acme/app/aws"]);
    expect(catalog.components[0]!.versions.map((v) => `${v.version} ${v.attestation.state}`)).toEqual(["1.4.0 unsigned", "1.3.0 signed", "1.2.0 signed"]);
    for (const v of ["1.2.0", "1.3.0", "1.4.0"]) {
      expect(readFileSync(join(fixture, "v1", "modules", "acme", "bucket", "aws", v, "download"), "utf8")).toContain(`git::http://forgejo:3000/@REPO@.git//registry/src/bucket/${v}`);
      expect(existsSync(join(fixture, "src", "bucket", v, "main.tf"))).toBe(true);
    }
    expect(readFileSync(join(fixture, "tofurc"), "utf8")).toContain('"modules.v1" = "http://forgejo:3000/@REPO@/raw/branch/main/registry/v1/modules/"');
    expect(readFileSync(join(fixture, "terraformrc"), "utf8")).toContain('"modules.v1" = "http://template-registry:8080/@REPO@/v1/modules/"');
    expect(readFileSync(join(stack, "docker-compose.yml"), "utf8")).toMatch(/template-registry:\n[\s\S]*?profiles: \[templates\][\s\S]*?\.\/harness\/template-registry\.mjs:\/srv\/template-registry\.mjs:ro/);
    for (const id of ids) {
      expect(index[id]?.fixtures, id).toEqual(["templates"]);
      const doc = JSON.parse(readFileSync(scenarioPath(id), "utf8")) as { steps: Array<{ id: string; do: string; pull?: string; command?: string[] }> };
      const awaited = doc.steps.filter((s) => s.do === "await-pull").map((s) => s.id);
      // An action opens no pull request; every other template scenario's product opens one.
      expect(awaited.length > 0, id).toBe(id !== "tg-behold-action");
      for (const m of doc.steps.filter((s) => s.do === "merge")) expect(awaited, id).toContain(m.pull);
      expect(doc.steps.some((s) => s.do === "open"), id).toBe(false);
      const config = readFileSync(join(stack, "harness", "scenarios", id, "base", "terragucci.yml"), "utf8");
      // OpenTofu reads the repo's registry files from Forgejo; Terraform needs the template-registry service's X-Terraform-Get.
      const terraform = index[id]!.binary === "terraform";
      expect(config, id).toContain(`TF_CLI_CONFIG_FILE: \${{ github.workspace }}/registry/${terraform ? "terraformrc" : "tofurc"}`);
      expect(index[id]!.needs.includes("profile:templates"), id).toBe(terraform);
      expect(config, id).toContain("dir: registry");
    }
    // A merge may name an await-pull step, and nothing else but an open.
    const dir = mkdtempSync(join(tmpdir(), "tg-scenario-"));
    const file = join(dir, "tg-awaits", "scenario.json");
    execFileSync("mkdir", ["-p", join(dir, "tg-awaits", "base")]);
    const steps = [{ id: "ask", do: "out-of-band", command: ["true"], expect: [{ exit: 0 }] }, { id: "pull", do: "await-pull", branch: "request/bucket/orders" }, { id: "m", do: "merge", pull: "pull" }, { id: "n", do: "merge", pull: "ask" }];
    execFileSync("sh", ["-c", `cat > "${file}"`], { input: JSON.stringify({ $schema: "https://intentius.io/chant/schemas/e2e-harness/e2e-scenario/v1/e2e-scenario.schema.json", contract: 1, id: "tg-awaits", product: "terragucci", claim: "c", tree: { base: "base" }, reportUrl: "s3://b/p", steps, break: { env: { BREAK: "1" } } }) });
    const found = localFindings(file, { "tg-awaits": { binary: "tofu", needs: [], cites: [], fixtures: ["nope"] } });
    expect(found.map((f) => `${f.at} ${f.message}`)).toEqual(["/tree/base index.json's fixture nope is not a directory of stack/harness/fixtures", "/steps/3/pull merge names ask, which is not an earlier open or await-pull step"]);
  });

  it("lints with the harness's own lint when chant has it, and its own otherwise", () => {
    const r = spawnSync(join(root, "node_modules", ".bin", "tsx"), [join(stack, "harness", "harness.ts"), "lint"], { cwd: root, encoding: "utf8" });
    expect(r.stderr).toMatch(/harness lint: (\d+) of \1 scenario\(s\) hold/);
    expect(r.status).toBe(0);
  });
});

describe("smoke verdicts as claim rows", () => {
  const line = (t: string) => parseSmokeLine(`[smoke] noise\n${t}\n`);
  const times = { plain: { started: "2026-10-28T00:00:00.000Z", ended: "2026-10-28T00:01:00.000Z" }, break: { started: "2026-10-28T00:01:00.000Z", ended: "2026-10-28T00:02:00.000Z" } };

  it("reads the last SMOKE line of a log", () => {
    expect(line("SMOKE claim=tips/moved verdict=pass seconds=12")).toEqual({ claim: "tips/moved", verdict: "pass", detail: "seconds=12" });
    expect(parseSmokeLine("nothing here")).toBeNull();
  });

  it("maps the plain and BREAK lines to the row's verdicts", () => {
    expect(plainVerdict(line("SMOKE claim=a/b verdict=pass"))).toBe("pass");
    expect(plainVerdict(line("SMOKE claim=a/b verdict=fail"))).toBe("fail");
    expect(plainVerdict(null)).toBe("fail");
    expect(breakVerdict(line("SMOKE claim=a/b verdict=caught seconds=3"))).toBe("caught");
    expect(breakVerdict(line("SMOKE claim=a/b verdict=fail seconds=3 break=not-caught"))).toBe("missed");
    expect(breakVerdict(line("SMOKE claim=a/b verdict=fail seconds=3 break=setup-failed"))).toBe("stalled");
    expect(breakVerdict(line("SMOKE claim=a/b verdict=fail stalled: no output for 17 minutes"))).toBe("stalled");
    expect(breakVerdict(null)).toBe("stalled");
  });

  it("makes one claim run with an arm per run, held and broke when the row holds", () => {
    const run = smokeClaimRun({ scenario: "smoke-choudoufu", claim: "tips/moved", plain: line("SMOKE claim=tips/moved verdict=pass"), break: line("SMOKE claim=tips/moved verdict=caught"), times });
    expect(run.verdicts).toEqual({ plain: "pass", break: "caught" });
    expect(run.plain.outcome).toBe("held");
    expect(run.break.outcome).toBe("broke");
    expect(run.plain.steps[0]!.stopped).toBeUndefined();
    expect(run.break.steps[0]!.stopped).toEqual({ outcome: "broke", reason: "verdict=caught" });
    expect(run.break.ended).toBe(times.break.ended);
  });

  it("records a missed BREAK as held and a stall as stalled", () => {
    const missed = smokeClaimRun({ scenario: "smoke", claim: "a/b", plain: line("SMOKE claim=a/b verdict=pass"), break: line("SMOKE claim=a/b verdict=fail break=not-caught"), times });
    expect([missed.break.outcome, missed.verdicts.break]).toEqual(["held", "missed"]);
    const stalled = smokeClaimRun({ scenario: "smoke", claim: "a/b", plain: line("SMOKE claim=a/b verdict=fail stalled: no output"), break: null, times });
    expect([stalled.plain.outcome, stalled.break.outcome, stalled.verdicts.break]).toEqual(["stalled", "stalled", "stalled"]);
  });

  it("names a row's scenario by its forge and binary", () => {
    expect(smokeScenario({ binary: "tofu", forge: "forgejo" })).toBe("smoke");
    expect(smokeScenario({ binary: "choudoufu", forge: "forgejo" })).toBe("smoke-choudoufu");
    expect(smokeScenario({ binary: "tofu", forge: "gitlab" })).toBe("smoke-gitlab");
  });
});

describe("each smoke row's engine, from its claim", () => {
  const smoke = readFileSync(join(stack, "smoke.sh"), "utf8");
  const table = parseClaimsTable(/\nCLAIMS='([^']*)'/.exec(smoke)![1]!);
  // The rows choudoufu's live/smoke/claims.json cites as product-scenario proofs
  // from terragucci's default (OpenTofu) record (choudoufu#2301).
  const cited = ["choudoufu/rows-overlap", "choudoufu/concurrency", "choudoufu/rows-wait", "choudoufu/rows-takeover", "choudoufu/killed", "choudoufu/migrate", "choudoufu/iam", "choudoufu/shared-bucket", "choudoufu/record-versions", "drift/choudoufu"];

  /** A fake --record log directory: each claim's plain and BREAK verdict files. */
  function fakeLogs(claims: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "tg-smoke-logs-"));
    for (const c of claims) {
      const base = join(dir, c.replace(/\//g, "."));
      writeFileSync(`${base}.plain.verdict`, `SMOKE claim=${c} verdict=pass seconds=1\n`);
      writeFileSync(`${base}.break.verdict`, `SMOKE claim=${c} verdict=caught seconds=1\n`);
    }
    return dir;
  }

  it("reads the claim table smoke.sh holds", () => {
    expect(table.get("choudoufu/rows-overlap")).toMatch(/^with binary: choudoufu two pushes/);
    expect(table.get("tips/moved")).toBeDefined();
    expect(parseClaimsTable("a/b|says one|needs\nc/d|says two|\n\n")).toEqual(new Map([["a/b", "says one"], ["c/d", "says two"]]));
  });

  it("names the binary a claim's text says it runs on, and only a known one", () => {
    expect(saysBinary("with binary: choudoufu a role granted one estate")).toBe("choudoufu");
    expect(saysBinary("in a Terragrunt repo with binary: terraform the pipeline installs Terraform")).toBe("terraform");
    expect(saysBinary("with binary: pulumi a thing")).toBeUndefined();
    expect(saysBinary("the example boots")).toBeUndefined();
    expect(saysBinary(undefined)).toBeUndefined();
  });

  it("gives every claim choudoufu cites choudoufu at the CI image's pinned version in a tofu record", () => {
    const logs = fakeLogs([...cited, "tips/moved", "boot/tofu"]);
    const rows = smokeRows(logs, { scenario: "smoke", binary: "tofu", version: "v1.13.1", claims: table, pins: TOOL_VERSIONS });
    const by = new Map(rows.map((r) => [r.claim, r.engine]));
    for (const c of cited) expect(by.get(c), c).toEqual({ binary: "choudoufu", version: TOOL_VERSIONS.choudoufu });
    expect(by.get("tips/moved")).toEqual({ binary: "tofu", version: "1.13.1" });
    expect(by.get("boot/tofu")).toEqual({ binary: "tofu", version: "1.13.1" });
    expect(rows.map((r) => r.run.verdicts)).toEqual(rows.map(() => ({ plain: "pass", break: "caught" })));
  });

  it("reads the choudoufu version from the pin the CI image is built from", () => {
    const dockerfile = readFileSync(join(root, "images", "Dockerfile.choudoufu"), "utf8");
    expect(dockerfile).toContain(`choudoufu ${TOOL_VERSIONS.choudoufu} and the terragucci engine`);
    expect(dockerfile).toContain(`/download/v${TOOL_VERSIONS.choudoufu}/`);
  });

  it("keeps the run's binary under SMOKE_BINARY=choudoufu, and without a claim table", () => {
    const logs = fakeLogs(["drift/tofu", "choudoufu/iam"]);
    const cdf = smokeRows(logs, { scenario: "smoke-choudoufu", binary: "choudoufu", version: "v0.31.0", claims: table, pins: { choudoufu: "9.9.9" } });
    expect(cdf.map((r) => r.engine)).toEqual([{ binary: "choudoufu", version: "0.31.0" }, { binary: "choudoufu", version: "0.31.0" }]);
    const bare = smokeRows(logs, { scenario: "smoke", binary: "tofu", version: "1.13.1", pins: TOOL_VERSIONS });
    expect(bare.map((r) => r.engine.binary)).toEqual(["tofu", "tofu"]);
  });

  it("refuses a claim whose binary has no pin, and writes a version bare", () => {
    expect(() => rowEngine({ says: "with binary: choudoufu x", binary: "tofu", version: "1.13.1", pins: {} })).toThrow(/no pinned version for choudoufu/);
    expect(rowEngine({ says: "with binary: terraform x", binary: "tofu", version: "1.13.1", pins: { terraform: "v1.14.9" } })).toEqual({ binary: "terraform", version: "1.14.9" });
    expect(bareVersion("v0.18.0")).toBe("0.18.0");
    expect(bareVersion("1.13.1")).toBe("1.13.1");
  });

  it("skips a claim with no BREAK verdict or a pending plain one", () => {
    const logs = fakeLogs(["choudoufu/iam"]);
    writeFileSync(join(logs, "tips.moved.plain.verdict"), "SMOKE claim=tips/moved verdict=pass\n");
    writeFileSync(join(logs, "a.b.plain.verdict"), "SMOKE claim=a/b verdict=pending\n");
    writeFileSync(join(logs, "a.b.break.verdict"), "SMOKE claim=a/b verdict=caught\n");
    expect(smokeRows(logs, { scenario: "smoke", binary: "tofu", version: "1.13.1", claims: table, pins: TOOL_VERSIONS }).map((r) => r.claim)).toEqual(["choudoufu/iam"]);
  });

  it("passes the run's claim table to harness.ts record", () => {
    expect(smoke).toContain(`printf '%s\\n' "$CLAIMS" >"$SMOKE_LOG_DIR/claims.table"`);
    expect(smoke).toContain('--claims "$SMOKE_LOG_DIR/claims.table"');
  });
});

describe("smoke.sh on the harness", () => {
  const smoke = readFileSync(join(stack, "smoke.sh"), "utf8");

  it("runs moved, import and sensitive on every binary", () => {
    const core = /\nBINARY_CLAIMS='([^']*)'/.exec(smoke)![1]!.split(/\s+/);
    for (const c of ["tips/moved", "respond/drift", "report/sensitive"]) expect(core).toContain(c);
    for (const binary of ["terraform", "choudoufu"]) {
      const listed = execFileSync("bash", [join(stack, "smoke.sh"), "--list"], { encoding: "utf8", env: { ...process.env, SMOKE_FORGE: "forgejo", SMOKE_BINARY: binary } });
      for (const c of ["tips/moved", "respond/drift", "report/sensitive"]) expect(listed, `${binary} ${c}`).toMatch(new RegExp(`^${c} function=yes group=yes$`, "m"));
    }
  });

  it("has a claim that plans an estate twice and compares the bytes", () => {
    const listed = execFileSync("bash", [join(stack, "smoke.sh"), "--list"], { encoding: "utf8" });
    expect(listed).toMatch(/^choudoufu\/plan-bytes function=yes group=yes$/m);
  });

  it("starts each run through chant e2e safe-run when chant has it, and fails a run the scan rejects", () => {
    expect(smoke).toContain('${SMOKE_SAFE_RUN[@]+"${SMOKE_SAFE_RUN[@]}"} "$BASH" "$HERE/smoke.sh" "$name"');
    expect(smoke).toContain('SMOKE_SAFE_RUN=("$CHANT" e2e safe-run --scan "$SMOKE_LOG_DIR" --)');
    expect(smoke).toMatch(/grep -q '\^REAL-CLOUD CALL'/);
    expect(smoke).toContain("harness_rows\n");
  });
});

describe("the terralith, for scale alone", () => {
  it("runs the scale bench only when dispatched, never on a release", () => {
    const wf = readFileSync(join(root, ".github", "workflows", "scale.yml"), "utf8");
    expect(wf).toContain("workflow_dispatch:");
    // An event is a key of on:, two spaces in; the dispatch's release input is deeper.
    expect(wf).not.toMatch(/^ {2}release:/m);
    expect(wf).not.toContain("github.event.release");
  });
});
