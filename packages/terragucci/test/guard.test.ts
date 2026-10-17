import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRepo } from "../src/config";
import { CLAUDE_SETTINGS, GUARD_BINARIES, withHook, writeGuard } from "../src/guard";
import { backend, git, tmp, write } from "./helpers";

/** A repo with two pipeline roots and a directory that is not one, and the guard written into it with stand-ins for the real binaries. */
function guarded() {
  const repo = write(tmp(), { "envs/dev/app/main.tf": backend("dev/app"), "envs/prod/app/main.tf": backend("prod/app"), "modules/net/main.tf": 'variable "cidr" {}\n', "README.md": "x\n" });
  git(repo, "init", "-q", "-b", "main");
  const real = tmp();
  const log = join(real, "calls.log");
  for (const b of GUARD_BINARIES) {
    writeFileSync(join(real, b), `#!/bin/sh\necho "${b} $*" >> ${JSON.stringify(log)}\nexit 0\n`);
    chmodSync(join(real, b), 0o755);
  }
  const g = writeGuard({ repo, settings: resolveRepo({}) });
  const run = (bin: string, args: string[], cwd = repo) => {
    const r = spawnSync(join(g.bin, bin), args, { cwd, encoding: "utf-8", env: { ...process.env, PATH: `${g.bin}:${real}:${process.env.PATH ?? ""}` } });
    return { status: r.status, stderr: r.stderr, ran: existsSync(log) ? readFileSync(log, "utf-8") : "" };
  };
  const hook = (command: string, cwd = repo) => {
    const r = spawnSync(process.execPath, [g.script, "hook"], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }), encoding: "utf-8" });
    return { status: r.status, stderr: r.stderr };
  };
  return { repo, g, run, hook, log };
}

describe("terragucci guard: the wrappers", () => {
  it("writes the wrappers and the script under the git directory, guarding the pipeline's roots", () => {
    const { repo, g } = guarded();
    expect(g.roots).toEqual(["envs/dev/app", "envs/prod/app"]);
    expect(g.dir).toBe(join(git(repo, "rev-parse", "--absolute-git-dir").trim(), "terragucci", "guard"));
    for (const b of GUARD_BINARIES) expect(existsSync(join(g.bin, b))).toBe(true);
    expect(g.path).toBe(`export PATH="${g.bin}:$PATH"`);
    // Nothing the guard wrote shows up for a commit.
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).not.toMatch(/terragucci\/guard|settings\.local\.json/);
  });

  it("refuses apply, destroy and -auto-approve in a pipeline root, naming propose, and runs nothing", () => {
    const { repo, run } = guarded();
    const root = join(repo, "envs/prod/app");
    for (const args of [["apply"], ["destroy"], ["apply", "-auto-approve"], ["plan", "-auto-approve"], ["import", "aws_s3_bucket.b", "b"], ["state", "rm", "aws_s3_bucket.b"], ["state", "mv", "a", "b"], ["state", "push", "x.tfstate"]]) {
      const r = run("tofu", args, root);
      expect(r.status, args.join(" ")).not.toBe(0);
      expect(r.stderr).toContain("terragucci guard: tofu");
      expect(r.stderr).toContain("in envs/prod/app, a root of this repo's pipeline");
      expect(r.stderr).toContain("the propose tool of terragucci mcp --propose");
    }
    expect(run("terraform", ["-chdir=envs/dev/app", "apply"]).status).not.toBe(0);
    expect(run("tofu", ["-chdir", "envs/dev/app", "destroy"]).status).not.toBe(0);
    expect(run("tofu", ["apply"], root).ran).toBe("");
  });

  it("passes init, validate, fmt, plan and state reads through to the real binary in a root", () => {
    const { repo, run } = guarded();
    const root = join(repo, "envs/prod/app");
    for (const args of [["init"], ["validate"], ["fmt", "-check"], ["plan", "-out=tfplan"], ["state", "list"], ["show", "-json"]]) expect(run("tofu", args, root).status, args.join(" ")).toBe(0);
    expect(run("tofu", ["version"], root).ran).toBe(["tofu init", "tofu validate", "tofu fmt -check", "tofu plan -out=tfplan", "tofu state list", "tofu show -json", "tofu version", ""].join("\n"));
  });

  it("passes every command through outside the pipeline's roots", () => {
    const { repo, run } = guarded();
    for (const cwd of [repo, join(repo, "modules/net"), tmp()]) {
      expect(run("tofu", ["apply", "-auto-approve"], cwd).status, cwd).toBe(0);
      expect(run("terraform", ["destroy"], cwd).status, cwd).toBe(0);
    }
    expect(run("tofu", ["version"]).ran.split("\n").filter(Boolean)).toHaveLength(7);
  });

  it("refuses terragrunt's --all and run-all apply from a directory that holds a root, and its plan", () => {
    const { repo, run } = guarded();
    expect(run("terragrunt", ["run", "--all", "apply"], join(repo, "envs")).status).not.toBe(0);
    expect(run("terragrunt", ["run-all", "destroy"]).status).not.toBe(0);
    expect(run("terragrunt", ["apply"], join(repo, "envs/dev/app")).status).not.toBe(0);
    expect(run("terragrunt", ["run", "--all", "plan"], join(repo, "envs")).status).toBe(0);
    // Without --all, terragrunt applies the directory it runs in, which is no root here.
    expect(run("terragrunt", ["apply"], join(repo, "envs")).status).toBe(0);
  });
});

describe("terragucci guard: the hook", () => {
  it("writes a PreToolUse hook into Claude Code's local settings, kept out of commits, and keeps what else the file holds", () => {
    const { repo, g } = guarded();
    const settings = JSON.parse(readFileSync(join(repo, CLAUDE_SETTINGS), "utf-8"));
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: `"${process.execPath}" "${g.script}" hook` }] }]);
    expect(readFileSync(join(repo, ".git/info/exclude"), "utf-8")).toContain(`/${CLAUDE_SETTINGS}`);
    writeFileSync(join(repo, CLAUDE_SETTINGS), JSON.stringify({ ...settings, permissions: { allow: ["Bash(ls)"] } }));
    writeGuard({ repo, settings: resolveRepo({}) });
    const again = JSON.parse(readFileSync(join(repo, CLAUDE_SETTINGS), "utf-8"));
    expect(again.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(again.hooks.PreToolUse).toHaveLength(1);
    expect(readFileSync(join(repo, ".git/info/exclude"), "utf-8").split(`/${CLAUDE_SETTINGS}`)).toHaveLength(2);
  });

  it("blocks the same commands in the agent's Bash tool with exit 2, following cd and sh -c", () => {
    const { repo, hook } = guarded();
    for (const [command, cwd] of [
      ["cd envs/prod/app && tofu apply", repo],
      ["tofu -chdir=envs/dev/app destroy", repo],
      ["AWS_PROFILE=prod terraform apply -auto-approve", join(repo, "envs/prod/app")],
      ["bash -c 'cd envs/dev/app; tofu apply'", repo],
      ["/usr/local/bin/tofu state rm aws_s3_bucket.b", join(repo, "envs/dev/app")],
      ["npx terragucci approve wave-1 --plan sha256:abc", repo],
      ["npx -y @intentius/terragucci override envs/prod/app --rule r --reason x", repo],
      ["npx @intentius/terragucci@0.4.35 pr-merge --pr 7 --sha abc", repo],
      ["terragucci stage tf-apply --wave 1 --layers envs/prod/app", repo],
      ["npx terragucci rollout net --mode apply", repo],
    ] as const) {
      const r = hook(command, cwd);
      expect(r.status, command).toBe(2);
      expect(r.stderr).toContain("propose");
    }
  });

  it("lets plans, reads and everything outside the repo's roots through", () => {
    const { repo, hook } = guarded();
    for (const [command, cwd] of [
      ["cd envs/prod/app && tofu init && tofu plan -out=p", repo],
      ["tofu apply", repo],
      ["tofu apply -auto-approve", tmp()],
      ["git commit -m 'apply the fix'", repo],
      ["echo apply", join(repo, "envs/prod/app")],
      ["npx terragucci plan --json", repo],
    ] as const) expect(hook(command, cwd).status, command).toBe(0);
    expect(spawnSync(process.execPath, [join(repo, ".git/terragucci/guard/guard.mjs"), "hook"], { input: "not json", encoding: "utf-8" }).status).toBe(0);
  });

  it("refuses to rewrite a settings file that is not JSON", () => {
    expect(() => withHook("{ nope", "x", CLAUDE_SETTINGS)).toThrow(/is not JSON/);
    expect(JSON.parse(withHook(undefined, "x", CLAUDE_SETTINGS)).hooks.PreToolUse[0].hooks[0].command).toBe("x");
  });
});
