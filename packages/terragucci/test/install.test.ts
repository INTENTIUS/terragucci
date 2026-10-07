import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertLinux, expectedSum, installDir, release, unzipEntry } from "../src/install";
import { tmp } from "./helpers";

describe("install", () => {
  it.each([
    ["tofu", "1.12.0", "arm64", "https://github.com/opentofu/opentofu/releases/download/v1.12.0/tofu_1.12.0_linux_arm64.tar.gz", "tar.gz"],
    ["terraform", "1.14.0", "amd64", "https://releases.hashicorp.com/terraform/1.14.0/terraform_1.14.0_linux_amd64.zip", "zip"],
    ["terragrunt", "1.1.6", "amd64", "https://github.com/gruntwork-io/terragrunt/releases/download/v1.1.6/terragrunt_linux_amd64", "binary"],
    ["choudoufu", "0.22.0", "arm64", "https://github.com/INTENTIUS/choudoufu/releases/download/v0.22.0/choudoufu_v0.22.0_linux_arm64.tar.gz", "tar.gz"],
  ] as const)("%s %s on %s comes from %s", (tool, version, arch, url, kind) => {
    expect(release(tool, version, arch)).toMatchObject({ url, kind });
  });

  it("refuses something that is not a version", () => {
    expect(() => release("tofu", "latest")).toThrow(/not a release version/);
    expect(() => release("tofu", "1.2.3; rm -rf /")).toThrow(/not a release version/);
  });

  it("reads the expected digest from SHA256SUMS, with or without the binary marker", () => {
    const sums = `${"1".repeat(64)}  tofu_1.12.0_linux_amd64.tar.gz\n${"2".repeat(64)} *tofu_1.12.0_linux_arm64.tar.gz\n`;
    expect(expectedSum(sums, "tofu_1.12.0_linux_arm64.tar.gz")).toBe("2".repeat(64));
    expect(() => expectedSum(sums, "other")).toThrow(/do not list other/);
  });

  it("reads a digest SHA256SUMS lists as ./<file>, as choudoufu's does", () => {
    const sums = `${"3".repeat(64)}  ./choudoufu_v0.22.0_linux_amd64.tar.gz\n`;
    expect(expectedSum(sums, "choudoufu_v0.22.0_linux_amd64.tar.gz")).toBe("3".repeat(64));
  });

  it.each([
    ["deflated", "ZIP_DEFLATED"],
    ["stored", "ZIP_STORED"],
  ])("unpacks a %s zip entry", (_, mode) => {
    const dir = tmp();
    const zip = join(dir, "t.zip");
    execFileSync("python3", ["-c", `import zipfile\nz=zipfile.ZipFile(${JSON.stringify(zip)},"w",zipfile.${mode})\nz.writestr("LICENSE.txt","licence")\nz.writestr("terraform",b"#!binary"*200)\nz.close()`]);
    expect(unzipEntry(readFileSync(zip), "terraform").toString()).toBe("#!binary".repeat(200));
    expect(() => unzipEntry(readFileSync(zip), "tofu")).toThrow(/no tofu/);
  });

  it("installs under the runner's cache when the stack sets one", () => {
    expect(installDir("tofu", "1.12.0", { TOFU_INSTALL_DIR: "/cache/bin" })).toBe("/cache/bin/tofu-1.12.0");
    expect(installDir("tofu", "1.12.0", { RUNNER_TEMP: "/rt" })).toBe("/rt/terragucci-bin/tofu-1.12.0");
  });

  it("refuses off Linux, where the releases it fetches would not run", () => {
    expect(() => assertLinux("darwin")).toThrow(/Linux builds.*darwin/);
    expect(() => assertLinux("linux")).not.toThrow();
  });
});
