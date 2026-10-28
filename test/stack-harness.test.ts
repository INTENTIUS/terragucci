// The validation stack on chant's e2e harness (terragucci#1295): the forge
// services under the stack's names, the fallback file that stands in on a
// chant without the harness, the gate between them, the scenarios' lint, and
// smoke.sh's verdicts as claim rows. Nothing here starts a container.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { breakVerdict, parseSmokeLine, plainVerdict, smokeClaimRun, smokeScenario } from "../stack/harness/rows";
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
    expect(index["multi-region"]?.source).toBe("lex00/aws-bench@e8c259c23efe1a0805595ac9a340c178b427c1d3:benchmarks/arms/terraform-ec2-multiregion");
  });

  it("covers the example pipelines and the multi-region estate, each with a claim choudoufu can cite", () => {
    for (const id of ["tg-compose-cross-estate", "tg-compose-terragrunt", "tg-compose-atmos", "multi-region"]) {
      const doc = JSON.parse(readFileSync(scenarioPath(id), "utf8")) as { claim: string; break: { overlay?: string } };
      expect(doc.claim, id).toMatch(/^[a-z]+\/[a-z-]+$/);
      expect(doc.break.overlay, id).toBe("break");
    }
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
