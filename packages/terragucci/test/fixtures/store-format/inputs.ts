/**
 * The inputs the store-format fixtures were written from. `old/` holds what
 * the release before chant's report-store format wrote for them
 * (terragucci.run/v1, terragucci.dora/v1, terragucci.audit/v1 lines), and
 * store-format.test.ts writes them again and compares.
 */
import type { AuditEntry } from "../../../src/report/audit";

export const NOW = new Date("2026-11-20T12:00:00.000Z");
export const PROJECT = "forgejo.example/acme/infra";
export const COMMIT = "4f1a9c0e2b7d8a1c3e5f7a9b0c2d4e6f8a1b3c5d";
const D = `sha256:${"a".repeat(64)}`;

/** Two waves, the second reading the first's state. */
export const RUN_WAVES = [["envs/dev/net"], ["envs/dev/app"]];
export const RUN_READS = new Map([["envs/dev/app", new Set(["envs/dev/net"])]]);

/** One entry of each source and a kind chant names otherwise (approval, apply) or not at all (unrecorded-write, migration). */
export const AUDIT_ENTRIES: AuditEntry[] = [
  { schema: "terragucci.audit/v1", id: "sha256:1", kind: "approval-requested", project: PROJECT, at: "2026-11-20T09:00:00.000Z", who: null, what: "wave-1", digest: D, result: "waiting", evidence: { source: "ledger", branch: "chant/lifecycle", path: "_gates/tf-apply.jsonl", commit: "c1" } },
  { schema: "terragucci.audit/v1", id: "sha256:2", kind: "approval", project: PROJECT, at: "2026-11-20T09:10:00.000Z", who: "bob", what: "wave-1", digest: D, result: "unsigned", evidence: { source: "ledger", branch: "chant/lifecycle", path: "_gates/tf-apply.jsonl", commit: "c2" } },
  { schema: "terragucci.audit/v1", id: "sha256:3", kind: "apply", project: PROJECT, at: "2026-11-20T09:20:00.000Z", who: "bob", what: "wave-1", digest: D, result: "applied", evidence: { source: "report", bucket: "s3://acme-reports", key: "r/x/report.json" }, detail: { roots: ["envs/dev/net"] } },
  { schema: "terragucci.audit/v1", id: "sha256:4", kind: "unrecorded-write", project: PROJECT, at: "2026-11-20T09:30:00.000Z", who: null, what: "envs/dev/net", digest: null, result: "unrecorded", evidence: { source: "state", location: "s3://state/net.tfstate", version_id: "v3" }, detail: { location: "s3://state/net.tfstate", current_version: "v3" } },
];
