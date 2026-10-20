import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs script with no types
import { byVersion, releaseNotes } from "../scripts/github-release.mjs";

const root = join(import.meta.dirname, "..");
const page = readFileSync(join(root, "docs-site", "src", "content", "docs", "reference", "whats-new.mdx"), "utf8");

// A release's GitHub release carries its notes from the Changes page (just github-release).
describe("github-release", () => {
  it("takes a version's own section and nothing of the next, with the docs' links made absolute", () => {
    const notes: string = releaseNotes(page, "0.4.8");
    expect(notes).toContain("`npx @intentius/terragucci@0.4.8 init`");
    expect(notes).toContain("](https://intentius.io/terragucci/reference/threat-model/#re-plan)");
    expect(notes).not.toMatch(/\]\(\/terragucci\//);
    expect(notes).not.toContain("## In 0.4.7");
    expect(notes.trim().endsWith("lists every release.")).toBe(true);
  });

  it("has notes for every release from 0.4.8 on, the ones the Changes pages link", () => {
    const versions = [...page.matchAll(/^## In (\d+\.\d+\.\d+)$/gm)].map((m) => m[1]);
    expect(versions).toContain("0.4.8");
    for (const v of versions) expect(() => releaseNotes(page, v), v).not.toThrow();
  });

  it("refuses a version the Changes page has no section for", () => {
    expect(() => releaseNotes(page, "9.9.9")).toThrow('no "## In 9.9.9" section');
  });

  it("orders versions by their numbers, so the newest named is the one marked latest", () => {
    expect(byVersion(["0.4.36", "0.4.8", "0.4.10", "0.4.9"])).toEqual(["0.4.8", "0.4.9", "0.4.10", "0.4.36"]);
  });

  it("is step 5 of the release path, and only ever uses a tag that exists", () => {
    expect(readFileSync(join(root, "CONTRIBUTING.md"), "utf8")).toContain("5. Run `just github-release <version>`");
    expect(readFileSync(join(root, "scripts", "github-release.mjs"), "utf8")).toContain('"--verify-tag"');
  });
});
