import { describe, expect, it } from "vitest";
import { applyLayers, detectBinary, detectForge, detectVersion, findRoots, globMatch, hostOfRemote } from "../src/detect";
import { backend, git, remoteState, tmp, twoRootRepo, write } from "./helpers";

describe("roots", () => {
  it("a root declares a backend or configures a provider; a module with required_providers is not one", () => {
    expect(findRoots(twoRootRepo())).toEqual(["app", "network"]);
  });

  it("a cloud block or a bare provider makes a root; .terraform and hidden directories are skipped", () => {
    const dir = write(tmp(), {
      "a/main.tf": `terraform {\n  cloud {\n    organization = "x"\n  }\n}\n`,
      "b/main.tofu": `provider "aws" {\n  region = "us-east-1"\n}\n`,
      "b/.terraform/modules/x/main.tf": backend("x"),
      ".hidden/main.tf": backend("y"),
      "c/main.tf": `# provider "aws" {}\nresource "null_resource" "x" {}\n`,
    });
    expect(findRoots(dir)).toEqual(["a", "b"]);
  });

  it("globs choose the roots instead, among directories with Terraform files", () => {
    const dir = twoRootRepo();
    expect(findRoots(dir, ["modules/*"])).toEqual(["modules/svc"]);
    expect(findRoots(dir, ["*"])).toEqual(["app", "network"]);
  });

  it.each([
    ["envs/*/*", "envs/dev/orders", true],
    ["envs/*/*", "envs/dev", false],
    ["envs/**", "envs/dev/orders/x", true],
    ["**/orders", "envs/dev/orders", true],
    ["**/orders", "orders", true],
    ["./envs/dev/*", "envs/dev/a", true],
    ["envs/d?v/*", "envs/dev/a", true],
    ["envs/dev.x/*", "envs/devax/a", false],
  ])("glob %s against %s is %s", (glob, path, match) => {
    expect(globMatch(glob, path)).toBe(match);
  });
});

describe("order", () => {
  it("a root that reads another's state applies after it", () => {
    expect(applyLayers(twoRootRepo(), ["app", "network"])).toEqual([["network"], ["app"]]);
  });

  it("roots that share nothing apply together", () => {
    const dir = write(tmp(), { "a/main.tf": backend("a"), "b/main.tf": backend("b") });
    expect(applyLayers(dir, ["a", "b"])).toEqual([["a", "b"]]);
  });

  it("a cycle is refused by name", () => {
    const dir = write(tmp(), { "a/main.tf": backend("a") + remoteState("b"), "b/main.tf": backend("b") + remoteState("a") });
    expect(() => applyLayers(dir, ["a", "b"])).toThrow(/cycle: a, b/);
  });
});

describe("binary and version", () => {
  it.each([
    [{ ".opentofu-version": "1.13.1" }, "tofu", ".opentofu-version"],
    [{ ".terraform-version": "1.14.0" }, "terraform", ".terraform-version"],
    [{ "a/x.tofu": "" }, "tofu", ".tofu files"],
  ])("%j picks %s", (files, binary, reason) => {
    const dir = write(tmp(), { "a/main.tf": backend("a"), ...files });
    expect(detectBinary(dir, ["a"])).toEqual({ value: binary, reason });
  });

  it.each([
    ['required_version = "1.13.1"', "1.13.1"],
    ['required_version = "= 1.13.1"', "1.13.1"],
    ['required_version = "~> 1.13.0"', undefined],
    ['required_version = ">= 1.6"', undefined],
  ])("%s pins %s", (line, version) => {
    const dir = write(tmp(), { "a/main.tf": `terraform {\n  ${line}\n}\n` });
    expect(detectVersion(dir, ["a"])).toBe(version);
  });

  it("two roots pinning different versions pin nothing", () => {
    const dir = write(tmp(), { "a/main.tf": 'terraform {\n  required_version = "1.13.1"\n}\n', "b/main.tf": 'terraform {\n  required_version = "1.13.0"\n}\n' });
    expect(detectVersion(dir, ["a", "b"])).toBeUndefined();
  });
});

describe("forge", () => {
  it.each([
    ["https://github.com/acme/infra.git", "github.com"],
    ["git@gitlab.example.com:platform/net.git", "gitlab.example.com"],
    ["ssh://git@codeberg.org:22/acme/edge.git", "codeberg.org:22"],
    ["http://user:tok@localhost:3300/a/b.git", "localhost:3300"],
    ["", undefined],
  ])("%s has host %s", (remote, host) => {
    expect(hostOfRemote(remote)).toBe(host);
  });

  it.each([
    ["https://github.com/acme/infra.git", "github"],
    ["git@gitlab.com:acme/infra.git", "gitlab"],
    ["https://codeberg.org/acme/infra.git", "forgejo"],
  ])("the origin %s means %s", (remote, forge) => {
    const dir = tmp();
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", remote);
    expect(detectForge(dir)?.value).toBe(forge);
  });

  it("a workflow directory already in the repo wins over an unknown host", () => {
    const dir = write(tmp(), { ".forgejo/workflows/x.yml": "" });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "https://git.example.com/a/b.git");
    expect(detectForge(dir)).toEqual({ value: "forgejo", reason: ".forgejo/workflows" });
  });

  it("an unknown host with no workflow directory is undetected", () => {
    const dir = tmp();
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "https://git.example.com/a/b.git");
    expect(detectForge(dir)).toBeUndefined();
  });
});
