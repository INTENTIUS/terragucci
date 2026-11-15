// A root's required_version range against the version its job runs: what init and config check say.
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import { init } from "../src/init";
import { rangeConflicts, satisfies } from "../src/version-range";
import { tmp, write } from "./helpers";

const root = (range: string) => `terraform {\n  required_version = "${range}"\n}\nprovider "aws" {}\n`;

describe("satisfies", () => {
  it("reads pessimistic, bounded and negated clauses", () => {
    expect(satisfies("1.14.9", "~> 1.5.0")).toBe(false);
    expect(satisfies("1.5.7", "~> 1.5.0")).toBe(true);
    expect(satisfies("1.14.9", "~> 1.5")).toBe(true);
    expect(satisfies("2.0.0", "~> 1.5")).toBe(false);
    expect(satisfies("1.14.9", ">= 1.3, < 1.10")).toBe(false);
    expect(satisfies("1.9.0", ">= 1.3, < 1.10, != 1.9.0")).toBe(false);
    expect(satisfies("1.13.1", "1.13.1")).toBe(true);
    expect(satisfies("1.13.1", "not a range")).toBeUndefined();
  });
});

describe("rangeConflicts", () => {
  it("names each root whose range excludes the job's version and leaves the others", () => {
    const repo = write(tmp(), { "old/main.tf": root("~> 1.5.0"), "wide/main.tf": root(">= 1.3"), "none/main.tf": "# no terraform block\n" });
    expect(rangeConflicts(repo, ["old", "wide", "none"], "terraform", undefined, "1.14.9")).toEqual([
      { root: "old", range: "~> 1.5.0", version: "1.14.9", fix: 'version: { "old": "1.5.0" }' },
    ]);
  });

  it("gives the range itself for tofu, and checks a root's own pin rather than the job's", () => {
    const repo = write(tmp(), { "old/main.tf": root("~> 1.5.0"), "pinned/main.tf": root("~> 1.5.0"), "pinned/.opentofu-version": "1.5.7\n" });
    const got = rangeConflicts(repo, ["old", "pinned"], "tofu", undefined, "1.13.1");
    expect(got.map((c) => c.root)).toEqual(["old"]);
    expect(got[0].fix).toContain("~> 1.5.0");
  });
});

describe("init and config check", () => {
  const files = { "terragucci.yml": "binary: terraform\nforge: github\n", "old/main.tf": root("~> 1.5.0"), "new/main.tf": root("~> 1.14.0") };

  it("init notes each root the job's version breaks, with the fix", async () => {
    const dir = write(tmp(), files);
    const res = await init(dir, { dryRun: true });
    expect(res.rangeConflicts).toEqual([{ root: "old", range: "~> 1.5.0", version: "1.14.9", fix: 'version: { "old": "1.5.0" }' }]);
    expect(res.notes.some((n) => n.startsWith("old requires ~> 1.5.0, which excludes 1.14.9"))).toBe(true);
  });

  it("config check warns the same and still passes", async () => {
    const dir = write(tmp(), files);
    const cwd = process.cwd();
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...x: unknown[]) => void lines.push(x.join(" ")));
    process.chdir(dir);
    let code: number;
    try {
      code = await main(["config", "check", "--json"]);
    } finally {
      process.chdir(cwd);
      log.mockRestore();
    }
    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n")).results.warnings).toEqual([expect.stringContaining("old requires ~> 1.5.0")]);
  });
});
