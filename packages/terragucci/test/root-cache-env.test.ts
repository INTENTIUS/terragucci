import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lockCovers, rootCacheEnv } from "../src/report/stage";

// #737: a root whose lock file does not pin its providers at the binary's own
// registry would download them again at init, over the cached copy other
// roots' plans are running; it takes the cached copy instead.
const lock = (...providers: string[]) => providers.map((p) => `provider "${p}" {\n  version = "6.0.0"\n}\n`).join("\n");
const root = (text?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "tg-cache-"));
  if (text !== undefined) writeFileSync(join(dir, ".terraform.lock.hcl"), text);
  return dir;
};
const env = { TF_PLUGIN_CACHE_DIR: "/cache", KEEP: "1" };

describe("rootCacheEnv", () => {
  it("keeps the shared cache when the lock pins every provider at the binary's registry", () => {
    expect(rootCacheEnv(env, root(lock("registry.terraform.io/hashicorp/aws")), "terraform")).toEqual(env);
    expect(rootCacheEnv(env, root(lock("registry.opentofu.org/hashicorp/aws", "registry.opentofu.org/hashicorp/random")), "tofu")).toEqual(env);
    expect(rootCacheEnv(env, root(lock("registry.opentofu.org/hashicorp/aws")), "choudoufu")).toEqual(env);
  });

  it("keeps the shared cache for a root with no lock file and takes providers from it", () => {
    expect(rootCacheEnv(env, root(), "terraform")).toEqual({ ...env, TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE: "true" });
    expect(lockCovers(root(), "terraform")).toBe(false);
  });

  it("does the same when the lock names another registry, as an OpenTofu lock does for Terraform", () => {
    expect(rootCacheEnv(env, root(lock("registry.opentofu.org/hashicorp/aws")), "terraform").TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE).toBe("true");
    expect(lockCovers(root(lock("registry.opentofu.org/hashicorp/aws", "registry.terraform.io/hashicorp/random")), "terraform")).toBe(false);
    expect(rootCacheEnv(env, root(lock("registry.terraform.io/hashicorp/aws")), "tofu").TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE).toBe("true");
  });

  it("counts a lock with no providers as covering a root of only the built-in provider, and no other root", () => {
    const empty = "# This file is maintained automatically by \"tofu init\".\n# Manual edits may be lost in future updates.\n";
    const withTf = (tf: string) => {
      const dir = root(empty);
      writeFileSync(join(dir, "main.tf"), tf);
      return dir;
    };
    const builtin = 'terraform {\n  required_version = ">= 1.13"\n}\n\ndata "terraform_remote_state" "n" {\n  backend = "s3"\n}\n\nresource "terraform_data" "x" {\n  input = 1\n}\n';
    expect(lockCovers(withTf(builtin), "tofu")).toBe(true);
    expect(rootCacheEnv(env, withTf(builtin), "tofu")).toEqual(env);
    expect(lockCovers(withTf(`${builtin}resource "aws_s3_bucket" "b" {}\n`), "tofu")).toBe(false);
    expect(lockCovers(withTf(`${builtin}module "m" {\n  source = "./m"\n}\n`), "tofu")).toBe(false);
    expect(lockCovers(withTf(`${builtin}provider "random" {}\n`), "tofu")).toBe(false);
    expect(lockCovers(withTf('terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws" }\n  }\n}\n'), "tofu")).toBe(false);
    expect(lockCovers(root(empty), "tofu")).toBe(false);
  });

  it("leaves an env with no shared cache as it is", () => {
    const none = { KEEP: "1" };
    expect(rootCacheEnv(none, root(), "terraform")).toBe(none);
  });
});
