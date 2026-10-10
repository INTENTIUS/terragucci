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

  it("leaves an env with no shared cache as it is", () => {
    const none = { KEEP: "1" };
    expect(rootCacheEnv(none, root(), "terraform")).toBe(none);
  });
});
