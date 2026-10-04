import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { init } from "../src/init";
import { MARKER } from "../src/render";
import { git, tmp, twoRootRepo, write } from "./helpers";

function withRemote(remote: string): string {
  const dir = twoRootRepo();
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", remote);
  return dir;
}

describe("init", () => {
  it.each([
    ["https://github.com/acme/infra.git", ".github/workflows/terragucci.yml"],
    ["git@gitlab.com:acme/infra.git", ".gitlab-ci.yml"],
    ["https://codeberg.org/acme/infra.git", ".forgejo/workflows/terragucci.yml"],
  ])("a repo whose origin is %s gets %s", async (remote, path) => {
    const dir = withRemote(remote);
    const r = await init(dir, { binary: "tofu" });
    expect(r.files.map((f) => [f.path.slice(dir.length + 1), f.status])).toEqual([[path, "created"], ["chant.workspace.json", "created"]]);
    const text = readFileSync(join(dir, path), "utf-8");
    expect(text.startsWith(MARKER)).toBe(true);
    const parsed = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining(path === ".gitlab-ci.yml" ? ["stages", "check", "apply-wave-1"] : ["name", "on", "jobs"]));
  });

  it("the pipeline applies the network before the app, and validates both", async () => {
    const dir = withRemote("https://github.com/acme/infra.git");
    const r = await init(dir, { binary: "tofu" });
    expect(r.layers).toEqual([["network"], ["app"]]);
    const text = readFileSync(r.files[0].path, "utf-8");
    expect(text).toContain("for dir in 'app' 'network'; do");
    // One job per wave: the network's wave first, and the app's needs it.
    expect(text).toContain("terragucci stage tf-apply --wave 1 --layers 'network;app'");
    expect(text).toContain("terragucci stage tf-apply --wave 2 --layers 'network;app'");
    expect(text).toMatch(/apply-wave-2:\n(?:.*\n)*? {4}needs: apply-wave-1\n/);
  });

  it("a second run changes nothing", async () => {
    const dir = withRemote("https://github.com/acme/infra.git");
    await init(dir, { binary: "tofu" });
    const again = await init(dir, { binary: "tofu" });
    expect(again.files.map((f) => f.status)).toEqual(["unchanged", "unchanged"]);
  });

  it("refuses to overwrite a pipeline file it did not write, unless forced", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { ".github/workflows/terragucci.yml": "name: mine\n" });
    await expect(init(dir, { binary: "tofu" })).rejects.toThrow(/terragucci did not write it/);
    const forced = await init(dir, { binary: "tofu", force: true });
    expect(forced.files[0].status).toBe("updated");
  });

  it("an undetectable forge needs --forge, which is then saved to terragucci.yml", async () => {
    const dir = withRemote("https://git.example.com/acme/infra.git");
    await expect(init(dir)).rejects.toThrow(/pass --forge/);
    const r = await init(dir, { forge: "gitlab" });
    expect(r.configNote).toMatch(/records forge/);
    expect(readFileSync(join(dir, "terragucci.yml"), "utf-8")).toBe("forge: gitlab\n");
    expect((await init(dir)).files.map((f) => f.status)).toEqual(["unchanged", "unchanged"]);
  });

  it("a detectable choice is not written to terragucci.yml", async () => {
    const dir = withRemote("https://github.com/acme/infra.git");
    const r = await init(dir, { forge: "github" });
    expect(r.configNote).toBe("no terragucci.yml needed (defaults fit)");
    expect(existsSync(join(dir, "terragucci.yml"))).toBe(false);
  });

  it("terragucci.yml roots, binary, version and env reach the pipeline", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), {
      "terragucci.yml": 'roots: ["network"]\nbinary: terraform\nversion: "1.14.0"\nenv:\n  AWS_REGION: eu-west-1\n',
    });
    const r = await init(dir);
    expect(r.roots).toEqual(["network"]);
    const text = readFileSync(r.files[0].path, "utf-8");
    expect(text).toContain("ghcr.io/intentius/terragucci-terraform:");
    expect(text).not.toContain("terragucci install");
    expect(text).toContain("AWS_REGION: eu-west-1");
    expect(text).not.toContain("'app'");
  });

  it("the canary wave and the gate policy reach the apply jobs", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": 'gate: always\nwaves:\n  canary: ["app"]\n' });
    const r = await init(dir, { binary: "tofu" });
    expect(r.notes.join("\n")).not.toMatch(/gated waves/);
    const text = readFileSync(r.files[0].path, "utf-8");
    expect(text).toContain("terragucci stage tf-apply --wave 1 --layers 'network;app' --canary 'app' --binary tofu --gate always");
    expect(text).toContain("apply-wave-2:");
    expect(text).not.toContain("apply-wave-3:");
  });

  it("chant.workspace.json lists every wave gate under identity.gates, so each needs a sealed approval", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": 'waves:\n  canary: ["app"]\n' });
    await init(dir, { binary: "tofu" });
    expect(JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf-8"))).toEqual({
      name: "infra",
      schema: 1,
      minReader: "0.102.0",
      members: [],
      identity: { gates: { "wave-1": {}, "wave-2": {}, "wave-3": {} } },
    });
  });

  it("an existing chant.workspace.json keeps what it has and gains the gates it lacks", async () => {
    const mine = { name: "shop", schema: 1, minReader: "0.90.0", members: [{ name: "app", path: "app" }], identity: { gates: { "wave-1": { class: "human" } } } };
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "chant.workspace.json": JSON.stringify(mine) });
    const r = await init(dir, { binary: "tofu" });
    expect(r.files.map((f) => f.status)).toEqual(["created", "updated"]);
    expect(JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf-8"))).toEqual({
      ...mine,
      minReader: "0.102.0",
      identity: { gates: { "wave-1": { class: "human" }, "wave-2": {} } },
    });
    expect((await init(dir, { binary: "tofu" })).files.map((f) => f.status)).toEqual(["unchanged", "unchanged"]);
  });

  it("a repo with no roots is an error that says what a root is", async () => {
    const dir = write(tmp(), { "README.md": "x" });
    await expect(init(dir, { forge: "github" })).rejects.toThrow(/backend or a provider block/);
  });

  it("a control repo config is refused", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": "projects:\n  github.com/a/b: {}\n" });
    await expect(init(dir)).rejects.toThrow(/run terragucci reconcile instead/);
  });
});

describe("describeInit", async () => {
  const { describeInit } = await import("../src/init");
  it("a dry run says would write, and writes nothing", async () => {
    const dir = withRemote("https://github.com/acme/infra.git");
    const r = await init(dir, { binary: "tofu", dryRun: true });
    expect(describeInit(dir, r, true)).toContain("would write .github/workflows/terragucci.yml");
    expect(existsSync(join(dir, ".github"))).toBe(false);
  });
});
