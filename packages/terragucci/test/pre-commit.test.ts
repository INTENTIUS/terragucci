import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { overrideChantNext, type ChantCheckHook, type ChantCheckHooks, type ChantCheckHooksReport } from "../src/chant-next";
import { ConfigError, validateConfig } from "../src/config";
import { init } from "../src/init";
import { checkHooks, checkHooksResult, namesCheckHooks, PRE_COMMIT_HOOK, preCommitHook, preCommitScript, withoutPreCommitHook, withPreCommitHook } from "../src/pre-commit";
import { withCheckHooks } from "../src/render";
import { git, twoRootRepo, write } from "./helpers";

/** A stand-in for chant's check moment: the writer puts the hook in the file as chant's does, and the runner reports what it is told. */
function fakeChant(report?: Partial<ChantCheckHooksReport>, seen: unknown[] = []): ChantCheckHooks {
  return {
    CI_CHECK_HOOK_FLOOR: "0.124.55",
    writeCiHook(root: string, _moment: "check", hook: ChantCheckHook) {
      const file = join(root, "chant.workspace.json");
      const doc = JSON.parse(readFileSync(file, "utf-8"));
      const list: ChantCheckHook[] = doc.ci?.hooks?.check ?? [];
      const at = list.findIndex((h) => h.name === hook.name);
      const next = at < 0 ? [...list, hook] : list.map((h, i) => (i === at ? hook : h));
      doc.ci = { ...doc.ci, hooks: { ...doc.ci?.hooks, check: next } };
      writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
      return { file, replaced: at >= 0 };
    },
    runCheckHooks(options) {
      seen.push(options);
      return { version: 1, moment: "check", base: options.base, targets: [...(options.targets ?? [])], status: "none", hooks: [], ...report };
    },
  };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("check.pre_commit", () => {
  it("is a boolean under check, and check takes no other key", () => {
    expect(() => validateConfig({ check: { pre_commit: true } }, "terragucci.yml")).not.toThrow();
    const problems = (raw: unknown): string[] => {
      try {
        validateConfig(raw, "terragucci.yml");
        return [];
      } catch (e) {
        return (e as ConfigError).problems ?? [(e as Error).message];
      }
    };
    expect(problems({ check: { pre_commit: "yes" } })).toContain("config.check.pre_commit must be true or false");
    expect(problems({ check: { tflint: true } })).toContain("config.check.tflint is not a setting (settings: pre_commit)");
    expect(problems({ check: true })).toContain("config.check must be a map (settings: pre_commit)");
  });

  it("runs pre-commit over the change with PCT_TFPATH set to the binary and terraform_fmt skipped", () => {
    const hook = preCommitHook("choudoufu");
    expect(hook.name).toBe(PRE_COMMIT_HOOK);
    expect(hook.command.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(hook.perRun).toBeUndefined();
    const script = preCommitScript("choudoufu");
    expect(script).toContain('PCT_TFPATH="$(command -v choudoufu)"');
    expect(script).toContain('SKIP="terraform_fmt${SKIP:+,$SKIP}"');
    expect(script).toContain('pre-commit run --from-ref "$base" --to-ref HEAD');
    expect(script).toContain("pre-commit run --all-files");
    // No {plan} and no {target}: chant's check moment refuses both on a hook that runs once.
    expect(hook.command.join(" ")).not.toMatch(/\{plan\}|\{target\}/);
  });

  it("tells a declaration with check hooks from one without", () => {
    expect(namesCheckHooks(undefined)).toBe(false);
    expect(namesCheckHooks('{"name":"x","schema":1,"members":[]}')).toBe(false);
    expect(namesCheckHooks('{"ci":{"hooks":{"check":[{"command":["tflint"]}]}},"members":[]}')).toBe(true);
    expect(namesCheckHooks('{"members":[{"name":"a","ci":{"hooks":{"check":[{"command":["tflint"]}]}}}]}')).toBe(true);
    expect(namesCheckHooks("not json")).toBe(false);
  });

  it("adds the hook with chant's writer, raises minReader, and replaces it on the next init", () => {
    const before = `${JSON.stringify({ name: "infra", schema: 1, minReader: "0.102.0", members: [] }, null, 2)}\n`;
    const once = withPreCommitHook(fakeChant(), "chant.workspace.json", before, "tofu");
    const doc = JSON.parse(once);
    expect(doc.minReader).toBe("0.124.55");
    expect(doc.ci.hooks.check).toEqual([preCommitHook("tofu")]);
    const twice = withPreCommitHook(fakeChant(), "chant.workspace.json", once, "terraform");
    expect(JSON.parse(twice).ci.hooks.check).toEqual([preCommitHook("terraform")]);
  });

  it("drops only its own hook when the preset is turned off", () => {
    const text = JSON.stringify({ name: "infra", members: [], ci: { hooks: { check: [preCommitHook("tofu"), { name: "tflint", command: ["tflint", "--recursive"] }] } } });
    expect(JSON.parse(withoutPreCommitHook(text)!).ci.hooks.check).toEqual([{ name: "tflint", command: ["tflint", "--recursive"] }]);
    const alone = JSON.stringify({ name: "infra", members: [], ci: { hooks: { check: [preCommitHook("tofu")] } } });
    expect(JSON.parse(withoutPreCommitHook(alone)!).ci).toBeUndefined();
    expect(withoutPreCommitHook(JSON.stringify({ name: "infra", members: [] }))).toBeUndefined();
  });

  it("puts check-hooks last in tf-check: counted with the rest in a plain check, the last line of a Terragrunt one", () => {
    const plain = withCheckHooks('set -eu\nfailed=0\nexit "$failed"', "tofu", ["a", "b"], { preCommit: true }, false);
    expect(plain.split("\n").slice(-2)).toEqual(["terragucci check-hooks --binary tofu --pre-commit --targets 'a,b' || failed=1", 'exit "$failed"']);
    const tg = withCheckHooks("set -eu\nterragucci check-policy", "terraform", ["live/a"], { preCommit: false }, true);
    expect(tg.split("\n").at(-1)).toBe("terragucci check-hooks --binary terraform --targets 'live/a'");
    expect(withCheckHooks("body", "tofu", ["a"], undefined, false)).toBe("body");
  });

  it("runs the hooks through chant's check moment at base when the installed chant has it", async () => {
    const seen: unknown[] = [];
    const chant = fakeChant({ status: "passed", hooks: [{ name: PRE_COMMIT_HOOK, exit: 0, outcome: "passed" }] }, seen);
    const ran: string[][] = [];
    const result = await checkHooks(twoRootRepo(), { base: "origin/main", targets: ["a", "b"], binary: "tofu", preCommit: true, chant, exec: (argv) => (ran.push(argv), 0), log: () => {} });
    expect(result.ok).toBe(true);
    expect(seen).toMatchObject([{ base: "origin/main", targets: ["a", "b"], dir: "terragucci-check/hooks" }]);
    // chant ran the hook; terragucci ran nothing of its own.
    expect(ran).toEqual([]);
    expect(result.report).toContain("- passed: `terragucci-pre-commit`");
  });

  it("says so when the base's declaration does not carry the preset's hook yet", async () => {
    const result = await checkHooks(twoRootRepo(), { base: "origin/main", targets: [], binary: "tofu", preCommit: true, chant: fakeChant(), log: () => {} });
    expect(result.ok).toBe(true);
    expect(result.log.join("\n")).toContain(`has no ${PRE_COMMIT_HOOK} check hook, so pre-commit does not run`);
  });

  it("fails the check when chant reports a failed hook", async () => {
    const chant = fakeChant({ status: "failed", hooks: [{ name: "tflint", exit: 2, outcome: "failed" }], failed: "a check hook failed: tflint" });
    const result = await checkHooks(twoRootRepo(), { base: "origin/main", targets: [], binary: "tofu", preCommit: false, chant, log: () => {} });
    expect(result.ok).toBe(false);
    expect(result.log).toContain("FAILED check hooks: a check hook failed: tflint");
  });

  it("runs the preset itself, without forge tokens, on a chant with no check moment", async () => {
    const ran: { argv: string[]; env: Record<string, string> }[] = [];
    const env = { PATH: "/usr/bin", GITHUB_TOKEN: "secret", TG_TOKEN: "secret", TF_TOKEN_app_terraform_io: "secret", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret" };
    const result = await checkHooks(twoRootRepo(), { base: "origin/main", targets: [], binary: "choudoufu", preCommit: true, chant: null, env, exec: (argv, _cwd, e) => (ran.push({ argv, env: e }), 1) });
    expect(result.ok).toBe(false);
    expect(ran).toHaveLength(1);
    expect(ran[0]!.argv).toEqual(preCommitHook("choudoufu").command);
    expect(ran[0]!.env).toEqual({ PATH: "/usr/bin", CHANT_HOOKS_BASE: "origin/main" });
  });

  it("runs nothing on a chant with no check moment when the preset is off", async () => {
    const result = await checkHooks(twoRootRepo(), { base: "origin/main", targets: [], binary: "tofu", preCommit: false, chant: null, exec: () => {
      throw new Error("ran");
    } });
    expect(result).toEqual({ ok: true, log: [], report: [] });
  });

  it("reports nothing when no check hook is declared", () => {
    expect(checkHooksResult({ base: "HEAD", status: "none", hooks: [] })).toEqual({ ok: true, log: [], report: [] });
  });
});

describe("init with check.pre_commit", () => {
  const repo = (config: string, files: Record<string, string> = {}): string => {
    const dir = write(twoRootRepo(), { "terragucci.yml": config, ...files });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "https://github.com/acme/infra.git");
    return dir;
  };

  it("mentions the preset when it finds .pre-commit-config.yaml, and never turns it on", async () => {
    const dir = repo("binary: tofu\n", { ".pre-commit-config.yaml": "repos: []\n" });
    const r = await init(dir, { binary: "tofu" });
    expect(r.notes.some((n) => n.startsWith("tip: .pre-commit-config.yaml is here; set check.pre_commit: true"))).toBe(true);
    expect(readFileSync(join(dir, ".github/workflows/terragucci.yml"), "utf-8")).not.toContain("terragucci check-hooks");
  });

  it("writes the hook into chant.workspace.json with chant's writer and runs check-hooks in tf-check", async () => {
    restore = overrideChantNext("checkHooks", fakeChant());
    const dir = repo("binary: tofu\ncheck:\n  pre_commit: true\n", { ".pre-commit-config.yaml": "repos: []\n" });
    const r = await init(dir, { binary: "tofu" });
    const decl = JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf-8"));
    expect(decl.ci.hooks.check).toEqual([preCommitHook("tofu")]);
    expect(decl.minReader).toBe("0.124.55");
    const pipeline = readFileSync(join(dir, ".github/workflows/terragucci.yml"), "utf-8");
    expect(pipeline).toContain("terragucci check-hooks --binary tofu --pre-commit");
    expect(pipeline).toContain("fetch-depth: 0");
    expect(r.notes.some((n) => n.startsWith("tip:"))).toBe(false);
    // The second init changes nothing.
    const again = await init(dir, { binary: "tofu" });
    expect(again.files.every((f) => f.status === "unchanged")).toBe(true);
  });

  it("writes no hook on a chant without the check moment, and tf-check runs the preset itself", async () => {
    restore = overrideChantNext("checkHooks", null);
    const dir = repo("binary: tofu\ncheck:\n  pre_commit: true\n");
    const r = await init(dir, { binary: "tofu" });
    expect(r.files.some((f) => f.path.endsWith("chant.workspace.json"))).toBe(false);
    expect(r.notes.some((n) => n.includes("the installed chant has no ci.hooks.check moment"))).toBe(true);
    expect(readFileSync(join(dir, ".github/workflows/terragucci.yml"), "utf-8")).toContain("terragucci check-hooks --binary tofu --pre-commit");
  });
});
