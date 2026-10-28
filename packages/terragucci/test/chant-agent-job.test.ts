// terragucci#1282 part i: agent.comment on chant's agent job (chant#4616, #4619), the plan job's read of the control
// repo through chant's controlNoteCheckout, and a standalone migration's history on chant's gated request.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_COMMAND, agentCommentInput } from "../src/agent-comment";
import { overrideChantNext, type ChantAgentJob, type ChantScheduledOpSpec } from "../src/chant-next";
import { validateConfig } from "../src/config";
import { CHANT_CONTROL_DIR_ENV, CONTROL_DIR_ENV, controlClaimsAt } from "../src/estate-ownership";
import { doneMigrations, finishedMigrationLines, migrationDetail, revertMigration } from "../src/migrate";
import { MIGRATE_APPLIED_FILE, ledgerEntries } from "../src/report/audit";
import { CHANT_AGENT_PATHS, CHANT_AGENT_SPEC_FILE, chantAgentCommand, chantAgentFiles, chantAgentOptions } from "../src/render-chant-agent";
import { commentsScript, MARKER, renderPipeline } from "../src/render";
import { tmp } from "./helpers";

const agent = agentCommentInput(validateConfig({ agent: { via: "forge", token_env: "AGENT_FORGE_TOKEN", comment: { max_turns: 12, timeout: 20, max_cost_usd: 3 } }, policy: { path: "rego" } }, "t"))!;

/** A chant with the agent job: the spec as productPipelineJobs builds it, and a generator that names the jobs it was given. */
function fakeAgentJob(seen: { words?: unknown[]; options?: unknown[] } = {}): ChantAgentJob {
  let active: unknown;
  const gen = (forge: string) => (ops: ChantScheduledOpSpec[], options?: Record<string, unknown>) => {
    (seen.options ??= []).push(options);
    (seen.words ??= []).push(active);
    return { files: [{ name: forge === "gitlab" ? "terragucci-agent.yml" : `${ops[0]!.name}.yml`, yaml: `# ${forge} agent jobs for ${ops[0]!.name}\nagent-job: {}\n` }] };
  };
  return {
    CI_AGENT_FLOOR: "0.124.55",
    productPipelineJobs: (_forge, _env, o) => ({ agent: { comment: "/terragucci agent", name: String((o.agent as Record<string, unknown>).name), spec: { name: String((o.agent as Record<string, unknown>).name), trigger: { kind: "pull_request" }, agent: { on: "comment", comment: "/terragucci agent", ...(o.agent as object) } } } }),
    productDriftAgent: (_w, _op, o) => ({ on: "drift", ...(o ?? {}) }),
    setActiveProductWords: (w) => {
      const was = active;
      active = w;
      return was;
    },
    generate: { github: gen("github"), gitlab: gen("gitlab"), forgejo: gen("forgejo") },
  };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("agent.comment on chant's agent job", () => {
  it("keeps the per-run budget on the default command and maps max_cost_usd to chant's daily maxCostUsd", () => {
    expect(chantAgentCommand(3)).toContain("--max-budget-usd 3");
    expect(chantAgentCommand()).not.toContain("--max-budget-usd");
    expect(chantAgentCommand()).toContain('--max-turns "$CHANT_AGENT_MAX_TURNS"');
    const o = chantAgentOptions(agent);
    expect(o).toMatchObject({ name: "terragucci-agent", keyEnv: "ANTHROPIC_API_KEY", timeout: 20, maxTurns: 12, maxCostUsd: 3, tokenEnv: "AGENT_FORGE_TOKEN" });
    expect(o.guarded).toEqual(expect.arrayContaining(["terragucci.yml", "terragucci.components.json", "rego/"]));
    expect(agent.command).toBe(AGENT_COMMAND);
    expect(chantAgentOptions({ ...agent, command: "my-agent" }).command).toBe("my-agent");
  });

  it("writes the spec and the agent's workflow in terragucci's words, and puts the active words back", () => {
    const seen: { words?: unknown[] } = {};
    const out = chantAgentFiles("github", "img:1", agent, MARKER, fakeAgentJob(seen))!;
    expect(out.files.map((f) => f.path)).toEqual([CHANT_AGENT_SPEC_FILE, CHANT_AGENT_PATHS.github]);
    expect(JSON.parse(out.files[0]!.content).ops[0].agent).toMatchObject({ on: "comment", maxCostUsd: 3 });
    expect(out.files[1]!.content.startsWith(MARKER)).toBe(true);
    expect((seen.words![0] as { product: string; commands: Record<string, string> }).product).toBe("terragucci");
    expect(Object.values((seen.words![0] as { commands: Record<string, string> }).commands).sort()).toEqual(["agent", "plan"]);
    expect(chantAgentFiles("github", "img:1", agent, MARKER, undefined)).toBeUndefined();
  });

  it("drops terragucci's agent jobs from the GitHub pipeline when chant has the job, and keeps them when not", () => {
    const input = { forge: "github" as const, binary: "tofu" as const, version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, agentComment: agent };
    const own = renderPipeline(input);
    expect(own.content).toContain("agent-push:");
    restore = overrideChantNext("agentJob", fakeAgentJob());
    const viaChant = renderPipeline(input);
    expect(viaChant.content).not.toContain("agent-push:");
    expect(viaChant.extra?.map((f) => f.path)).toEqual(expect.arrayContaining([CHANT_AGENT_SPEC_FILE, CHANT_AGENT_PATHS.github]));
  });

  it("includes chant's GitLab agent file on the comments stage and starts it with CHANT_AGENT_PR", () => {
    restore = overrideChantNext("agentJob", fakeAgentJob());
    const seen: { options?: unknown[] } = {};
    chantAgentFiles("gitlab", "img:1", agent, MARKER, fakeAgentJob(seen));
    expect(seen.options![0]).toMatchObject({ opsStage: "comments", opsFileName: "terragucci-agent.yml" });
    const gl = renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, agentComment: agent, comments: { schedule: "*/5 * * * *" } as never });
    expect(gl.content).toContain(`- local: ${CHANT_AGENT_PATHS.gitlab}`);
    expect(gl.content).toContain("$CHANT_AGENT_PR == null");
    expect(gl.content).toContain("--agent chant");
    expect(gl.extra?.map((f) => f.path)).toContain(CHANT_AGENT_PATHS.gitlab);
    expect(commentsScript([["a"]], undefined, false, { agent: "chant" })).toContain("--agent chant");
  });
});

describe("estate ownership with chant's read of the control repo", () => {
  it("reads terragucci's checkout when it is there, and says nothing when chant's read holds no entries", async () => {
    const root = tmp();
    const chantDir = join(root, "chant-control");
    mkdirSync(chantDir, { recursive: true });
    // No terragucci checkout, and chant's directory has no entries on a chant/lifecycle: no claims.
    expect(await controlClaimsAt(undefined, { [CONTROL_DIR_ENV]: join(root, "missing"), [CHANT_CONTROL_DIR_ENV]: chantDir })).toBeUndefined();
  });
});

describe("a migration's history on chant's gated request", () => {
  const record = {
    schema: 1,
    name: "0001-move",
    file: "migrations/0001-move.yml",
    file_digest: "sha256:file",
    change: "moves",
    moves: [],
    digest: "sha256:proof",
    status: "applied",
    roots: [{ root: "net", location: "s3://b/net.tfstate", before: { version_id: "v1", digest: "sha256:b" }, after: { version_id: "v2", digest: "sha256:a" }, proof: { changes: [] } }],
  } as never;
  const finished = (detail: Record<string, unknown>) => JSON.stringify({ version: 1, kind: "finished", op: "tf-migrate", gate: "0001-move", planDigest: "sha256:req", applied: "2026-10-28T00:00:00Z", result: "applied", timestamp: "2026-10-28T00:01:00Z", detail });

  it("reads revert and the pending list from the finished line, with no done.jsonl line", () => {
    const detail = { by: "alice", approved_by: "bob", ...migrationDetail(record, { digest: "sha256:file", kind: "moves" }) };
    const lines = finishedMigrationLines(finished(detail));
    expect(lines).toHaveLength(1);
    expect(doneMigrations(lines.join("\n")).get("0001-move")).toMatchObject({ status: "applied", file_digest: "sha256:file" });
    const revert = revertMigration("0001-move", lines.join("\n"));
    expect(revert.text).toContain("location: s3://b/net.tfstate");
    expect(revert.text).toContain('version_id: "v1"');
    expect(revert.text).toContain('from_version_id: "v2"');
  });

  it("skips a run refused under the lock and one that threw before it ended", () => {
    expect(finishedMigrationLines(finished({ result: "refused" }))).toEqual([]);
    expect(finishedMigrationLines(finished({}))).toEqual([]);
  });

  it("lists the finished line in the audit as a migration, with its roots as done.jsonl's were", () => {
    const detail = { by: "alice", approved_by: "bob", ...migrationDetail(record, { digest: "sha256:file", kind: "moves" }) };
    const [e] = ledgerEntries("github.com/acme/infra", MIGRATE_APPLIED_FILE, [{ text: finished(detail), commit: "c1" }] as never);
    expect(e).toMatchObject({ kind: "migration", what: "0001-move", result: "applied", who: "alice" });
    expect((e!.detail as { roots: unknown[] }).roots).toEqual([{ root: "net", location: "s3://b/net.tfstate", before: "v1", after: "v2" }]);
  });
});

