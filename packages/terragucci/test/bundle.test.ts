// The released shape (terragucci#18): dist/terragucci.mjs alone, copied where no
// node_modules can be found, does everything the source does.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bareFrom, git, tmp, twoRootRepo, write } from "./helpers";

const DIST = join(import.meta.dirname, "../dist/terragucci.mjs");
const EXAMPLE = join(import.meta.dirname, "../../../example");

/** The bundle, alone in a fresh directory: nothing to resolve a package from. */
function isolated(): string {
  const dir = tmp("terragucci-bundle-");
  copyFileSync(DIST, join(dir, "terragucci.mjs"));
  return join(dir, "terragucci.mjs");
}

function runIn(cwd: string, bin: string, ...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf-8" });
}

describe.skipIf(!existsSync(DIST))("the bundle", () => {
  it("init in the example with no terragucci.yml writes the example's own pipeline", () => {
    const repo = tmp();
    cpSync(EXAMPLE, repo, { recursive: true });
    rmSync(join(repo, "terragucci.yml"));
    const r = runIn(repo, isolated(), "init");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("unchanged .forgejo/workflows/terragucci.yml");
    expect(readFileSync(join(repo, ".forgejo/workflows/terragucci.yml"), "utf-8")).toBe(
      readFileSync(join(EXAMPLE, ".forgejo/workflows/terragucci.yml"), "utf-8"),
    );
  });

  it("reconcile dry-runs a GitHub, a GitLab and a Forgejo project, and a broken one fails alone", () => {
    const control = write(tmp(), {
      "terragucci.yml": [
        "defaults:",
        "  binary: tofu",
        "projects:",
        `  github.com/acme/infra:\n    url: ${bareFrom(twoRootRepo())}`,
        `  gitlab.example.com/platform/network:\n    url: ${bareFrom(twoRootRepo())}`,
        `  codeberg.org/acme/edge:\n    url: ${bareFrom(twoRootRepo())}`,
        "  github.com/acme/missing:\n    url: /nonexistent/repo.git",
        "",
      ].join("\n"),
    });
    const r = runIn(control, isolated(), "reconcile", "--config", "terragucci.yml");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("github.com/acme/infra: would write new .github/workflows/terragucci.yml");
    expect(r.stdout).toContain("gitlab.example.com/platform/network: would write new .gitlab-ci.yml");
    expect(r.stdout).toContain("codeberg.org/acme/edge: would write new .forgejo/workflows/terragucci.yml");
    expect(r.stdout).toMatch(/github\.com\/acme\/missing: FAILED/);
    expect(r.stdout).toContain("dry run: 3 of 4 would change; nothing was written");
  });

  it("a terragucci.ts with no TypeScript folder installed names the install command", () => {
    const repo = write(twoRootRepo(), { "terragucci.ts": 'export default { binary: "tofu" };\n' });
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", "https://github.com/acme/infra.git");
    const r = runIn(repo, isolated(), "init", "--dry-run");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("npm i -D @intentius/tsad-reference");
  });

  it("a module rollout with no HCL parser installed names the install command", () => {
    const repo = twoRootRepo();
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", "https://github.com/acme/infra.git");
    const r = runIn(repo, isolated(), "rollout", "modules/network", "1.4.0");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("npm i -D @cdktn/hcl2json");
  });

  it("with the TypeScript folder installed, the bundle folds a terragucci.ts", () => {
    const repo = write(twoRootRepo(join(import.meta.dirname, "../.tmp-ts-config")), { "terragucci.ts": 'export default { binary: "terraform" };\n' });
    try {
      execFileSync("git", ["-C", repo, "init", "-q"]);
      execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/acme/infra.git"]);
      // Run the bundle from inside the package, where @intentius/tsad-reference resolves.
      const r = runIn(repo, DIST, "init", "--dry-run");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("terraform");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
