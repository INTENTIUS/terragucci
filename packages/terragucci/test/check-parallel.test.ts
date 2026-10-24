import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitCheck } from "../src/check";
import { checkScript } from "../src/render";

describe("checkScript runs the roots at once", () => {
  it("a single root, or parallelism 1, keeps the serial loop", () => {
    for (const s of [checkScript("tofu", ["a"]), checkScript("tofu", ["a", "b"], undefined, false, false, false, false, false, 1)]) {
      expect(s).toContain('  terragucci check-root "$dir" --binary tofu || failed=1');
      expect(s).not.toContain("tg_check");
    }
  });

  it("several roots start in the background and print in root order", () => {
    const s = checkScript("choudoufu", ["app", "edge", "network"]);
    expect(s).toContain("tg_check() {");
    expect(s).toContain("&\n");
    expect(s).not.toContain("tgpid$((n-"); // no bound: all at once
    expect(s).toContain("\nwait\n");
    expect(s.split("\n").filter((l) => l.startsWith("for dir in 'app' 'edge' 'network'"))).toHaveLength(2);
  });

  it("parallelism bounds how many run, and a bound past the roots is all of them", () => {
    expect(checkScript("tofu", ["a", "b", "c"], undefined, false, false, false, false, false, 2)).toContain('if [ "$n" -gt 2 ]; then eval "wait \\$tgpid$((n-2))"');
    expect(checkScript("tofu", ["a", "b"], undefined, false, false, false, false, false, 5)).not.toContain("-gt");
  });

  it("with check-sources and root pins, a root that is refused returns instead of continuing", () => {
    const s = checkScript("tofu", ["a", "b"], undefined, true, false, false, true);
    expect(s).toContain('terragucci check-sources "$dir" || return 1');
    expect(s).toContain('--binary tofu)" || return 1');
    expect(s).not.toContain("continue");
  });

  it("the rendered script is valid sh, keeps root order, fails on one failed root and merges the parts in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-par-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tofu"), "#!/bin/sh\nsleep 0.2\n");
    writeFileSync(join(bin, "terragucci"), '#!/bin/sh\nif [ "$1" = check-root ]; then sleep 0.2; echo "checked $2"; echo "### $2" >> "$TERRAGUCCI_CHECK_PART"; [ "$2" = b ] && exit 1; fi\nexit 0\n');
    chmodSync(join(bin, "tofu"), 0o755);
    chmodSync(join(bin, "terragucci"), 0o755);
    const script = join(dir, "check.sh");
    writeFileSync(script, checkScript("tofu", ["a", "b", "c"], undefined, false, false, false, false, false, 2));
    execFileSync("sh", ["-n", script]);
    const r = spawnSync("sh", [script], { cwd: dir, encoding: "utf-8", env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("checked a\nchecked b\nchecked c\n");
    expect(readFileSync(join(dir, "terragucci-check/report.md"), "utf-8")).toBe("### a\n### b\n### c\n");
  });
});

describe("emitCheck with TERRAGUCCI_CHECK_PART", () => {
  it("writes the part and leaves the shared report and summary alone", () => {
    const repo = mkdtempSync(join(tmpdir(), "tg-emit-"));
    const part = join(repo, "1.md");
    const summary = join(repo, "summary.md");
    appendFileSync(summary, "");
    emitCheck(repo, { ok: true, log: [], report: ["### x"] }, { TERRAGUCCI_CHECK_PART: part, GITHUB_STEP_SUMMARY: summary });
    expect(readFileSync(part, "utf-8")).toBe("### x\n");
    expect(readFileSync(summary, "utf-8")).toBe("");
    expect(existsSync(join(repo, "terragucci-check/report.md"))).toBe(false);
  });
});
