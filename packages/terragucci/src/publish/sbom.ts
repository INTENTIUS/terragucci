/**
 * A module release's SBOM: an SPDX 2.3 JSON document written from the
 * module's own HCL. It names the module, the providers its
 * `required_providers` asks for (at the version its lock file holds, when it
 * has one, else at the constraint), and the modules it calls from outside
 * itself. A scanner such as syft reads only the lock file of a Terraform
 * directory, so the document is written here instead.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { moduleFiles } from "./archive";

export const SPDX_MEDIA_TYPE = "application/spdx+json";

interface SpdxPackage {
  SPDXID: string;
  name: string;
  versionInfo?: string;
  downloadLocation: string;
  filesAnalyzed: false;
  checksums?: { algorithm: "SHA256"; checksumValue: string }[];
  primaryPackagePurpose?: string;
  comment?: string;
}

export interface SpdxDocument {
  spdxVersion: "SPDX-2.3";
  dataLicense: "CC0-1.0";
  SPDXID: "SPDXRef-DOCUMENT";
  name: string;
  documentNamespace: string;
  creationInfo: { created: string; creators: string[] };
  packages: SpdxPackage[];
  relationships: { spdxElementId: string; relationshipType: string; relatedSpdxElement: string }[];
}

export interface SbomInput {
  /** The module directory on disk. */
  dir: string;
  /** Its path in the repo, such as `modules/service`. */
  rel: string;
  version: string;
  /** The release digest the SBOM describes (`sha256:...`). */
  digest: string;
  /** The terragucci version writing it. */
  tool: string;
  created?: string;
}

type Tree = Record<string, unknown>;
const list = (v: unknown): Tree[] => (Array.isArray(v) ? (v as Tree[]) : []);
const id = (kind: string, name: string): string => `SPDXRef-${kind}-${name.replace(/[^A-Za-z0-9.-]+/g, "-")}`;

/** A provider address as the registry names it: `hashicorp/aws` is `registry.terraform.io/hashicorp/aws`. */
export function providerAddress(source: string): string {
  const parts = source.toLowerCase().split("/");
  return parts.length === 3 ? parts.join("/") : parts.length === 2 ? `registry.terraform.io/${parts.join("/")}` : `registry.terraform.io/hashicorp/${parts[0]}`;
}

/** The version each provider is locked at in the module's `.terraform.lock.hcl`, by address without its host. */
async function lockedVersions(dir: string, parser: Hcl2Json): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const file = join(dir, ".terraform.lock.hcl");
  if (!existsSync(file)) return out;
  const tree = (await parser.parse(".terraform.lock.hcl", readFileSync(file, "utf-8"))) as Tree;
  for (const [addr, blocks] of Object.entries((tree.provider as Record<string, Tree[]> | undefined) ?? {})) {
    const v = list(blocks)[0]?.version;
    if (typeof v === "string") out.set(addr.toLowerCase().split("/").slice(-2).join("/"), v);
  }
  return out;
}

/** The SPDX document for one release of one module. */
export async function moduleSbom(input: SbomInput, parser: Hcl2Json): Promise<SpdxDocument> {
  const hex = input.digest.replace(/^sha256:/, "");
  const root = "SPDXRef-Module";
  const packages: SpdxPackage[] = [
    {
      SPDXID: root,
      name: input.rel,
      versionInfo: input.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      checksums: [{ algorithm: "SHA256", checksumValue: hex }],
      primaryPackagePurpose: "SOURCE",
    },
  ];
  const relationships: SpdxDocument["relationships"] = [{ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: root }];
  const providers = new Map<string, string | undefined>();
  const calls = new Map<string, { source: string; version?: string }>();
  for (const file of moduleFiles(input.dir).filter((f) => f.endsWith(".tf"))) {
    const tree = (await parser.parse(file, readFileSync(join(input.dir, file), "utf-8"))) as Tree;
    for (const tf of list(tree.terraform)) {
      for (const req of list(tf.required_providers)) {
        for (const [name, spec] of Object.entries(req)) {
          const s = typeof spec === "object" && spec !== null ? (spec as Tree) : {};
          const addr = providerAddress(typeof s.source === "string" ? s.source : name);
          const constraint = typeof s.version === "string" ? s.version : typeof spec === "string" ? spec : undefined;
          if (!providers.has(addr) || constraint) providers.set(addr, constraint);
        }
      }
    }
    for (const [name, blocks] of Object.entries((tree.module as Record<string, Tree[]> | undefined) ?? {})) {
      const b = list(blocks)[0];
      if (!b || typeof b.source !== "string" || /^\.{1,2}\//.test(b.source)) continue;
      calls.set(name, { source: b.source, ...(typeof b.version === "string" ? { version: b.version } : {}) });
    }
  }
  const locked = providers.size ? await lockedVersions(input.dir, parser) : new Map<string, string>();
  for (const [addr, constraint] of [...providers].sort(([a], [b]) => a.localeCompare(b))) {
    const pin = locked.get(addr.split("/").slice(-2).join("/"));
    const pkg = id("Provider", addr);
    packages.push({
      SPDXID: pkg,
      name: addr,
      ...(pin ? { versionInfo: pin } : constraint ? { versionInfo: constraint } : {}),
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      ...(pin && constraint ? { comment: `required as ${constraint}` } : !pin && constraint ? { comment: "a version constraint; the module has no lock file" } : {}),
    });
    relationships.push({ spdxElementId: root, relationshipType: "DEPENDS_ON", relatedSpdxElement: pkg });
  }
  for (const [name, call] of [...calls].sort(([a], [b]) => a.localeCompare(b))) {
    const pkg = id("ModuleCall", name);
    packages.push({ SPDXID: pkg, name: call.source, ...(call.version ? { versionInfo: call.version } : {}), downloadLocation: call.source, filesAnalyzed: false, comment: `module.${name}` });
    relationships.push({ spdxElementId: root, relationshipType: "DEPENDS_ON", relatedSpdxElement: pkg });
  }
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${input.rel} ${input.version}`,
    documentNamespace: `https://intentius.io/terragucci/spdx/${input.rel}/${input.version}/${hex}`,
    creationInfo: { created: input.created ?? new Date().toISOString(), creators: [`Tool: terragucci-${input.tool}`] },
    packages,
    relationships,
  };
}
