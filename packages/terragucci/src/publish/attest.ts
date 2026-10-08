/**
 * `modules.attest`: each module release runs as a chant component that
 * terragucci writes from the publish config. Its phases archive the release,
 * write its SBOM, sign it, attest its SLSA provenance and its SBOM, check the
 * result against the repo's public key, and make the release ledger record.
 * The caller writes the record and the tag together (publish/index.ts).
 *
 * The component is chant's contract (`Component`, `projectToJson`) and its
 * steps dispatch through a chant `CapabilityRegistry` by kind. The phases run
 * in order here rather than through chant's interpret driver, which would add
 * its whole gate and lifecycle layer to the bundle for a run with no gates.
 *
 * Signing is cosign with the key the publish job is given
 * (`COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD`), and never the transparency log:
 * every cosign call passes `--tlog-upload=false`, so no module name or digest
 * leaves the repo and its registry. The provenance predicate is chant's
 * (`buildProvenanceStatement`).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, DeployContext } from "@intentius/chant/components/capability";
import { CapabilityRegistry } from "@intentius/chant/components/capability";
import { projectToJson, type Component, type Phase } from "@intentius/chant/components/component";
import { buildProvenanceStatement } from "@intentius/chant/components/verbs/sign";
import type { ReleaseRecord } from "@intentius/chant/lifecycle/release-ledger";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { version as TOOL_VERSION } from "../../package.json";
import { ConfigError } from "../config";
import { sha256 } from "./archive";
import { ATTEST_FILES, attestDir, LEDGER_ENV, releaseRecord } from "./ledger";
import { moduleSbom } from "./sbom";
import { PROVENANCE_TYPE, publicKey, SPDX_TYPE, verifyAttestation, verifySignature } from "./verify";

/** The public key `attest: true` reads. */
export const DEFAULT_KEY = "cosign.pub";
/** The secrets the publish job signs with: cosign's own variable names. */
export const KEY_ENV = "COSIGN_PRIVATE_KEY";
export const PASSWORD_ENV = "COSIGN_PASSWORD";
/** The build type a release's provenance names. */
export const BUILD_TYPE = "https://intentius.io/terragucci/module-release/v1";

export type AttestSetting = boolean | { key?: string } | undefined;

/** The public key's path, or undefined when attest is off. */
export function attestKey(attest: AttestSetting): string | undefined {
  if (!attest) return undefined;
  return (attest === true ? undefined : attest.key) ?? DEFAULT_KEY;
}

/** One release to attest: what it is and the bytes its tag names. */
export interface ReleaseInput {
  /** The module's path in the repo, such as `modules/service`. */
  module: string;
  /** The module directory on disk. */
  dir: string;
  version: string;
  /** `git-tags` or the oci:// address. */
  target: string;
  /** The tag or reference the release is published as. */
  ref: string;
  /** The bytes whose digest is the release digest. */
  bytes: Buffer;
  commit: string;
}

/** What a release adds to the ledger: its record and the files beside it. */
export interface Attested {
  digest: string;
  record: ReleaseRecord;
  /** Paths on chant/lifecycle and their contents. */
  files: Record<string, string>;
  /** The SBOM and provenance predicate files, for attaching to an OCI tag. */
  predicates: { provenance: string; sbom: string };
  component: Component;
}

/** The kebab-case component name chant wants for a module path. */
export const componentName = (module: string): string =>
  `module-${module.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;

const one = (name: string, kind: string, params: Record<string, unknown> = {}): Phase => ({ phase: name, steps: [{ kind, ...params }] });

/** The chant component one release runs as. */
export function releaseComponent(r: Pick<ReleaseInput, "module" | "version" | "target" | "ref">, key: string): Component {
  return {
    name: componentName(r.module),
    archetype: "producer-library",
    dependsOn: [],
    build: { kind: "module-archive", context: r.module, sbom: { format: "spdx" } },
    deploy: [
      one("Archive", "module-archive", { module: r.module, version: r.version, target: r.target, ref: r.ref }),
      one("Sbom", "module-sbom", { subject: "@Archive.digest" }),
      one("Sign", "sign-blob", { blob: "@Archive.path" }),
      one("Provenance", "attest-provenance", { blob: "@Archive.path", digest: "@Archive.digest" }),
      one("SbomAttestation", "attest-sbom", { blob: "@Archive.path", predicate: "@Sbom.path" }),
      one("Verify", "verify-attestations", { digest: "@Archive.digest", key, signature: "@Sign.bundle", provenance: "@Provenance.bundle", sbom: "@SbomAttestation.bundle" }),
      one("Record", "release-record", { digest: "@Archive.digest" }),
    ],
  };
}

/** Signs with cosign; a test hands in another. Each call writes a bundle and returns its text. */
export interface Signer {
  signBlob(blob: string): Promise<string>;
  attestBlob(blob: string, predicate: string, type: "slsaprovenance1" | "spdxjson"): Promise<string>;
  /** Attach a signature and the two attestations to an OCI manifest digest. */
  attachOci?(ref: string, predicates: { provenance: string; sbom: string }, registry: OciAccess): Promise<void>;
}

export interface OciAccess {
  user?: string;
  password?: string;
  insecure?: boolean;
  /** A CA file the registry's certificate chains to (`NODE_EXTRA_CA_CERTS`). */
  ca?: string;
}

/** The release's steps, bound to one release, as chant capabilities. */
export function releaseCapabilities(r: ReleaseInput, deps: { signer: Signer; parser: Hcl2Json; publicKey: string; keyPath: string; work: string; env: NodeJS.ProcessEnv }): CapabilityRegistry {
  const file = (name: string): string => join(deps.work, name);
  const caps: Capability<Record<string, string>, Record<string, unknown>>[] = [
    {
      kind: "module-archive",
      async run() {
        writeFileSync(file("subject"), r.bytes);
        return { digest: sha256(r.bytes), path: file("subject") };
      },
    },
    {
      kind: "module-sbom",
      async run(_ctx, input) {
        const doc = await moduleSbom({ dir: r.dir, rel: r.module, version: r.version, digest: input.subject, tool: TOOL_VERSION }, deps.parser);
        const text = `${JSON.stringify(doc, null, 2)}\n`;
        writeFileSync(file(ATTEST_FILES.sbom), text);
        return { path: file(ATTEST_FILES.sbom), text };
      },
    },
    { kind: "sign-blob", async run(_ctx, input) { return { bundle: await deps.signer.signBlob(input.blob) }; } },
    {
      kind: "attest-provenance",
      async run(_ctx, input) {
        const { predicate } = buildProvenanceStatement({
          imageRef: `${r.ref}@${input.digest}`,
          provenance: { sourceRef: r.commit, artifactDigest: input.digest },
          builderId: builderId(deps.env),
          buildType: BUILD_TYPE,
          externalParameters: { module: r.module, version: r.version, target: r.target, ref: r.ref },
          ...(deps.env.GITHUB_RUN_ID || deps.env.CI_PIPELINE_ID ? { invocationId: deps.env.GITHUB_RUN_ID || deps.env.CI_PIPELINE_ID } : {}),
        });
        const path = file("provenance.json");
        writeFileSync(path, JSON.stringify(predicate));
        return { bundle: await deps.signer.attestBlob(input.blob, path, "slsaprovenance1"), path };
      },
    },
    { kind: "attest-sbom", async run(_ctx, input) { return { bundle: await deps.signer.attestBlob(input.blob, input.predicate, "spdxjson") }; } },
    {
      kind: "verify-attestations",
      async run(_ctx, input) {
        // The bundles verify against the key the repo publishes, or nothing is written: a job given another key fails here.
        const key = publicKey(deps.publicKey, deps.keyPath);
        try {
          verifySignature(input.signature, r.bytes, key);
          verifyAttestation(input.provenance, input.digest, PROVENANCE_TYPE, key, "provenance");
          verifyAttestation(input.sbom, input.digest, SPDX_TYPE, key, "SBOM attestation");
        } catch (e) {
          throw new ConfigError(`${r.module} ${r.version}: what ${KEY_ENV} signed does not verify against ${deps.keyPath}: ${(e as Error).message}; the secret and the committed public key must be one key pair`);
        }
        return { verified: true };
      },
    },
    {
      kind: "release-record",
      async run(_ctx, input) {
        return { record: releaseRecord(r.module, input.digest, r.commit, deps.env) };
      },
    },
  ];
  const registry = new CapabilityRegistry();
  for (const c of caps) registry.register(c);
  return registry;
}

function builderId(env: NodeJS.ProcessEnv): string {
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  if (env.CI_PIPELINE_URL) return env.CI_PIPELINE_URL;
  return "https://intentius.io/terragucci/publish";
}

/** Resolve `@Phase.field` against the phases run so far; other values pass as they are. */
function wire(value: unknown, outputs: Record<string, Record<string, unknown>>): unknown {
  if (typeof value !== "string" || !value.startsWith("@")) return value;
  const [phase, field] = value.slice(1).split(".");
  const out = outputs[phase!]?.[field!];
  if (out === undefined) throw new Error(`${value} names no output of an earlier phase`);
  return out;
}

/** Run the component's phases in order, each step dispatched by kind. Returns each phase's output. */
export async function runComponent(component: Component, registry: CapabilityRegistry): Promise<Record<string, Record<string, unknown>>> {
  const outputs: Record<string, Record<string, unknown>> = {};
  const ctx: DeployContext = { env: LEDGER_ENV, component: component.name };
  for (const p of component.deploy) {
    for (const step of p.steps) {
      if (!("kind" in step) || step.kind === "gate") throw new Error(`${component.name}: phase ${p.phase} holds a step a release cannot run`);
      const { kind, ...params } = step as { kind: string } & Record<string, unknown>;
      const input = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, wire(v, outputs)]));
      outputs[p.phase] = (await registry.resolve(kind).run(ctx, input as never)) as Record<string, unknown>;
    }
  }
  return outputs;
}

/** Attest one release: run its component and gather what the ledger gets. */
export async function attestRelease(r: ReleaseInput, deps: { signer: Signer; parser: Hcl2Json; publicKey: string; keyPath: string; env?: NodeJS.ProcessEnv }): Promise<Attested> {
  const work = mkdtempSync(join(tmpdir(), "terragucci-attest-"));
  try {
    const component = releaseComponent(r, deps.keyPath);
    const out = await runComponent(component, releaseCapabilities(r, { ...deps, work, env: deps.env ?? process.env }));
    const digest = out.Archive.digest as string;
    const dir = attestDir(digest);
    return {
      digest,
      record: out.Record.record as ReleaseRecord,
      component,
      files: {
        [`${dir}/${ATTEST_FILES.signature}`]: out.Sign.bundle as string,
        [`${dir}/${ATTEST_FILES.provenance}`]: out.Provenance.bundle as string,
        [`${dir}/${ATTEST_FILES.sbomAttestation}`]: out.SbomAttestation.bundle as string,
        [`${dir}/${ATTEST_FILES.sbom}`]: out.Sbom.text as string,
        [`${dir}/${ATTEST_FILES.component}`]: `${JSON.stringify(projectToJson(component), null, 2)}\n`,
      },
      predicates: { provenance: readFileSync(out.Provenance.path as string, "utf-8"), sbom: out.Sbom.text as string },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ── cosign ─────────────────────────────────────────────────────────────────

/** Never the transparency log, and never a prompt. */
const NO_TLOG = ["--yes", "--tlog-upload=false"];

/** The cosign signer the publish job uses: the key from `COSIGN_PRIVATE_KEY`, its password from `COSIGN_PASSWORD`. */
export function cosignSigner(env: NodeJS.ProcessEnv = process.env, cosign = "cosign"): Signer {
  if (!env[KEY_ENV]) throw new ConfigError(`modules.attest signs with the key in ${KEY_ENV}, which is not set; give the publish job the ${KEY_ENV} and ${PASSWORD_ENV} secrets`);
  const childEnv = { ...env, [PASSWORD_ENV]: env[PASSWORD_ENV] ?? "" };
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}): void => {
    const r = spawnSync(cosign, args, { env: { ...childEnv, ...extra }, encoding: "utf-8" });
    if (r.error) throw new ConfigError(`modules.attest needs cosign, which did not run (${r.error.message}); the terragucci images carry it`);
    if (r.status !== 0) throw new ConfigError(`cosign ${args[0]} failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
  };
  const bundle = (blob: string, name: string): string => `${blob}.${name}.bundle`;
  return {
    async signBlob(blob) {
      const out = bundle(blob, "signature");
      run(["sign-blob", ...NO_TLOG, "--key", `env://${KEY_ENV}`, "--bundle", out, blob]);
      return readFileSync(out, "utf-8");
    },
    async attestBlob(blob, predicate, type) {
      const out = bundle(blob, type);
      run(["attest-blob", ...NO_TLOG, "--key", `env://${KEY_ENV}`, "--type", type, "--predicate", predicate, "--bundle", out, blob]);
      return readFileSync(out, "utf-8");
    },
    async attachOci(ref, predicates, registry) {
      // Registry credentials go in a docker config of the call's own, never on a command line.
      const dir = mkdtempSync(join(tmpdir(), "terragucci-cosign-"));
      try {
        const host = ref.split("/")[0]!;
        if (registry.user) writeFileSync(join(dir, "config.json"), JSON.stringify({ auths: { [host]: { auth: Buffer.from(`${registry.user}:${registry.password ?? ""}`).toString("base64") } } }));
        const conn = [...(registry.insecure ? ["--allow-http-registry"] : []), ...(registry.ca ? ["--registry-cacert", registry.ca] : [])];
        const extra = { DOCKER_CONFIG: dir };
        writeFileSync(join(dir, "provenance.json"), predicates.provenance);
        writeFileSync(join(dir, "sbom.json"), predicates.sbom);
        run(["sign", ...NO_TLOG, ...conn, "--key", `env://${KEY_ENV}`, ref], extra);
        run(["attest", ...NO_TLOG, ...conn, "--key", `env://${KEY_ENV}`, "--type", "slsaprovenance1", "--predicate", join(dir, "provenance.json"), ref], extra);
        run(["attest", ...NO_TLOG, ...conn, "--key", `env://${KEY_ENV}`, "--type", "spdxjson", "--predicate", join(dir, "sbom.json"), ref], extra);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
