import { describe, expect, it } from "vitest";
import { ciToolSha256, type CiTool } from "@intentius/chant/ci-image";
import { TOOL_SHA256, TOOL_VERSIONS } from "../src/images";
import { assertLinux, install, installDir } from "../src/install";

describe("install", () => {
  it("installs under the runner's cache when the stack sets one", () => {
    expect(installDir("tofu", "1.12.0", { TOFU_INSTALL_DIR: "/cache/bin" })).toBe("/cache/bin/tofu-1.12.0");
    expect(installDir("tofu", "1.12.0", { RUNNER_TEMP: "/rt" })).toBe("/rt/terragucci-bin/tofu-1.12.0");
  });

  it("refuses off Linux, where the releases it fetches would not run", () => {
    expect(() => assertLinux("darwin")).toThrow(/Linux builds.*darwin/);
    expect(() => assertLinux("linux")).not.toThrow();
  });

  it("refuses something that is not a version", async () => {
    await expect(install("tofu", "latest")).rejects.toThrow(/not a release version/);
    await expect(install("tofu", "1.2.3; rm -rf /")).rejects.toThrow(/not a release version/);
  });

  // An image needs a recorded sha256 for both architectures (chant issue 4784): chant's, or terragucci's own.
  it.each(Object.entries(TOOL_VERSIONS))("%s %s has a recorded sha256 for amd64 and arm64", (tool, version) => {
    const sums = ciToolSha256(tool as CiTool, version, TOOL_SHA256[tool as keyof typeof TOOL_VERSIONS]);
    expect(Object.keys(sums).sort()).toEqual(["amd64", "arm64"]);
  });
});
