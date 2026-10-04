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
    expect(r.files.map((f) => [f.path.slice(dir.length + 1), f.status])).toEqual([[path, "created"]]);
    const text = readFileSync(join(dir, path), "utf-8");
    expect(text.startsWith(MARKER)).toBe(true);
    const parsed = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining(path === ".gitlab-ci.yml" ? ["stages", "check", "apply"] : ["name", "on", "jobs"]));
  });

  it("the pipeline applies the network before the app, and validates both", async () => {
    const dir = withRemote("https://github.com/acme/infra.git");
    const r = await init(dir, { binary: "tofu" });
    expect(r.layers).toEqual([["network"], ["app"]]);
    const text = readFileSync(r.files[0].path, "utf-8");
    expect(text).toContain("for dir in 'app' 'network'; do");
    expect(text.indexOf("apply_together 'network'")).toBeLessThan(text.indexOf("apply_together 'app'"));
  });

  it("a second run changes nothing", async () => {
    const dir = withRemote("https://github.com/acme/infra.git");
    await init(dir, { binary: "tofu" });
    const again = await init(dir, { binary: "tofu" });
    expect(again.files.map((f) => f.status)).toEqual(["unchanged"]);
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
    expect((await init(dir)).files.map((f) => f.status)).toEqual(["unchanged"]);
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

  it("settings the pipeline cannot act on yet are named", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": 'drift: "0 6 * * *"\nwaves:\n  canary: ["network"]\n' });
    const r = await init(dir, { binary: "tofu" });
    expect(r.notes.join("\n")).toMatch(/tf-drift is not built yet[\s\S]*gated waves are not built yet/);
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
