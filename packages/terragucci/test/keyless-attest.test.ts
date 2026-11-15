/**
 * modules.attest: { identity: oidc } (terragucci#1467): a release signed with
 * the publish job's OIDC identity and checked against an identity. The
 * certificate authority, the timestamp authority and the forge's token
 * service are chant's in-process fakes (`sigstoreFake`), so no test reaches
 * a real service or a transparency log.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sigstoreFake, githubClaims, FAKE_FULCIO_URL, FAKE_GITHUB_ISSUER, FAKE_TSA_URL } from "@intentius/chant/workspace/trust/keyless-fixture";
import { ConfigError, validateConfig, type ModulesSettings } from "../src/config";
import { publish, verifyPublished } from "../src/publish";
import { attestKey, attestOn } from "../src/publish/attest";
import { keylessSetting, keylessSigner, signingIdentity } from "../src/publish/keyless";
import { checkedSources, checkRootPins, governingModules } from "../src/publish/require";
import { fetchLedger } from "../src/publish/ledger";
import { AttestationError, keylessTrust, publicKey, verifyAttestation, verifySignature } from "../src/publish/verify";
import { git, tmp, write } from "./helpers";
import { keyPair, testSigner } from "./signer";

const parser = async () => (await import("@cdktn/hcl2json")) as never;

function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

const SUBJECT = "https://github.com/acme/infra/.github/workflows/terragucci.yml@refs/heads/main";
const identity = { identity: "oidc" as const, issuer: FAKE_GITHUB_ISSUER, subject: SUBJECT, fulcio: FAKE_FULCIO_URL, timestamp: FAKE_TSA_URL };
const claims = (workflow = "terragucci.yml") => githubClaims("acme/infra", workflow, "refs/heads/main");

/** A repo with one module, sigstore's (fake) trusted root, and a file:// origin. */
function keylessRepo(trustedRoot: string) {
  const repo = tmp("terragucci-keyless-");
  const origin = tmp("terragucci-keyless-origin-");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  const url = `file://${origin}`;
  write(repo, { "modules/service/main.tf": 'resource "terraform_data" "s" {}\n', ".chant/trusted_root.json": trustedRoot, "envs/dev/main.tf": "# no module yet\n" });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", url);
  commit(repo, "feat: service");
  git(repo, "push", "-q", "origin", "main");
  const pin = (version: string) => write(repo, { "envs/dev/main.tf": `module "service" {\n  source = "git::${url}.git//modules/service?ref=modules/service/v${version}"\n}\n` });
  return { repo, origin, url, pin };
}

const modules = (attest: ModulesSettings["attest"] = identity): ModulesSettings => ({ publish: "git-tags", attest });

describe("modules.attest identity config", () => {
  const problems = (m: unknown): string => {
    try {
      validateConfig({ modules: m }, "t");
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  it("takes identity: oidc with the identity, the trusted root and the authorities", () => {
    expect(problems({ publish: "git-tags", attest: { identity: "oidc" } })).toBe("");
    expect(problems({ publish: "git-tags", attest: { identity: "oidc", issuer: "https://i", subject: "https://s", trusted_root: "keys/root.json", audience: "sigstore", fulcio: "https://fulcio.example.com", timestamp: "https://tsa.example.com" } })).toBe("");
    expect(problems({ publish: "git-tags", attest: { identity: "github" } })).toContain("must be oidc");
    expect(problems({ publish: "git-tags", attest: { identity: "oidc", key: "cosign.pub" } })).toContain("sets key and identity");
    expect(problems({ publish: "git-tags", attest: { identity: "oidc", issuer: "https://i" } })).toContain("set both, or neither");
    expect(problems({ publish: "git-tags", attest: { issuer: "https://i" } })).toContain("goes with identity: oidc");
    expect(problems({ publish: "git-tags", attest: { identity: "oidc", fulcio: "fulcio" } })).toContain("must be an http(s) URL");
  });

  it("takes a key or an identity for a trusted publisher, not both and not neither", () => {
    const base = { source: "oci://registry.example.com/acme/modules", ledger: "https://git.example.com/acme/modules.git" };
    const id = { issuer: "https://token.actions.githubusercontent.com", subject: "https://github.com/acme/modules/.github/workflows/terragucci.yml@refs/heads/main" };
    expect(problems({ require: "attested", trusted: [{ ...base, identity: id }] })).toBe("");
    expect(problems({ require: "attested", trusted: [{ ...base, identity: id, trusted_root: "roots/sigstore.json" }] })).toBe("");
    expect(problems({ require: "attested", trusted: [{ ...base, key: "k.pub", identity: id }] })).toContain("needs one of key");
    expect(problems({ require: "attested", trusted: [base] })).toContain("needs one of key");
    expect(problems({ require: "attested", trusted: [{ ...base, key: "k.pub", trusted_root: "r.json" }] })).toContain("goes with identity");
    expect(problems({ require: "attested", trusted: [{ ...base, identity: { issuer: "https://i" } }] })).toContain("identity must be a map with issuer and subject");
  });

  it("is not a key: attestKey reads none, and attest is still on", () => {
    expect(attestKey(identity)).toBeUndefined();
    expect(keylessSetting(identity)).toBe(identity);
    expect(keylessSetting(true)).toBeUndefined();
    expect(attestOn(identity)).toBe(true);
    expect(attestOn({ key: "k.pub" })).toBe(true);
    expect(attestOn(undefined)).toBe(false);
  });
});

describe("the signing identity", () => {
  it("is the generated workflow's at the default branch on GitHub and GitLab, and is named on a forge it cannot derive", () => {
    const repo = tmp("terragucci-keyless-id-");
    expect(signingIdentity(repo, { identity: "oidc" }, "https://github.com/acme/infra.git", "main")).toEqual({ issuer: "https://token.actions.githubusercontent.com", subject: SUBJECT });
    expect(signingIdentity(repo, { identity: "oidc" }, "git@gitlab.com:platform/infra.git", "trunk")).toEqual({ issuer: "https://gitlab.com", subject: "https://gitlab.com/platform/infra//.gitlab-ci.yml@refs/heads/trunk" });
    expect(signingIdentity(repo, identity, "https://git.example.com/acme/infra", "main")).toEqual({ issuer: FAKE_GITHUB_ISSUER, subject: SUBJECT });
    expect(() => signingIdentity(repo, { identity: "oidc" }, "https://git.example.com/acme/infra", "main")).toThrow(/set modules.attest.issuer and modules.attest.subject/);
    expect(() => signingIdentity(repo, { identity: "oidc" }, undefined, "main")).toThrow(ConfigError);
  });
});

describe("publish with keyless attest", () => {
  it("signs with the job's identity, records the release, and the release verifies against the identity alone", async () => {
    const fake = sigstoreFake();
    const { repo, origin } = keylessRepo(fake.trustedRoot);
    const r = await publish(repo, { modules: modules() }, { signFetch: fake.fetch, env: fake.jobEnv(claims()), parser: await parser() });
    expect(r[0]).toMatchObject({ module: "service", status: "published", version: "0.1.0" });
    expect(git(origin, "tag", "--list").trim()).toBe("modules/service/v0.1.0");
    // One certificate for the job, a timestamp for each of the three signatures, and no other call.
    expect(fake.log.certificates).toEqual([SUBJECT]);
    expect(fake.log.timestamps).toBe(3);
    expect(fake.log.tokens).toEqual(["sigstore"]);
    const ledger = fetchLedger(repo, "origin")!;
    const bundle = JSON.parse(ledger.file(r[0].digest!, "signature.bundle")!);
    expect(bundle.keyless.certificates.length).toBeGreaterThan(0);
    expect(JSON.stringify(ledger.file(r[0].digest!, "signature.bundle"))).not.toContain("PRIVATE");
    const checks = await verifyPublished(repo, { modules: modules() }, "modules/service", "0.1.0");
    expect(checks).toEqual([expect.objectContaining({ verified: expect.objectContaining({ checked: ["ledger", "signature", "provenance", "sbom"] }) })]);
  });

  it("writes nothing when the job runs as another workflow than the identity names", async () => {
    const fake = sigstoreFake();
    const { repo, origin } = keylessRepo(fake.trustedRoot);
    await expect(publish(repo, { modules: modules() }, { signFetch: fake.fetch, env: fake.jobEnv(claims("other.yml")), parser: await parser() })).rejects.toThrow(/does not verify against the identity .* modules.attest.issuer and subject must name the job that publishes/);
    expect(git(origin, "tag", "--list").trim()).toBe("");
    expect(git(origin, "branch", "--list", "chant/lifecycle").trim()).toBe("");
  });

  it("asks for the trusted root and for an OIDC token, and says how to get each", async () => {
    const fake = sigstoreFake();
    const { repo } = keylessRepo(fake.trustedRoot);
    await expect(publish(repo, { modules: modules({ ...identity, trusted_root: "keys/root.json" }) }, { signFetch: fake.fetch, env: fake.jobEnv(claims()), parser: await parser() })).rejects.toThrow(/trusted root at keys\/root.json, which is not in the repo/);
    await expect(publish(repo, { modules: modules() }, { signFetch: fake.fetch, env: {}, parser: await parser() })).rejects.toThrow(/id-token: write/);
  });

  it("says on a dry run that it would sign, and reaches no authority", async () => {
    const fake = sigstoreFake();
    const { repo } = keylessRepo(fake.trustedRoot);
    const r = await publish(repo, { modules: modules() }, { dryRun: true, signFetch: fake.fetch, env: {}, parser: await parser() });
    expect(r[0].detail ?? "").toContain("sign and record");
    expect(fake.log.certificates).toEqual([]);
  });

  it("still verifies after the certificate expired", async () => {
    const fake = sigstoreFake({ now: new Date(Date.now() - 3 * 3600_000) });
    const { repo } = keylessRepo(fake.trustedRoot);
    await publish(repo, { modules: modules() }, { signFetch: fake.fetch, env: fake.jobEnv(claims()), parser: await parser() });
    const checks = await verifyPublished(repo, { modules: modules() }, "modules/service", "0.1.0");
    expect(checks[0]).toHaveProperty("verified");
  });
});

describe("modules.require: attested with an identity", () => {
  async function released() {
    const fake = sigstoreFake();
    const ctx = keylessRepo(fake.trustedRoot);
    await publish(ctx.repo, { modules: modules() }, { signFetch: fake.fetch, env: fake.jobEnv(claims()), parser: await parser() });
    return { ...ctx, fake };
  }
  const check = async (repo: string, m: ModulesSettings) => checkRootPins(repo, "envs/dev", checkedSources(repo, await governingModules(repo, m, undefined)), await parser());

  it("passes a pin of this repo's keyless release", async () => {
    const { repo, pin } = await released();
    pin("0.1.0");
    const r = await check(repo, { ...modules(), require: "attested" });
    expect(r.refused).toEqual([]);
    expect(r.verified).toHaveLength(1);
  });

  it("passes a pin of a trusted publisher named by its identity, and refuses one whose identity differs", async () => {
    const { repo, url } = await released();
    // A publisher in another repo is read at the URL the pin names.
    write(repo, { "envs/dev/main.tf": `module "service" {\n  source = "git::${url}//modules/service?ref=modules/service/v0.1.0"\n}\n` });
    const trusted = (subject: string): ModulesSettings => ({ require: "attested", trusted: [{ source: `git::${url}`, identity: { issuer: FAKE_GITHUB_ISSUER, subject }, ledger: url }] });
    expect((await check(repo, trusted(SUBJECT))).refused).toEqual([]);
    // A pattern over the ref is the way to trust any branch of the workflow.
    expect((await check(repo, trusted("https://github.com/acme/infra/.github/workflows/terragucci.yml@refs/heads/*"))).refused).toEqual([]);
    const other = await check(repo, trusted("https://github.com/acme/other/.github/workflows/terragucci.yml@refs/heads/main"));
    expect(other.refused).toHaveLength(1);
    expect(other.refused[0].why).toMatch(/is not one the policy at base lists|does not verify against the trusted identity/);
  });

  it("refuses a release when the trusted root is another authority's", async () => {
    const { repo, pin } = await released();
    pin("0.1.0");
    write(repo, { ".chant/trusted_root.json": sigstoreFake().trustedRoot });
    const r = await check(repo, { ...modules(), require: "attested" });
    expect(r.refused[0].why).toMatch(/does not verify against the trusted identity/);
  });

  it("stops every root when the trusted root is missing or is not one", async () => {
    const { repo } = await released();
    write(repo, { "roots/empty.json": "{}" });
    await expect(governingModules(repo, { require: "attested", trusted: [{ source: "oci://r.example.com/a", identity: { issuer: "https://i", subject: "s" }, trusted_root: "roots/none.json", ledger: "https://g/a.git" }] }, undefined).then((g) => checkedSources(repo, g))).rejects.toThrow(/trusted root roots\/none.json is not in the repo/);
    await expect(governingModules(repo, { require: "attested", trusted: [{ source: "oci://r.example.com/a", identity: { issuer: "https://i", subject: "s" }, trusted_root: "roots/empty.json", ledger: "https://g/a.git" }] }, undefined).then((g) => checkedSources(repo, g))).rejects.toThrow(/not a sigstore trusted root/);
  });

  it("does not take a key's release for an identity's, or an identity's for a key's", async () => {
    const fake = sigstoreFake();
    const trust = keylessTrust({ issuer: FAKE_GITHUB_ISSUER, subject: SUBJECT, trustedRoot: fake.trustedRoot, trustedRootPath: "root.json" });
    const pair = keyPair();
    const dir = write(tmp("terragucci-kl-"), { blob: "bytes", "p.json": "{}" });
    const keyed = testSigner(pair.privateKey);
    const digest = `sha256:${execFileSync("shasum", ["-a", "256", `${dir}/blob`]).toString().split(" ")[0]}`;
    const attestation = await keyed.attestBlob(`${dir}/blob`, `${dir}/p.json`, "spdxjson");
    expect(() => verifyAttestation(attestation, digest, "https://spdx.dev/Document", trust, "SBOM attestation")).toThrow(/not signed keyless/);
    expect(() => verifySignature(JSON.stringify({ base64Signature: "AAAA" }), Buffer.from("bytes"), trust)).toThrow(AttestationError);
    const signer = keylessSigner(fake.jobEnv(claims()), { fetch: fake.fetch, fulcio: FAKE_FULCIO_URL, timestamp: FAKE_TSA_URL });
    const bundle = await signer.signBlob(`${dir}/blob`);
    expect(() => verifySignature(bundle, Buffer.from("bytes"), trust)).not.toThrow();
    expect(() => verifySignature(bundle, Buffer.from("other bytes"), trust)).toThrow(/does not verify against its certificate's key/);
    expect(() => verifySignature(bundle, Buffer.from("bytes"), publicKey(pair.pem, "cosign.pub"))).toThrow(/does not verify against the trusted key/);
  });
});
