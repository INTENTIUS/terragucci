// The release scan's VEX file (CONTRIBUTING.md, The release scan's VEX statement): what it says, and that it cannot
// outlive the OpenTofu binary it describes.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../../../chant.config";
import { TOOL_VERSIONS, toolSha256 } from "../src/images";

const ROOT = join(import.meta.dirname, "../../..");
const VEX = "security/vex/tofu-1.13.9-x-net.openvex.json";
/** The OpenTofu release the statement was checked against. */
const CHECKED_TOFU = "1.13.9";

interface Statement {
  vulnerability: { name: string; aliases?: string[] };
  products: { "@id": string; subcomponents?: { "@id": string }[] }[];
  status: string;
  justification?: string;
  impact_statement?: string;
}
const doc = JSON.parse(readFileSync(join(ROOT, VEX), "utf-8")) as { "@context": string; statements: Statement[] };
const [statement] = doc.statements;

/** chant's own gate, as the release cut runs it (lifecycle/publish-scan.js scanOne). */
const gateModule = join(ROOT, "node_modules/@intentius/chant/dist/components/verbs/vuln-gate.js");

/** A finding as chant's grype parser makes it. */
const finding = (cveId: string, severity: string, pkg: string, version: string, fixable: boolean) => ({ cveId, severity, package: pkg, installedVersion: version, fixable, ...(fixable ? { fixedVersion: "v0.60.0" } : {}) });

describe("the release scan's VEX file", () => {
  it("is the one file vulnPolicy names, and the policy is otherwise chant's default", () => {
    expect(config.vulnPolicy).toEqual({ vexSources: [VEX] });
    expect(readdirSync(join(ROOT, "security/vex"))).toEqual([VEX.split("/").pop()]);
  });

  it("holds one OpenVEX statement: GO-2026-6612 not affected, its code not present", () => {
    expect(doc["@context"]).toBe("https://openvex.dev/ns/v0.2.0");
    expect(doc.statements).toHaveLength(1);
    expect(statement.vulnerability.name).toBe("GO-2026-6612");
    expect(statement.vulnerability.aliases).toEqual(["CVE-2026-78663"]);
    expect(statement.status).toBe("not_affected");
    expect(statement.justification).toBe("vulnerable_code_not_present");
  });

  it("names only the images that install OpenTofu, and in them only OpenTofu's x/net v0.57.0", () => {
    // The Dockerfiles that fetch the OpenTofu release, in both sets.
    const carriers = readdirSync(join(ROOT, "images"))
      .filter((f) => f.startsWith("Dockerfile.") && readFileSync(join(ROOT, "images", f), "utf-8").includes(`tofu_${TOOL_VERSIONS.tofu}_linux_`))
      .sort();
    expect(carriers).toEqual(["Dockerfile.terragrunt", "Dockerfile.terragruntChainguard", "Dockerfile.tofu", "Dockerfile.tofuChainguard"]);
    expect(statement.products.map((p) => p["@id"])).toEqual([
      "pkg:oci/terragucci-tofu?repository_url=ghcr.io/intentius/terragucci-tofu",
      "pkg:oci/terragucci-terragrunt?repository_url=ghcr.io/intentius/terragucci-terragrunt",
    ]);
    for (const p of statement.products) {
      expect(p.subcomponents?.map((s) => s["@id"])).toEqual([`pkg:golang/github.com/opentofu/opentofu@v${CHECKED_TOFU}`, "pkg:golang/golang.org/x/net@v0.57.0"]);
    }
  });

  // The statement is a claim about one binary. When the pin moves, delete the file and its vexSources entry if the new
  // OpenTofu release is built with golang.org/x/net v0.60.0 or later; otherwise check the claim again for that binary.
  it("describes the OpenTofu release and archives the images install", () => {
    expect(TOOL_VERSIONS.tofu, `the OpenTofu pin moved to ${TOOL_VERSIONS.tofu}, and ${VEX} describes ${CHECKED_TOFU}: delete it if ${TOOL_VERSIONS.tofu} is built with golang.org/x/net v0.60.0 or later, else check the claim against ${TOOL_VERSIONS.tofu}`).toBe(CHECKED_TOFU);
    const sums = toolSha256("tofu", CHECKED_TOFU)!;
    expect(statement.impact_statement).toContain(`tofu_${CHECKED_TOFU}_linux_amd64.tar.gz sha256 ${sums.amd64}`);
    expect(statement.impact_statement).toContain(`tofu_${CHECKED_TOFU}_linux_arm64.tar.gz sha256 ${sums.arm64}`);
    expect(statement.impact_statement).toContain(`/opt/terragucci/tofu-${CHECKED_TOFU}/tofu`);
  });

  it("clears GO-2026-6612 in chant's gate and leaves every other finding as it was", async () => {
    const { createVulnGateCapability, VulnGateFailedError } = await import(pathToFileURL(gateModule).href);
    const gate = createVulnGateCapability({ scan: async () => [] });
    const vex = [readFileSync(join(ROOT, VEX), "utf-8")];
    const policy = {};
    const tofu = [
      finding("GO-2026-6612", "critical", "golang.org/x/net", "v0.57.0", true),
      finding("GO-2026-6603", "high", "golang.org/x/net", "v0.57.0", true),
      finding("GO-2026-6611", "high", "golang.org/x/net", "v0.57.0", true),
      finding("CVE-2026-5450", "critical", "libc6", "2.36-9+deb12u14", false),
    ];

    // Without the file the finding blocks, as it did in the 0.4.65 cut.
    await expect(gate.run({ env: "release", component: "oci:tofu" }, { findings: tofu, vex: [], policy })).rejects.toBeInstanceOf(VulnGateFailedError);

    const out = await gate.run({ env: "release", component: "oci:tofu" }, { findings: tofu, vex, policy });
    expect(out.suppressed).toEqual([{ finding: tofu[0], status: "not_affected", justification: "vulnerable_code_not_present" }]);
    // The High x/net advisories and the unfixable libc one are still reported.
    expect(out.warnings.map((f: { cveId: string }) => f.cveId)).toEqual(["GO-2026-6603", "GO-2026-6611", "CVE-2026-5450"]);

    // Another critical, fixable advisory still blocks.
    const other = [...tofu, finding("GO-2026-9999", "critical", "golang.org/x/net", "v0.57.0", true)];
    await expect(gate.run({ env: "release", component: "oci:tofu" }, { findings: other, vex, policy })).rejects.toMatchObject({ blocking: [{ finding: { cveId: "GO-2026-9999" } }] });

    // A finding under the CVE id rather than the Go id is not cleared: chant matches the statement's name exactly.
    const byCve = [finding("CVE-2026-78663", "critical", "golang.org/x/net", "v0.57.0", true)];
    await expect(gate.run({ env: "release", component: "oci:tofu" }, { findings: byCve, vex, policy })).rejects.toBeInstanceOf(VulnGateFailedError);
  });
});
