// The released shape (terragucci#18): dist/terragucci.mjs, copied where the only
// package beside it is its one runtime dependency, @intentius/chant (since
// terragucci#1281 the bundle imports chant core from it), does everything the
// source does.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chantHandover } from "../src/chant-next";
import { bareFrom, git, tmp, twoRootRepo, write } from "./helpers";

const DIST = join(import.meta.dirname, "../dist/terragucci.mjs");
const EXAMPLE = join(import.meta.dirname, "../../../example");

/** The installed @intentius/chant, as `npm i @intentius/terragucci` puts it beside the bundle. */
const CHANT = realpathSync(join(import.meta.dirname, "../../../node_modules/@intentius/chant"));

/** The bundle in a fresh directory with its one dependency: no other package resolves from it. */
function isolated(): string {
  const dir = tmp("terragucci-bundle-");
  copyFileSync(DIST, join(dir, "terragucci.mjs"));
  mkdirSync(join(dir, "node_modules/@intentius"), { recursive: true });
  symlinkSync(CHANT, join(dir, "node_modules/@intentius/chant"), "dir");
  return join(dir, "terragucci.mjs");
}

// A usage or config error exits 1 under chant's exit-code table (chant#4553), 2 before it.
const USAGE = 1;
/**
 * The example's pipeline as init renders it. The committed one is the published pin's; where the installed chant's
 * handover and checkout scripts take terragucci's parameters (chant#4554) the steps that check out and hand a report
 * on are chant's, kept in test/golden/chant-next/example-forgejo.yml (UPDATE_GOLDEN=1 rewrites it).
 */
const CHANT_STEPS = !!chantHandover();
const EXAMPLE_PIPELINE = CHANT_STEPS ? join(import.meta.dirname, "golden/chant-next/example-forgejo.yml") : join(EXAMPLE, ".forgejo/workflows/terragucci.yml");

function runIn(cwd: string, bin: string, ...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf-8" });
}

describe.skipIf(!existsSync(DIST))("the bundle", () => {
  it("init in the example with only its drift schedule and canary wave in terragucci.yml writes the example's own pipeline", () => {
    const repo = tmp();
    cpSync(EXAMPLE, repo, { recursive: true });
    // Everything else is found from the repo. A schedule and the canary wave are choices it cannot show, so they are kept.
    writeFileSync(join(repo, "terragucci.yml"), 'drift: "0 6 * * *"\nwaves:\n  canary: ["envs/dev/*"]\n');
    const r = runIn(repo, isolated(), "init");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`${CHANT_STEPS ? "updated" : "unchanged"} .forgejo/workflows/terragucci.yml`);
    const rendered = readFileSync(join(repo, ".forgejo/workflows/terragucci.yml"), "utf-8");
    if (CHANT_STEPS && process.env.UPDATE_GOLDEN) writeFileSync(EXAMPLE_PIPELINE, rendered);
    expect(rendered).toBe(readFileSync(EXAMPLE_PIPELINE, "utf-8"));
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
    expect(r.stdout).toContain("gitlab.example.com/platform/network: would write new .gitlab/terragucci.yml, new chant.config.ts, new .gitlab-ci.yml");
    expect(r.stdout).toContain("codeberg.org/acme/edge: would write new .forgejo/workflows/terragucci.yml");
    expect(r.stdout).toMatch(/github\.com\/acme\/missing: FAILED/);
    expect(r.stdout).toContain("dry run: 3 of 4 would change; nothing was written");
  });

  it("a terragucci.ts with no TypeScript folder installed names the install command", () => {
    const repo = write(twoRootRepo(), { "terragucci.ts": 'export default { binary: "tofu" };\n' });
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", "https://github.com/acme/infra.git");
    const r = runIn(repo, isolated(), "init", "--dry-run");
    expect(r.status).toBe(USAGE);
    expect(r.stderr).toContain("npm i -D @intentius/tsad-reference");
  });

  it("a module rollout with no HCL parser installed names the install command", () => {
    const repo = twoRootRepo();
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", "https://github.com/acme/infra.git");
    const r = runIn(repo, isolated(), "rollout", "modules/network", "1.4.0");
    expect(r.status).toBe(USAGE);
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
