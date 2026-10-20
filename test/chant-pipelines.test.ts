import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs script with no types
import { chantTrees, PIPELINES } from "../scripts/chant-pipelines.mjs";

const root = join(import.meta.dirname, "..");

// Every chant example's pipeline is chant's generator output (just
// chant-pipelines regenerates and compares; CI's static job runs it).
describe("chant-pipelines", () => {
  it("has a generator command for every example tree that is a chant project", () => {
    const trees: string[] = chantTrees();
    expect(trees).toContain("example-demo-chant");
    for (const t of trees) expect(Object.keys(PIPELINES), t).toContain(t);
  });

  it("names a committed file in each tree, and the tree installs the lexicons the generator loads", () => {
    for (const [tree, { file, args }] of Object.entries(PIPELINES as Record<string, { file: string; args: string[] }>)) {
      expect(existsSync(join(root, tree, file)), `${tree}/${file}`).toBe(true);
      const pkg = JSON.parse(readFileSync(join(root, tree, "package.json"), "utf8"));
      const lexicon = args[args.indexOf("--generate") + 1];
      const chant = pkg.dependencies["@intentius/chant"];
      // The forgejo generator builds on the github one.
      for (const l of lexicon === "forgejo" ? ["forgejo", "github"] : [lexicon]) {
        expect(pkg.devDependencies?.[`@intentius/chant-lexicon-${l}`], `${tree}: chant-lexicon-${l}`).toBe(chant);
      }
    }
  });

  it("is the command stack/demo.sh says writes the chant repo's pipeline", () => {
    const demo = readFileSync(join(root, "stack", "demo.sh"), "utf8");
    const said = /^# {3}(chant build [^\n]*)\\\n# {5}([^\n]*)$/m.exec(demo);
    expect(said).not.toBeNull();
    const { file, args } = PIPELINES["example-demo-chant"];
    expect(`${said![1]}${said![2]}`.replace(/\s+/g, " ")).toBe(`chant ${args.join(" ")} --output ${file}`);
  });

  it("pins the chant the job image installs, and the image leaves the generator's lexicons out", () => {
    const pkg = JSON.parse(readFileSync(join(root, "example-demo-chant", "package.json"), "utf8"));
    expect(pkg.dependencies["@intentius/chant-lexicon-terraform"]).toBe(pkg.dependencies["@intentius/chant"]);
    expect(readFileSync(join(root, "stack", "demo-chant.Dockerfile"), "utf8")).toContain("npm ci --omit=dev");
  });
});
