// waves.after: an order plain roots state in terragucci.yml, beside the one their
// terraform_remote_state reads give, read by every command that reads the reads.
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reachedRoots, type Git } from "../src/comment-apply";
import { resolveRepo, validateConfig } from "../src/config";
import { applyLayers, explicitOrder, rootOrder } from "../src/detect";
import { WAVES_AFTER_NOT_ATMOS, WAVES_AFTER_NOT_TERRAGRUNT, WAVES_AFTER_NOT_TERRAMATE } from "../src/refusals";
import { affectedRoots, runStage } from "../src/report/stage";
import { renderNote } from "../src/report/views";
import { detectShape } from "../src/shape";
import { backend, remoteState, tmp, validate, write } from "./helpers";
import { plan as planJson, rc } from "./report-fixtures";

const REPORT_SCHEMA = JSON.parse(readFileSync(join(import.meta.dirname, "../src/report/report.schema.json"), "utf-8"));

/** A tofu that plans each root's plan.json, and finds no state where never-applied is. */
function fakeTofu(dir: string): string {
  const path = join(dir, "tofu");
  writeFileSync(path, `#!/bin/sh
chdir="\${1#-chdir=}"; shift
case "$1" in
  init) exit 0 ;;
  state) if [ -f "$chdir/never-applied" ]; then exit 0; fi; echo '{"version":4,"resources":[],"outputs":{}}'; exit 0 ;;
  plan) for a in "$@"; do case "$a" in -out=*) cp "$chdir/plan.json" "\${a#-out=}" ;; esac; done; echo "Plan: 0 to add, 1 to change, 0 to destroy."; exit 0 ;;
  show) if [ "$2" = "-json" ]; then cat "$3"; else echo "plan text for $chdir"; fi ;;
esac
`);
  chmodSync(path, 0o755);
  return path;
}

const ROOTS = ["app", "database", "network"];
const CHAIN = { app: ["database"], database: ["network"] };

/** Three roots that read nothing of each other. */
function plainRepo(): string {
  return write(tmp(), Object.fromEntries(ROOTS.map((r) => [`${r}/main.tf`, backend(`${r}.tfstate`)])));
}

function committed(dir: string): (files: Record<string, string>) => void {
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "base");
  return (files) => {
    write(dir, files);
    git("commit", "-qam", "change");
  };
}

describe("waves.after", () => {
  it("orders roots that read nothing of each other into one wave each", () => {
    const dir = plainRepo();
    expect(applyLayers(dir, ROOTS)).toEqual([ROOTS]);
    expect(applyLayers(dir, ROOTS, CHAIN)).toEqual([["network"], ["database"], ["app"]]);
  });

  it("joins the order the reads give", () => {
    const dir = write(tmp(), {
      "network/main.tf": backend("network.tfstate"),
      "database/main.tf": backend("database.tfstate") + remoteState("network.tfstate"),
      "app/main.tf": backend("app.tfstate"),
    });
    const order = rootOrder(dir, ROOTS, { app: ["database"] });
    expect([...order.get("app")!]).toEqual(["database"]);
    expect([...order.get("database")!]).toEqual(["network"]);
    expect(applyLayers(dir, ROOTS, { app: ["database"] })).toEqual([["network"], ["database"], ["app"]]);
  });

  it("matches globs on either side, and a glob that matches the root it orders skips it", () => {
    const roots = ["envs/dev/app", "envs/dev/network", "envs/prod/app", "envs/prod/network", "shared"];
    const order = explicitOrder({ "envs/*/app": ["envs/*/network", "shared"], "envs/**": ["shared"] }, roots);
    expect([...order.get("envs/dev/app")!].sort()).toEqual(["envs/dev/network", "envs/prod/network", "shared"]);
    expect([...order.get("envs/prod/network")!]).toEqual(["shared"]);
    expect(order.has("shared")).toBe(false);
  });

  it("refuses a key or an upstream that matches no root, naming each", () => {
    expect(() => explicitOrder({ app: ["databse"], "web/*": ["network"] }, ROOTS)).toThrow(/waves\.after names "databse", "web\/\*", which match no root; the roots are app, database, network/);
  });

  it("refuses a root named after itself", () => {
    expect(() => explicitOrder({ app: ["app"] }, ROOTS)).toThrow(/waves\.after puts app after itself/);
  });

  it("refuses a cycle, naming the roots in it", () => {
    const dir = plainRepo();
    expect(() => applyLayers(dir, ROOTS, { ...CHAIN, network: ["app"] })).toThrow(/waves\.after puts these roots in a cycle: (app after database after network after app|database after network after app after database|network after app after database after network)/);
  });

  it("refuses a cycle that a read closes", () => {
    const dir = write(tmp(), { "network/main.tf": backend("network.tfstate") + remoteState("app.tfstate"), "app/main.tf": backend("app.tfstate") });
    expect(() => applyLayers(dir, ["app", "network"], { app: ["network"] })).toThrow(/waves\.after puts these roots in a cycle/);
  });

  it("is a map of a root or glob to a list of roots or globs", () => {
    expect(() => validateConfig({ waves: { after: ["app"] } }, "t")).toThrow(/waves\.after must map a root or glob/);
    expect(() => validateConfig({ waves: { after: { app: "database" } } }, "t")).toThrow(/waves\.after\.app must be a list of roots or globs/);
    expect(() => validateConfig({ waves: { after: { app: [] } } }, "t")).toThrow(/waves\.after\.app must be a list of roots or globs/);
    expect(validateConfig({ waves: { after: CHAIN } }, "t")).toEqual({ waves: { after: CHAIN } });
  });

  it("is refused in a Terragrunt, Atmos or Terramate repo, naming the order that repo states", () => {
    const settings = resolveRepo({ waves: { after: CHAIN } });
    const tg = write(tmp(), { "root.hcl": "", "app/terragrunt.hcl": "" });
    expect(detectShape(tg, settings).problems()).toContain(`config.waves.after: ${WAVES_AFTER_NOT_TERRAGRUNT}`);
    const atmos = write(tmp(), { "atmos.yaml": "" });
    expect(detectShape(atmos, settings).problems()).toContain(`config.waves.after: ${WAVES_AFTER_NOT_ATMOS}`);
    const tm = write(tmp(), { "terramate.tm.hcl": "", "app/main.tf": backend("app.tfstate") });
    expect(detectShape(tm, settings).problems()).toContain(`config.waves.after: ${WAVES_AFTER_NOT_TERRAMATE}`);
    expect(detectShape(tm, settings).after).toBeUndefined();
    expect(() => validateConfig({ terragrunt: {}, waves: { after: CHAIN } }, "t")).toThrow(/waves\.after: a Terragrunt unit's order is its dependency and dependencies blocks/);
    expect(detectShape(plainRepo(), settings).problems()).toEqual([]);
  });

  it("orders the waves discovery cuts, with the order beside the reads", async () => {
    const shape = detectShape(plainRepo(), resolveRepo({ waves: { after: CHAIN } }));
    expect(shape.after).toEqual(CHAIN);
    const found = await shape.discover();
    expect(found.layers).toEqual([["network"], ["database"], ["app"]]);
    expect(found.reads.get("app")!.size).toBe(0);
    expect([...found.order.get("app")!]).toEqual(["database"]);
    expect(found.notes).toEqual(["waves.after orders app after database; database after network"]);
  });

  it("a cycle or an unknown root fails discovery", async () => {
    await expect(detectShape(plainRepo(), resolveRepo({ waves: { after: { ...CHAIN, network: ["app"] } } })).discover()).rejects.toThrow(/cycle/);
    await expect(detectShape(plainRepo(), resolveRepo({ waves: { after: { app: ["dns"] } } })).discover()).rejects.toThrow(/"dns", which matches no root/);
  });

  it("a change to a root plans every root it puts after it, followed through", () => {
    const dir = plainRepo();
    const commit = committed(dir);
    commit({ "network/main.tf": backend("network.tfstate") + "# moved\n" });
    const lines: string[] = [];
    expect([...affectedRoots(dir, "HEAD~1", ROOTS, ROOTS, (l) => lines.push(l), CHAIN)!].sort()).toEqual(ROOTS);
    expect(lines).toContain("affected: database depends on network");
    expect(lines).toContain("affected: app depends on database");
    expect([...affectedRoots(dir, "HEAD~1", ROOTS, ROOTS, () => {})!]).toEqual(["network"]);
    commit({ "app/main.tf": backend("app.tfstate") + "# moved\n" });
    expect([...affectedRoots(dir, "HEAD~1", ROOTS, ROOTS, () => {}, CHAIN)!]).toEqual(["app"]);
  });

  it("a pull request's locks take the roots it puts after a reached root", () => {
    const dir = plainRepo();
    const commit = committed(dir);
    commit({ "database/main.tf": backend("database.tfstate") + "# moved\n" });
    const git: Git = (args) => {
      try {
        return { status: 0, stdout: execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" }), stderr: "" };
      } catch (e) {
        return { status: 1, stdout: "", stderr: String(e) };
      }
    };
    expect(reachedRoots(dir, git, "HEAD~1", "HEAD", [ROOTS], CHAIN)).toEqual(["app", "database"]);
    expect(reachedRoots(dir, git, "HEAD~1", "HEAD", [ROOTS])).toEqual(["database"]);
  });

  it("a plan run cuts the waves, reports the order, and puts the roots after a changed root in its blast radius", async () => {
    const changes = JSON.stringify(planJson([rc("terraform_data.this", ["update"], { input: "1" }, { input: "2" })]));
    const repo = write(tmp(), {
      "terragucci.yml": "gate: always\nwaves:\n  after:\n    app: [net]\n",
      "net/main.tf": backend("net.tfstate"),
      "net/plan.json": changes,
      // Nothing applied net yet: app reads none of its state, so it plans all the same.
      "net/never-applied": "",
      "app/main.tf": backend("app.tfstate"),
      "app/plan.json": JSON.stringify(planJson([])),
    });
    const logs: string[] = [];
    const { report } = await runStage("tf-plan", repo, { binary: fakeTofu(tmp()), out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, (l) => logs.push(l));
    expect(validate(REPORT_SCHEMA, report)).toEqual([]);
    expect(logs.some((l) => l.includes("held back"))).toBe(false);
    expect(report.waves.map((w) => [w.number, w.roots, w.reads])).toEqual([[1, ["net"], undefined], [2, ["app"], [1]]]);
    expect(report.roots.find((r) => r.path === "app")!.dependencies).toEqual(["net"]);
    expect(report.roots.find((r) => r.path === "app")!.reads).toBeUndefined();
    expect(report.blast).toEqual({ roots: ["net"], downstream: [{ root: "app", reads: ["net"], depth: 1, wave: 2, planned: true }] });
    const note = renderNote(report);
    expect(note).toContain("**Blast radius:** 1 root changes (`net`), and 1 root downstream reads their state or applies after them:");
    expect(note).toContain("(wave 2) applies after `net`");
  });
});
