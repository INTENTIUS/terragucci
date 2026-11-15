// The terragucci bundle leaves chant core external (scripts/chant-external.mjs) and imports
// it from the installed @intentius/chant at run time. A CI image that carries only the
// bundle and chant's wave runtime stops at `Cannot find package '@intentius/chant'` on the
// first terragucci call of every job. These hold each image to installing the package.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "packages/terragucci/package.json"), "utf8"));
const chant: string = pkg.dependencies["@intentius/chant"];

describe.each(["tofu", "terraform", "terragrunt", "choudoufu"])("images/Dockerfile.%s", (name) => {
  const dockerfile = readFileSync(join(root, "images", `Dockerfile.${name}`), "utf8");
  const npmInstall = dockerfile.split("\n").find((l) => l.includes("npm install --prefix /usr/local"));

  it("installs the chant package the bundle imports, at the release the package pins", () => {
    expect(npmInstall).toBeDefined();
    expect(npmInstall).toContain(` @intentius/chant@${chant} `);
  });

  it("installs the HCL parser in the same npm install, which would otherwise prune it", () => {
    expect(npmInstall).toContain("@cdktn/hcl2json@");
  });

  it("takes the wave runtime from the same chant release", () => {
    expect(dockerfile).toContain(`npm pack --silent @intentius/chant@${chant}`);
  });
});
