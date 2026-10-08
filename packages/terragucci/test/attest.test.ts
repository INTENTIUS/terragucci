import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import { publish, verifyPublished } from "../src/publish";
import { moduleTar, moduleTarAt, sha256 } from "../src/publish/archive";
import { attestKey, componentName, releaseComponent, type Signer } from "../src/publish/attest";
import { fetchLedger, LEDGER_PATH, LIFECYCLE } from "../src/publish/ledger";
import { moduleSbom } from "../src/publish/sbom";
import { AttestationError, pae, publicKey, verifyAttestation, verifyRelease } from "../src/publish/verify";
import { git, tmp, write } from "./helpers";

type Pair = { privateKey: KeyObject; pem: string };
const keyPair = (): Pair => {
  const { privateKey, publicKey: pub } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, pem: pub.export({ type: "spki", format: "pem" }).toString() };
};

const TYPE_URI = { slsaprovenance1: "https://slsa.dev/provenance/v1", spdxjson: "https://spdx.dev/Document" } as const;

/** Bundles shaped as cosign 2's `sign-blob --bundle` and `attest-blob --bundle` write them with a key and no tlog. */
function testSigner(key: KeyObject): Signer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async signBlob(blob) {
      calls.push("sign-blob");
      return JSON.stringify({ base64Signature: sign("sha256", readFileSync(blob), key).toString("base64") });
    },
    async attestBlob(blob, predicate, type) {
      calls.push(`attest-blob ${type}`);
      const statement = {
        _type: "https://in-toto.io/Statement/v0.1",
        predicateType: TYPE_URI[type],
        subject: [{ name: basename(blob), digest: { sha256: sha256(readFileSync(blob)).slice(7) } }],
        predicate: JSON.parse(readFileSync(predicate, "utf-8")),
      };
      const payload = Buffer.from(JSON.stringify(statement));
      const envelope = { payloadType: "application/vnd.in-toto+json", payload: payload.toString("base64"), signatures: [{ keyid: "", sig: sign("sha256", pae("application/vnd.in-toto+json", payload), key).toString("base64") }] };
      return JSON.stringify({ base64Signature: Buffer.from(JSON.stringify(envelope)).toString("base64") });
    },
  };
}

function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

const MAIN_TF = `terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random" }
  }
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.1.0"
}

module "local" {
  source = "./sub"
}

resource "terraform_data" "s" {}
`;

/** A repo with one module, its public key, and a bare origin. */
function attestedRepo(pair: Pair) {
  const repo = tmp("terragucci-attest-");
  const origin = tmp("terragucci-attest-origin-");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  write(repo, { "modules/service/main.tf": MAIN_TF, "modules/service/sub/main.tf": "# sub\n", "cosign.pub": pair.pem });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", origin);
  commit(repo, "feat: service");
  return { repo, origin };
}

const cfg = { modules: { publish: "git-tags", attest: true } };
const parser = async () => (await import("@cdktn/hcl2json")) as never;

describe("modules.attest config", () => {
  it("takes true or a key path, beside publish", () => {
    const problems = (modules: unknown): string => {
      try {
        validateConfig({ modules }, "t");
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(problems({ publish: "git-tags", attest: true })).toBe("");
    expect(problems({ publish: "git-tags", attest: { key: "keys/modules.pub" } })).toBe("");
    expect(problems({ attest: true })).toContain("so set config.modules.publish too");
    expect(problems({ publish: "git-tags", attest: "yes" })).toContain("must be true or a map with key");
    expect(problems({ publish: "git-tags", attest: { key: "" } })).toContain("path of the public key");
    expect(problems({ publish: "git-tags", atest: true })).toContain("config.modules.atest is not a setting");
  });

  it("reads the key at cosign.pub unless it names one", () => {
    expect(attestKey(true)).toBe("cosign.pub");
    expect(attestKey({ key: "k.pub" })).toBe("k.pub");
    expect(attestKey(false)).toBeUndefined();
    expect(attestKey(undefined)).toBeUndefined();
  });
});

describe("the release component", () => {
  const component = releaseComponent({ module: "modules/Service_x", version: "1.2.0", target: "git-tags", ref: "modules/Service_x/v1.2.0" }, "cosign.pub");

  it("is a chant component the contract schema accepts", async () => {
    const Ajv = (await import("ajv/dist/2020.js")).default;
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, "../../../node_modules/@intentius/chant/src/components/component.schema.json"), "utf-8"));
    const ajv = new Ajv({ strict: false });
    const valid = ajv.validate(schema, JSON.parse(JSON.stringify(component)));
    expect(ajv.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
    expect(component.name).toBe(componentName("modules/Service_x"));
    expect(component.name).toBe("module-modules-service-x");
  });

  it("archives, writes the SBOM, signs, attests, verifies and records, in that order", () => {
    expect(component.deploy.map((p) => p.phase)).toEqual(["Archive", "Sbom", "Sign", "Provenance", "SbomAttestation", "Verify", "Record"]);
    expect(component.deploy.flatMap((p) => p.steps.map((s) => (s as { kind: string }).kind))).toEqual([
      "module-archive", "module-sbom", "sign-blob", "attest-provenance", "attest-sbom", "verify-attestations", "release-record",
    ]);
  });
});

describe("moduleSbom", () => {
  it("names the module, its providers at their lock, and the modules it calls from outside", async () => {
    const dir = write(tmp("terragucci-sbom-"), {
      "main.tf": MAIN_TF,
      ".terraform.lock.hcl": 'provider "registry.terraform.io/hashicorp/aws" {\n  version     = "5.80.0"\n  constraints = "~> 5.0"\n}\n',
    });
    const doc = await moduleSbom({ dir, rel: "modules/service", version: "0.2.0", digest: `sha256:${"a".repeat(64)}`, tool: "0.0.0", created: "2026-01-01T00:00:00Z" }, await parser());
    expect(doc.spdxVersion).toBe("SPDX-2.3");
    expect(doc.packages.map((p) => [p.name, p.versionInfo])).toEqual([
      ["modules/service", "0.2.0"],
      ["registry.terraform.io/hashicorp/aws", "5.80.0"],
      ["registry.terraform.io/hashicorp/random", undefined],
      ["terraform-aws-modules/vpc/aws", "5.1.0"],
    ]);
    expect(doc.packages[0].checksums).toEqual([{ algorithm: "SHA256", checksumValue: "a".repeat(64) }]);
    expect(doc.relationships.filter((r) => r.relationshipType === "DEPENDS_ON")).toHaveLength(3);
  });
});

describe("moduleTarAt", () => {
  it("archives a module at a commit to the bytes moduleTar gives its checkout", () => {
    const repo = write(tmp("terragucci-tar-"), { "modules/m/main.tf": "# m\n", "modules/m/x/y.tf": "# y\n", "modules/m/version": "1.0.0\n", "modules/m/.terraform.lock.hcl": "# lock\n" });
    git(repo, "init", "-q", "-b", "main");
    commit(repo, "m");
    expect(moduleTarAt(repo, "HEAD", "modules/m")!.equals(moduleTar(join(repo, "modules/m")))).toBe(true);
    expect(moduleTarAt(repo, "HEAD", "modules/none")).toBeUndefined();
  });
});

describe("publish with modules.attest", () => {
  it("writes the tag and its ledger record in one push, and the release verifies", async () => {
    const pair = keyPair();
    const { repo, origin } = attestedRepo(pair);
    const signer = testSigner(pair.privateKey);
    const r = await publish(repo, cfg, { signer, parser: await parser(), env: { GITHUB_RUN_ID: "77", GITHUB_REPOSITORY: "acme/infra", GITHUB_SERVER_URL: "https://forge.test", GITHUB_ACTOR: "bot" } });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ module: "service", status: "published", version: "0.1.0" });
    expect(signer.calls).toEqual(["sign-blob", "attest-blob slsaprovenance1", "attest-blob spdxjson"]);
    expect(git(origin, "tag", "--list").trim()).toBe("modules/service/v0.1.0");
    const ledger = fetchLedger(repo, "origin")!;
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]).toMatchObject({ component: "modules/service", env: "modules", digest: r[0].digest, gitSha: git(repo, "rev-parse", "HEAD").trim(), runId: "77", actor: "bot" });
    expect(ledger.records[0].runOrigin).toEqual({ forge: "github", repo: "acme/infra", url: "https://forge.test/acme/infra/actions/runs/77" });
    const component = JSON.parse(ledger.file(r[0].digest!, "component.json")!);
    expect(component).toMatchObject({ name: "module-modules-service", archetype: "producer-library" });
    const checks = await verifyPublished(repo, cfg, "modules/service", "0.1.0");
    expect(checks).toEqual([expect.objectContaining({ ref: "modules/service/v0.1.0", verified: expect.objectContaining({ checked: ["ledger", "signature", "provenance", "sbom"] }) })]);
    // A second run on the same commit publishes and records nothing.
    expect((await publish(repo, cfg, { signer, parser: await parser() }))[0].status).toBe("unchanged");
    expect(fetchLedger(repo, "origin")!.records).toHaveLength(1);
  });

  it("refuses a tag the ledger has no record of, and a tag moved to other content", async () => {
    const pair = keyPair();
    const { repo } = attestedRepo(pair);
    await publish(repo, cfg, { signer: testSigner(pair.privateKey), parser: await parser() });
    write(repo, { "modules/service/out.tf": 'output "x" { value = 1 }\n' });
    commit(repo, "fix: x");
    git(repo, "tag", "-a", "modules/service/v0.1.1", "-m", "by hand");
    git(repo, "push", "-q", "origin", "refs/tags/modules/service/v0.1.1");
    const [byHand] = await verifyPublished(repo, cfg, "modules/service", "0.1.1");
    expect(byHand.verified).toBeUndefined();
    expect(byHand.refused).toMatch(/is not in the release ledger .* none has these bytes/);
    git(repo, "tag", "-f", "-a", "modules/service/v0.1.0", "-m", "moved", "HEAD");
    git(repo, "push", "-q", "-f", "origin", "refs/tags/modules/service/v0.1.0");
    const [moved] = await verifyPublished(repo, cfg, "modules/service", "0.1.0");
    expect(moved.refused).toMatch(/is not in the release ledger/);
    const [absent] = await verifyPublished(repo, cfg, "modules/service", "9.9.9");
    expect(absent.refused).toBe("modules/service/v9.9.9 is not published");
  });

  it("writes nothing when the job's key is not the committed public key's pair", async () => {
    const { repo, origin } = attestedRepo(keyPair());
    await expect(publish(repo, cfg, { signer: testSigner(keyPair().privateKey), parser: await parser() })).rejects.toThrow(/does not verify against cosign.pub: .*one key pair/);
    expect(git(origin, "tag", "--list").trim()).toBe("");
    expect(git(origin, "branch", "--list", LIFECYCLE).trim()).toBe("");
    expect(git(repo, "tag", "--list").trim()).toBe("");
  });

  it("needs the public key in the repo and an origin to record at", async () => {
    const pair = keyPair();
    const { repo } = attestedRepo(pair);
    await expect(publish(repo, { modules: { publish: "git-tags", attest: { key: "keys/none.pub" } } }, { signer: testSigner(pair.privateKey), parser: await parser() })).rejects.toThrow(/public key at keys\/none.pub, which is not in the repo/);
    git(repo, "remote", "remove", "origin");
    await expect(publish(repo, cfg, { signer: testSigner(pair.privateKey), parser: await parser() })).rejects.toThrow(/has no origin/);
  });

  it("says on a dry run that it would sign, and signs nothing", async () => {
    const pair = keyPair();
    const { repo } = attestedRepo(pair);
    const signer = testSigner(pair.privateKey);
    const r = await publish(repo, cfg, { signer, parser: await parser(), dryRun: true });
    expect(r[0].detail).toBe("dry run: would publish, sign and record");
    expect(signer.calls).toEqual([]);
  });

  it("asks for the signing secret when it is missing", async () => {
    const pair = keyPair();
    const { repo } = attestedRepo(pair);
    await expect(publish(repo, cfg, { parser: await parser(), env: {} })).rejects.toThrow(/COSIGN_PRIVATE_KEY, which is not set/);
  });
});

describe("verifyRelease", () => {
  const pair = keyPair();
  const key = publicKey(pair.pem, "cosign.pub");

  it("names the commit when the ledger records these bytes from another", async () => {
    const { repo } = attestedRepo(pair);
    await publish(repo, cfg, { signer: testSigner(pair.privateKey), parser: await parser() });
    const ledger = fetchLedger(repo, "origin")!;
    const bytes = moduleTarAt(repo, "HEAD", "modules/service")!;
    expect(verifyRelease({ module: "modules/service", version: "0.1.0", bytes }, ledger, key).checked).toHaveLength(4);
    expect(() => verifyRelease({ module: "modules/service", version: "0.1.0", bytes, commit: "f".repeat(40) }, ledger, key)).toThrow(/and the tag names ffffffffffff/);
    expect(() => verifyRelease({ module: "modules/other", version: "0.1.0", bytes }, ledger, key)).toThrow(/records no release of modules\/other/);
    expect(() => verifyRelease({ module: "modules/service", version: "0.1.0", bytes }, ledger, publicKey(keyPair().pem, "other.pub"))).toThrow(AttestationError);
    expect(git(repo, "show", `origin/${LIFECYCLE}:${LEDGER_PATH}`).trim().split("\n")).toHaveLength(1);
  });

  it("refuses an attestation of another type or other bytes", async () => {
    const signer = testSigner(pair.privateKey);
    const dir = write(tmp("terragucci-att-"), { blob: "bytes", "p.json": "{}" });
    const bundle = await signer.attestBlob(join(dir, "blob"), join(dir, "p.json"), "spdxjson");
    const digest = sha256(Buffer.from("bytes"));
    expect(verifyAttestation(bundle, digest, "https://spdx.dev/Document", key, "SBOM").predicateType).toBe("https://spdx.dev/Document");
    expect(() => verifyAttestation(bundle, digest, "https://slsa.dev/provenance/v1", key, "provenance")).toThrow(/not https:\/\/slsa.dev\/provenance\/v1/);
    expect(() => verifyAttestation(bundle, sha256(Buffer.from("other")), "https://spdx.dev/Document", key, "SBOM")).toThrow(/about other bytes/);
    expect(() => verifyAttestation(undefined, digest, "https://spdx.dev/Document", key, "SBOM attestation")).toThrow(/holds no SBOM attestation/);
  });
});
