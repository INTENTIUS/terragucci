/**
 * `install.verify`: a choudoufu release's signature, SLSA provenance and SBOM
 * attestation, checked against the release key before the binary is installed.
 *
 * fixtures/choudoufu-release/ holds bundles cosign 2.6.5 made with choudoufu's
 * release workflow steps for a test tag, v0.0.0-test, with a throwaway key
 * whose public half is the cosign.pub there. The rest are made here with
 * test/signer.ts, in the shape cosign writes them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, installProblems, NO_CHOUDOUFU_KEY, validateConfig } from "../src/config";
import { CHOUDOUFU_RELEASE_KEY } from "../src/images";
import { choudoufuBuilder, install, verifyChoudoufu } from "../src/install";
import { installScript } from "../src/render";
import { terragruntInstalls } from "../src/render-terragrunt";
import { tmp } from "./helpers";
import { keyPair, testSigner } from "./signer";

const VERSION = "0.0.0-test";
const FILE = `choudoufu_v${VERSION}_linux_amd64.tar.gz`;
const fixture = (name: string): Buffer => readFileSync(join(import.meta.dirname, "fixtures/choudoufu-release", name));
const archive = fixture(FILE);
const pem = fixture("cosign.pub").toString("utf-8");
const bundles = () => ({
  signature: fixture(`${FILE}.sig.bundle`).toString("utf-8"),
  provenance: fixture(`${FILE}.provenance.bundle`).toString("utf-8"),
  sbom: fixture(`${FILE}.sbom.bundle`).toString("utf-8"),
});

const refusal = (f: () => void): string => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};

const COMMIT = "a".repeat(40);

/** The provenance choudoufu's release workflow writes for `tag` at `commit`. */
const provenance = (tag: string, commit = COMMIT) => ({
  buildDefinition: {
    buildType: "https://github.com/INTENTIUS/choudoufu/release/v1",
    externalParameters: { workflow: ".github/workflows/release.yml", tag, sourceRef: commit },
    resolvedDependencies: [{ uri: `git+https://github.com/INTENTIUS/choudoufu@refs/tags/${tag}`, digest: { gitCommit: commit } }],
  },
  runDetails: { builder: { id: `https://github.com/INTENTIUS/choudoufu/.github/workflows/release.yml@refs/tags/${tag}` } },
});

/** A release signed here: an archive, its three bundles with `predicate` as the provenance, and the key's PEM. */
async function signed(predicate: unknown, sbomType: "spdxjson" | "slsaprovenance1" = "spdxjson") {
  const pair = keyPair();
  const signer = testSigner(pair.privateKey);
  const dir = tmp("terragucci-choudoufu-release-");
  const blob = join(dir, FILE);
  writeFileSync(blob, "a choudoufu release archive");
  writeFileSync(join(dir, "provenance.json"), JSON.stringify(predicate));
  writeFileSync(join(dir, "sbom.json"), JSON.stringify({ spdxVersion: "SPDX-2.3", packages: [] }));
  return {
    archive: readFileSync(blob),
    pem: pair.pem,
    bundles: {
      signature: await signer.signBlob(blob),
      provenance: await signer.attestBlob(blob, join(dir, "provenance.json"), "slsaprovenance1"),
      sbom: await signer.attestBlob(blob, join(dir, "sbom.json"), sbomType),
    },
  };
}

describe("verifyChoudoufu", () => {
  it("accepts a release cosign signed and attested with the release workflow's steps", () => {
    expect(() => verifyChoudoufu(VERSION, FILE, archive, bundles(), pem)).not.toThrow();
  });

  it("names the builder choudoufu's release workflow at the release's own tag", () => {
    expect(choudoufuBuilder("0.29.1")).toBe("https://github.com/INTENTIUS/choudoufu/.github/workflows/release.yml@refs/tags/v0.29.1");
  });

  it("refuses other bytes than the release signed, naming the release and the signature bundle", () => {
    const m = refusal(() => verifyChoudoufu(VERSION, FILE, Buffer.from("another binary"), bundles(), pem));
    expect(m).toContain(`choudoufu v${VERSION}: ${FILE}.sig.bundle: the signature does not verify`);
    expect(m).toContain("the binary was not installed");
  });

  it("refuses a release signed with another key", () => {
    expect(refusal(() => verifyChoudoufu(VERSION, FILE, archive, bundles(), keyPair().pem))).toContain(`${FILE}.sig.bundle: the signature does not verify against the trusted key`);
  });

  it.each(["signature", "provenance", "sbom"] as const)("refuses a release that publishes no %s bundle", (part) => {
    const b: Partial<ReturnType<typeof bundles>> = bundles();
    delete b[part];
    const ext = { signature: "sig.bundle", provenance: "provenance.bundle", sbom: "sbom.bundle" }[part];
    expect(refusal(() => verifyChoudoufu(VERSION, FILE, archive, b, pem))).toContain(`${FILE}.${ext}: the release publishes no such file, so it is not a signed release`);
  });

  it("refuses the provenance of one tag offered for another release", () => {
    // The fixture's bytes and signature are good; its provenance was built at v0.0.0-test.
    const m = refusal(() => verifyChoudoufu("0.0.1", FILE, archive, bundles(), pem));
    expect(m).toContain(`choudoufu v0.0.1: ${FILE}.provenance.bundle: the provenance names its builder ${choudoufuBuilder(VERSION)}, not ${choudoufuBuilder("0.0.1")}`);
  });

  it("refuses an SBOM bundle that is not an SPDX attestation", () => {
    const m = refusal(() => verifyChoudoufu(VERSION, FILE, archive, { ...bundles(), sbom: bundles().provenance }, pem));
    expect(m).toContain(`${FILE}.sbom.bundle: the SBOM attestation is a https://slsa.dev/provenance/v1, not https://spdx.dev/Document`);
  });

  it("refuses a bundle that is not JSON", () => {
    expect(refusal(() => verifyChoudoufu(VERSION, FILE, archive, { ...bundles(), provenance: "not json" }, pem))).toContain(`${FILE}.provenance.bundle: the provenance is not a cosign bundle`);
  });

  it("accepts a release signed here in the workflow's shape", async () => {
    const r = await signed(provenance(`v${VERSION}`));
    expect(() => verifyChoudoufu(VERSION, FILE, r.archive, r.bundles, r.pem)).not.toThrow();
  });

  it("refuses provenance whose builder is another workflow", async () => {
    const p = provenance(`v${VERSION}`);
    p.runDetails.builder.id = `https://github.com/someone/choudoufu/.github/workflows/release.yml@refs/tags/v${VERSION}`;
    const r = await signed(p);
    expect(refusal(() => verifyChoudoufu(VERSION, FILE, r.archive, r.bundles, r.pem))).toContain("the provenance names its builder https://github.com/someone/choudoufu/");
  });

  it("refuses provenance that says it built another tag", async () => {
    const p = provenance(`v${VERSION}`);
    p.buildDefinition.externalParameters.tag = "v9.9.9";
    const r = await signed(p);
    expect(refusal(() => verifyChoudoufu(VERSION, FILE, r.archive, r.bundles, r.pem))).toContain(`the provenance says it built v9.9.9, not v${VERSION}`);
  });

  it("refuses provenance with no source commit", async () => {
    const p = provenance(`v${VERSION}`, "main");
    const r = await signed(p);
    expect(refusal(() => verifyChoudoufu(VERSION, FILE, r.archive, r.bundles, r.pem))).toContain("the provenance names no source commit");
  });

  it("refuses provenance whose source is not choudoufu's repo at the tag and commit", async () => {
    const p = provenance(`v${VERSION}`);
    p.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40);
    const r = await signed(p);
    expect(refusal(() => verifyChoudoufu(VERSION, FILE, r.archive, r.bundles, r.pem))).toContain(`does not name git+https://github.com/INTENTIUS/choudoufu@refs/tags/v${VERSION} at ${COMMIT} as its source`);
  });

  it("refuses when no release key is given", () => {
    expect(refusal(() => verifyChoudoufu(VERSION, FILE, archive, bundles(), ""))).toContain("no choudoufu release key is pinned");
  });
});

describe("install --verify", () => {
  it("is for choudoufu alone", async () => {
    await expect(install("tofu", "1.12.0", tmp(), { verify: true, key: pem })).rejects.toThrow(/--verify checks choudoufu releases, and tofu is not choudoufu/);
  });

  it("refuses before any download while no release key is pinned", async () => {
    await expect(install("choudoufu", "0.29.1", tmp(), { verify: true, key: "" })).rejects.toThrow(/no choudoufu release key is pinned/);
  });
});

describe("install.verify config", () => {
  const problems = (v: unknown, binary?: string, key = pem): string[] => installProblems(v, "config.install", binary, key);

  it("takes verify true or false, with a pinned key", () => {
    expect(problems({ verify: true })).toEqual([]);
    expect(problems({ verify: true }, "choudoufu")).toEqual([]);
    expect(problems({ verify: false }, "tofu", "")).toEqual([]);
    expect(problems({})).toEqual([]);
  });

  it("refuses to be turned on while no choudoufu release key is pinned", () => {
    expect(problems({ verify: true }, "choudoufu", "")).toEqual([`config.install.verify: ${NO_CHOUDOUFU_KEY}`]);
  });

  it("checks the key pinned in this release by default", () => {
    expect(installProblems({ verify: true }, "config.install", "choudoufu").some((p) => p.includes(NO_CHOUDOUFU_KEY))).toBe(CHOUDOUFU_RELEASE_KEY.trim() === "");
  });

  it("refuses verify with another binary, a value that is not a boolean, and an unknown key", () => {
    expect(problems({ verify: true }, "tofu")).toEqual(['config.install.verify checks choudoufu releases, and binary is "tofu"; leave install.verify unset or set binary: choudoufu']);
    expect(problems({ verify: "yes" })).toEqual(["config.install.verify must be true or false"]);
    expect(problems({ verfy: true })).toEqual(["config.install.verfy is not a setting (settings: verify)"]);
    expect(problems(true)).toEqual(["config.install must be a map (settings: verify)"]);
  });

  it("is validated as part of the config", () => {
    expect(() => validateConfig({ install: { verify: "yes" } }, "t")).toThrow(/config.install.verify must be true or false/);
    expect(() => validateConfig({ install: { verify: false } }, "t")).not.toThrow();
  });
});

describe("the pipeline under install.verify", () => {
  it("installs choudoufu with --verify", () => {
    expect(installScript("choudoufu", "0.29.1", "github", true)).toBe('dir="$(terragucci install choudoufu 0.29.1 --verify)"\necho "$dir" >> "$GITHUB_PATH"');
    expect(installScript("choudoufu", "0.29.1", "gitlab", true)).toBe('dir="$(terragucci install choudoufu 0.29.1 --verify)"\nexport PATH="$dir:$PATH"');
    expect(installScript("choudoufu", "0.29.1", "github")).toBe('dir="$(terragucci install choudoufu 0.29.1)"\necho "$dir" >> "$GITHUB_PATH"');
  });

  it("installs and verifies choudoufu beside Terragrunt even when the image carries the release", () => {
    expect(terragruntInstalls("choudoufu", "0.29.1", "1.1.6", { choudoufu: "0.29.1" }, true)).toEqual([{ tool: "terragrunt", version: "1.1.6" }, { tool: "choudoufu", version: "0.29.1", verify: true }]);
    expect(terragruntInstalls("choudoufu", "0.29.1", "1.1.6", { choudoufu: "0.29.1" })).toEqual([{ tool: "terragrunt", version: "1.1.6" }]);
  });
});
