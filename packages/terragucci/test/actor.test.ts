import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentTrailer, detectActor } from "../src/actor";
import { validateConfig } from "../src/config";
import { policyInput } from "../src/report/policy";
import { git, tmp } from "./helpers";

const AGENTS = ["my-agent[bot]"];

/** A repo whose head commit carries `message`, and an event file for a pull request authored by `author`. */
function setup(message: string, author?: string): { repo: string; env: NodeJS.ProcessEnv } {
  const repo = tmp();
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a"), "a");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", message);
  const event = join(repo, "..", `event-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(event, JSON.stringify({ pull_request: author ? { user: { login: author } } : {} }));
  return { repo, env: { GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "acme/infra", GITHUB_EVENT_NAME: "pull_request" } };
}

describe("detectActor", () => {
  // Every combination of the three signals. Only the forge identity decides kind.
  for (const identity of [false, true]) {
    for (const trailer of [false, true]) {
      for (const oidc of [false, true]) {
        const name = `forge identity ${identity ? "listed" : "not listed"}, trailer ${trailer ? "present" : "absent"}, oidc subject ${oidc ? "set" : "unset"}`;
        it(`${name}: ${identity ? "agent" : "person"}`, () => {
          const s = setup(`change${trailer ? "\n\nAssisted-by: Claude" : ""}`, identity ? "my-agent[bot]" : "alice");
          if (oidc) s.env.TG_OIDC_SUBJECT = "repo:acme/infra:environment:prod";
          const actor = detectActor(s.repo, s.env, AGENTS);
          expect(actor.kind).toBe(identity ? "agent" : "person");
          expect(actor.principal).toBe(identity ? "my-agent[bot]" : "alice");
          expect(actor.signals.forgeIdentity).toBe(actor.principal);
          expect(actor.signals.trailer).toBe(trailer ? "Claude" : undefined);
          // With TG_OIDC_SUBJECT unset the GitHub pull request default is still recorded.
          expect(actor.signals.oidcSubject).toBe(oidc ? "repo:acme/infra:environment:prod" : "repo:acme/infra:pull_request");
        });
      }
    }
  }

  it("is a person when the environment names no identity, with no agents listed, or the login is only similar", () => {
    const s = setup("c\n\nAssisted-by: Claude");
    expect(detectActor(s.repo, { GITHUB_EVENT_PATH: s.env.GITHUB_EVENT_PATH }, AGENTS)).toMatchObject({ kind: "person", principal: "unknown", signals: { trailer: "Claude" } });
    expect(detectActor(s.repo, { ...s.env, GITHUB_ACTOR: "my-agent[bot]" }, []).kind).toBe("person");
    expect(detectActor(s.repo, { ...s.env, GITHUB_ACTOR: "my-agent-two[bot]" }, AGENTS).kind).toBe("person");
  });

  it("reads the job's actor when the event has no pull request author, and matches ignoring case and the bot suffix", () => {
    const s = setup("c");
    expect(detectActor(s.repo, { ...s.env, GITHUB_ACTOR: "My-Agent" }, AGENTS)).toMatchObject({ kind: "agent", principal: "My-Agent" });
  });

  it("does not take the commit author for a signal", () => {
    const s = setup("c", "alice");
    git(s.repo, "-c", "user.name=my-agent[bot]", "-c", "user.email=a@x", "commit", "-q", "--amend", "--reset-author", "--no-edit");
    expect(detectActor(s.repo, s.env, AGENTS)).toMatchObject({ kind: "person", signals: { forgeIdentity: "alice" } });
  });
});

describe("agentTrailer", () => {
  it("reads a trailer in the last paragraph only", () => {
    expect(agentTrailer("c\n\nGenerated-by: Gemini")).toBe("Gemini");
    expect(agentTrailer("Assisted-by: Claude\n\nbody text")).toBeUndefined();
    expect(agentTrailer("c\n\nCo-authored-by: Alice <a@x>")).toBeUndefined();
    expect(agentTrailer("c\n\nCo-authored-by: Claude <noreply@anthropic.com>")).toBe("Claude <noreply@anthropic.com>");
  });
});

describe("policy.agents", () => {
  it("is a list of identities", () => {
    expect(() => validateConfig({ policy: { agents: ["my-agent[bot]"] } }, "terragucci.yml")).not.toThrow();
    expect(() => validateConfig({ policy: { agents: "my-agent" } }, "terragucci.yml")).toThrow(/policy\.agents must be a list/);
    expect(() => validateConfig({ policy: { agents: [] } }, "terragucci.yml")).toThrow(/policy\.agents must be a list/);
  });
});

describe("input.actor", () => {
  const plan = '{"resource_changes":[]}';
  const actor = { kind: "agent" as const, principal: "my-agent[bot]", signals: { forgeIdentity: "my-agent[bot]", trailer: "Claude" } };

  it("sits beside the plan's keys, and inside {plan, run, actor} with input: hcp", () => {
    expect(JSON.parse(policyInput({}, plan, { root: "a", actor }))).toEqual({ resource_changes: [], actor });
    expect(JSON.parse(policyInput({ input: "hcp" }, plan, { root: "a", actor })).actor).toEqual(actor);
  });

  it("is absent without an actor", () => {
    expect(policyInput({}, plan, { root: "a" })).toBe(plan);
  });
});

describe("example policy", () => {
  const rego = join(__dirname, "fixtures", "actor-policy", "agent.rego");
  const docs = readFileSync(join(__dirname, "..", "..", "..", "docs-site", "src", "content", "docs", "reference", "policy.mdx"), "utf-8");

  it("is the one reference/policy.mdx shows", () => {
    expect(docs).toContain(readFileSync(rego, "utf-8").trim());
  });

  const opa = spawnSync("opa", ["version"]).status === 0;
  const evaluate = (kind: string, actions: string[][]): { allow: unknown; hold: unknown } => {
    const dir = tmp();
    const input = join(dir, "input.json");
    writeFileSync(input, JSON.stringify({ actor: { kind, principal: "my-agent[bot]", signals: {} }, resource_changes: actions.map((a, i) => ({ address: `r.${i}`, change: { actions: a } })) }));
    const q = (rule: string) => JSON.parse(execFileSync("opa", ["eval", "--format", "json", "--data", rego, "--input", input, `data.main.${rule}`], { encoding: "utf-8" })).result?.[0]?.expressions?.[0]?.value;
    return { allow: q("allow_unattended"), hold: q("hold") };
  };

  it.skipIf(!opa)("lets a small agent change apply and holds a larger one, and says nothing of a person's", () => {
    expect(evaluate("agent", [["create"], ["update"]])).toMatchObject({ allow: expect.any(Array), hold: [] });
    expect((evaluate("agent", [["create"], ["update"]]).allow as unknown[]).length).toBe(1);
    expect((evaluate("agent", [["delete"]]).hold as unknown[]).length).toBe(1);
    expect((evaluate("agent", Array.from({ length: 6 }, () => ["create"])).hold as unknown[]).length).toBe(1);
    expect(evaluate("person", [["delete"]])).toEqual({ allow: [], hold: [] });
  });
});
