import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ciToolSha256, type CiTool } from "@intentius/chant/ci-image";
import { TOOL_VERSIONS, toolSha256 } from "../src/images";
import { assertLinux, install, installDir, installRoot, type InstallFs } from "../src/install";

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

  // An image needs a recorded sha256 for both architectures (chant issue 4784): terragucci's (TOOL_SHA256), else chant's (4908).
  it.each(Object.entries(TOOL_VERSIONS))("%s %s has a recorded sha256 for amd64 and arm64", (tool, version) => {
    const sums = ciToolSha256(tool as CiTool, version, toolSha256(tool as keyof typeof TOOL_VERSIONS, version));
    expect(Object.keys(sums).sort()).toEqual(["amd64", "arm64"]);
  });

  // A job that is not root, such as the Chainguard images' 65532, under a cache the runner mounted as root.
  describe("a directory the job's user cannot write", () => {
    /** A filesystem where only `writable` can be written and `present` files exist. */
    const fakeFs = (writable: string[], present: string[] = []): InstallFs & { made: string[] } => {
      const made: string[] = [];
      return {
        made,
        exists: (p) => present.includes(p),
        writable: (d) => {
          made.push(d);
          return writable.includes(d);
        },
      };
    };

    it("installs where it is configured when the user can write there, and says nothing", () => {
      const lines: string[] = [];
      const root = installRoot("tofu", "1.12.0", { TOFU_INSTALL_DIR: "/cache/bin", HOME: "/tmp" }, { fs: fakeFs(["/cache/bin"]), uid: 0, warn: (l) => lines.push(l) });
      expect(root).toBe("/cache/bin");
      expect(lines).toEqual([]);
    });

    it("reuses a release the configured directory already holds, though the user cannot write it", () => {
      const fs = fakeFs([], ["/cache/bin/tofu-1.12.0/tofu"]);
      const lines: string[] = [];
      expect(installRoot("tofu", "1.12.0", { TOFU_INSTALL_DIR: "/cache/bin", HOME: "/tmp" }, { fs, uid: 65532, warn: (l) => lines.push(l) })).toBe("/cache/bin");
      expect(fs.made).toEqual([]);
      expect(lines).toEqual([]);
    });

    it("falls back to $HOME and says so in one line naming the user and both directories", () => {
      const lines: string[] = [];
      const root = installRoot("tofu", "1.12.0", { TOFU_INSTALL_DIR: "/cache/bin", HOME: "/tmp" }, { fs: fakeFs(["/tmp/.cache/terragucci-bin"]), uid: 65532, warn: (l) => lines.push(l) });
      expect(root).toBe("/tmp/.cache/terragucci-bin");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/uid 65532 cannot write \/cache\/bin, so tofu 1\.12\.0 installs under \/tmp\/\.cache\/terragucci-bin instead/);
    });

    it("falls back from the runner's temp directory too, then to the system's", () => {
      const fs = fakeFs(["/sys-tmp/terragucci-bin"]);
      const root = installRoot("tofu", "1.12.0", { RUNNER_TEMP: "/__w/_temp", HOME: "/home/x" }, { fs, uid: 65532, tmp: "/sys-tmp", warn: () => {} });
      expect(root).toBe("/sys-tmp/terragucci-bin");
      expect(fs.made).toEqual(["/__w/_temp/terragucci-bin", "/home/x/.cache/terragucci-bin", "/sys-tmp/terragucci-bin"]);
    });

    it("refuses when nothing is writable, naming the directory, the user and the remedy, before any download", async () => {
      let downloads = 0;
      const p = install("tofu", "1.12.0", { TOFU_INSTALL_DIR: "/cache/bin", HOME: "/tmp" }, {
        fs: fakeFs([]),
        uid: 65532,
        tmp: "/tmp",
        installer: async () => {
          downloads++;
          return { dir: "", bin: "" };
        },
      });
      await expect(p).rejects.toThrow(/uid 65532 cannot write \/cache\/bin or \/tmp\/\.cache\/terragucci-bin or \/tmp\/terragucci-bin.*set TOFU_INSTALL_DIR to a directory that user can write/);
      expect(downloads).toBe(0);
    });

    it("hands the fallback directory to the installer and returns the release's directory under it", async () => {
      const roots: string[] = [];
      const dir = await install("tofu", "1.12.0", { TOFU_INSTALL_DIR: "/cache/bin", HOME: "/tmp" }, {
        fs: fakeFs(["/tmp/.cache/terragucci-bin"]),
        uid: 65532,
        warn: () => {},
        installer: async (_tool, version, o) => {
          roots.push(o?.root ?? "");
          return { dir: join(o?.root ?? "", `tofu-${version}`), bin: "" };
        },
      });
      expect(roots).toEqual(["/tmp/.cache/terragucci-bin"]);
      expect(dir).toBe("/tmp/.cache/terragucci-bin/tofu-1.12.0");
    });

    // The real filesystem: a read-only directory stands in for /cache/bin. Root writes it anyway, as the Debian images' jobs do.
    it.skipIf(process.getuid?.() === 0)("on disk, passes over a read-only install directory to one under $HOME", () => {
      const base = mkdtempSync(join(tmpdir(), "tg-install-"));
      const cache = join(base, "cache");
      mkdirSync(cache);
      chmodSync(cache, 0o555);
      const home = join(base, "home");
      mkdirSync(home);
      try {
        const lines: string[] = [];
        const root = installRoot("tofu", "1.12.0", { TOFU_INSTALL_DIR: join(cache, "bin"), HOME: home }, { warn: (l) => lines.push(l) });
        expect(root).toBe(join(home, ".cache", "terragucci-bin"));
        expect(existsSync(root)).toBe(true);
        expect(existsSync(join(cache, "bin"))).toBe(false);
        expect(lines[0]).toContain(`cannot write ${join(cache, "bin")}`);
        // A release already in the read-only directory is used where it is.
        chmodSync(cache, 0o755);
        mkdirSync(join(cache, "bin", "tofu-1.12.0"), { recursive: true });
        writeFileSync(join(cache, "bin", "tofu-1.12.0", "tofu"), "");
        chmodSync(join(cache, "bin"), 0o555);
        expect(installRoot("tofu", "1.12.0", { TOFU_INSTALL_DIR: join(cache, "bin"), HOME: home }, { warn: () => {} })).toBe(join(cache, "bin"));
      } finally {
        chmodSync(cache, 0o755);
        if (existsSync(join(cache, "bin"))) chmodSync(join(cache, "bin"), 0o755);
      }
    });
  });
});
