import { describe, expect, it } from "vitest";
import { resolutionRefusal, type ResolutionRecord } from "../src/apply";
import { agentLoginWarning, approvalModeOf, requireSignedOf, validateConfig } from "../src/config";
import type { Fetch } from "../src/forge";
import { AGENT_NOT_EXCLUDED, countable, forgeCommits, pullInvolvement, gitChange, involvedIn, judge, noreplyLogin, notCounted, requestedBy, tokenUsers, whyInvolved, type ChangeCommit } from "../src/involved";
import { gateSealPayload } from "../src/seal";
import { git, tmp, write } from "./helpers";
import { gateSigners, signerLine, sshsig, sshKey } from "./sshsig";

const A = "abc1234" + "0".repeat(33);
const B = "def5678" + "0".repeat(33);

/** A pull request alice opened, with her commit and the commit the agent made when carol asked for it. */
const agentAsked: ChangeCommit[] = [
  { sha: A, message: "Change asked for by carol on pull request #7\n\nadd a tag\n\nRequested-by: carol\nPushed-by: agent-bot\n", authorEmail: "terragucci-agent@localhost", committerEmail: "terragucci-agent@localhost" },
  { sha: B, message: "first draft\n", authorEmail: "1234+alice@users.noreply.github.com", committerEmail: "alice@example.com", authorLogin: "alice" },
];

describe("the people behind a change", () => {
  it("someone who asked the agent for a commit on another person's pull request: their review doesn't count, and the log says why", () => {
    const inv = involvedIn({ author: "alice", pr: 7, commits: agentAsked });
    expect(whyInvolved(inv, "carol")).toBe("carol asked for abc1234");
    const { by, excluded } = judge(["carol", "dave"], inv);
    expect(by).toEqual(["dave"]);
    expect(excluded).toEqual([{ login: "carol", reason: "carol asked for abc1234" }]);
    expect(notCounted(excluded[0]!, "review")).toBe("carol asked for abc1234, so carol's review doesn't count");
  });

  it("names the pull request's author and its commits' authors and committers, by login, noreply address and address", () => {
    const inv = involvedIn({ author: "alice", pr: 7, commits: agentAsked });
    expect(whyInvolved(inv, "ALICE")).toBe("alice opened pull request 7");
    expect(whyInvolved(inv, "alice@example.com")).toBe(`alice@example.com committed ${B.slice(0, 7)}`);
    expect(noreplyLogin("1234+alice@users.noreply.github.com")).toBe("alice");
    expect(noreplyLogin("77-bob@users.noreply.gitlab.com")).toBe("bob");
    expect(noreplyLogin("erin@noreply.forgejo.example")).toBe("erin");
    expect(noreplyLogin("erin@example.com")).toBeUndefined();
  });

  it("an approval by an uninvolved writer counts", () => {
    const inv = involvedIn({ author: "alice", pr: 7, commits: agentAsked, tokens: [{ which: "the pipeline's token", login: "pipeline-bot" }] });
    expect(judge(["dave"], inv)).toEqual({ by: ["dave"], excluded: [] });
    expect(countable(["dave"], undefined)).toEqual({ by: ["dave"], excluded: [] });
  });

  it("the agent's token's user: its review doesn't count, from GET /user with the token or the Pushed-by trailer", async () => {
    expect(whyInvolved(involvedIn({ commits: agentAsked }), "agent-bot")).toBe("agent-bot is the user the agent's token acts as, and it pushed abc1234");
    const f: Fetch = async (url, init) => {
      const token = init?.headers?.authorization;
      const login = token === "token agent-secret" ? "agent-bot" : token === "token pipeline-secret" ? "pipeline-bot" : undefined;
      return { ok: login !== undefined, status: login ? 200 : 403, json: async () => ({ login }), text: async () => "" } as never;
    };
    const tokens = await tokenUsers({ forge: "github", env: { GITHUB_API_URL: "https://forge.test/api/v3", TG_TOKEN: "pipeline-secret", AGENT_TOKEN: "agent-secret" }, fetch: f, agentTokenEnv: "AGENT_TOKEN" });
    expect(tokens).toEqual([
      { which: "the pipeline's token", login: "pipeline-bot" },
      { which: "the agent's token (AGENT_TOKEN)", login: "agent-bot" },
    ]);
    const inv = involvedIn({ commits: [], tokens });
    expect(judge(["agent-bot", "pipeline-bot", "dave"], inv).by).toEqual(["dave"]);
  });

  it("a token the forge names no user for is said in the log and judged as anyone, never assumed to be a person", async () => {
    const f: Fetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "" }) as never;
    const tokens = await tokenUsers({ forge: "github", env: { GITHUB_API_URL: "https://forge.test/api/v3", TG_TOKEN: "job-token" }, fetch: f, agentTokenEnv: "AGENT_TOKEN" });
    const inv = involvedIn({ commits: [], tokens });
    expect(inv.people).toEqual([]);
    expect(inv.notes).toEqual([
      "the pipeline's token: GET /user answered 403, so its user is unknown and an approval by it is judged as anyone's",
      "the agent's token (AGENT_TOKEN): this job does not hold it; a Pushed-by trailer on a commit it made names its user, so its user is unknown and an approval by it is judged as anyone's",
    ]);
  });

  it("a drift pull request a schedule opened: any human writer's review counts, and the bot's never does", () => {
    const drift: ChangeCommit[] = [{ sha: A, message: "Bring the code in line with drift issue #12\n\nWritten by the drift agent.\n\nPushed-by: drift-bot\n", authorEmail: "terragucci-agent@localhost", committerEmail: "terragucci-agent@localhost" }];
    const inv = involvedIn({ author: "drift-bot", pr: 9, commits: drift });
    expect(judge(["alice", "drift-bot", "bob"], inv)).toEqual({ by: ["alice", "bob"], excluded: [{ login: "drift-bot", reason: "drift-bot opened pull request 9" }] });
  });

  it("a drift pull request someone started by hand: that person's review doesn't count", () => {
    const drift: ChangeCommit[] = [{ sha: A, message: "Bring the code in line with drift issue #12\n\nRequested-by: carol\nPushed-by: drift-bot\n" }];
    const inv = involvedIn({ author: "drift-bot", pr: 9, commits: drift });
    expect(judge(["carol", "alice"], inv)).toEqual({ by: ["alice"], excluded: [{ login: "carol", reason: "carol asked for abc1234" }] });
  });

  it("reads Requested-by trailers, and refuses a value that is not a login", () => {
    expect(requestedBy("x\n\nRequested-by: carol\nrequested-by: Carol\nRequested-by: $(id)\n")).toEqual(["carol"]);
  });

  it("reads a pull request's commits as GitHub and Forgejo list them", () => {
    expect(forgeCommits([{ sha: A, commit: { message: "m\n\nRequested-by: carol", author: { email: "a@x" }, committer: { email: "c@x" } }, author: { login: "alice" }, committer: { login: "web-flow" } }, { nope: 1 }])).toEqual([
      { sha: A, message: "m\n\nRequested-by: carol", authorEmail: "a@x", committerEmail: "c@x", authorLogin: "alice", committerLogin: "web-flow" },
    ]);
  });

  it("reads the commits after base from git, leaving merge commits out", () => {
    const dir = write(tmp("tg-involved-"), { "a.tf": "# a\n" });
    git(dir, "init", "-q", "-b", "main");
    const commit = (who: string, msg: string) => git(dir, "-c", `user.name=${who}`, "-c", `user.email=${who}@example.com`, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg);
    git(dir, "add", "-A");
    commit("base", "base");
    const base = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "checkout", "-q", "-b", "fix");
    commit("alice", "change\n\nRequested-by: carol");
    git(dir, "checkout", "-q", "main");
    git(dir, "-c", "user.name=merger", "-c", "user.email=merger@example.com", "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "merge", "fix");
    const head = git(dir, "rev-parse", "HEAD").trim();
    const got = gitChange(dir, base, head);
    expect(got.note).toBeUndefined();
    expect(got.commits.map((c) => c.authorEmail)).toEqual(["alice@example.com"]);
    const inv = involvedIn({ commits: got.commits });
    expect(whyInvolved(inv, "carol")).toMatch(/^carol asked for [0-9a-f]{7}$/);
    expect(whyInvolved(inv, "merger@example.com")).toBeUndefined();
  });
});

describe("ledger approvals under the rule", () => {
  const inv = involvedIn({ author: "alice", pr: 7, commits: agentAsked });
  const base: ResolutionRecord = { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "dave", timestamp: "2026-10-04T10:00:00.000Z", planDigest: "sha256:abc" };
  const carolKey = sshKey();
  const daveKey = sshKey();
  const signers = gateSigners(`${signerLine("github:carol", carolKey)}\n${signerLine("dave", daveKey)}\n`);
  const sealed = (r: ResolutionRecord, key: ReturnType<typeof sshKey>): ResolutionRecord => ({ ...r, seal: { signer: r.resolvedBy, key: "SHA256:x", signature: sshsig(key, gateSealPayload(r), "chant-gate") } });

  it("an unsigned approval by someone uninvolved counts; one that names someone behind the change doesn't", () => {
    expect(resolutionRefusal(base, { involved: inv, signers })).toBeNull();
    expect(resolutionRefusal({ ...base, resolvedBy: "Alice" }, { involved: inv, signers })).toEqual({ reason: "alice opened pull request 7, so Alice's approval doesn't count", excluded: [{ login: "Alice", reason: "alice opened pull request 7" }] });
  });

  it("a signed approval is its signer's: a principal behind the change is refused, with a forge prefix mapped to the login", () => {
    const carol = sealed({ ...base, resolvedBy: "github:carol" }, carolKey);
    expect(resolutionRefusal(carol, { involved: inv, signers })?.reason).toBe("carol asked for abc1234, so github:carol's approval doesn't count");
    expect(resolutionRefusal(sealed(base, daveKey), { involved: inv, signers, requireSigned: true })).toBeNull();
  });

  it("approval.require_signed refuses an unsigned approval, and one whose seal does not verify, whoever it names", () => {
    expect(resolutionRefusal(base, { involved: inv, signers, requireSigned: true })?.reason).toMatch(/the approval by dave is not signed, and approval.require_signed counts only a signed one/);
    expect(resolutionRefusal(sealed(base, carolKey), { involved: inv, signers, requireSigned: true })?.reason).toMatch(/is signed, and its seal does not verify/);
  });

  it("a review recorded under pr-review counts while one of its reviewers had no hand in the change", () => {
    const review: ResolutionRecord = { ...base, resolvedBy: "carol,dave", via: "pr-review", pr: 7, head: A, reviewers: ["carol", "dave"] };
    expect(resolutionRefusal(review, { involved: inv, signers })).toBeNull();
    expect(resolutionRefusal({ ...review, reviewers: ["carol"] }, { involved: inv, signers })?.reason).toBe("carol asked for abc1234, so carol's review doesn't count");
  });
});

describe("approval.require_signed", () => {
  it("is a map key beside the mode, and the string form still names the mode", () => {
    expect(() => validateConfig({ approval: { mode: "ledger", require_signed: true } }, "terragucci.yml")).not.toThrow();
    expect(() => validateConfig({ approval: { mode: "ledger", require_signed: "yes" } }, "terragucci.yml")).toThrow(/require_signed must be true or false/);
    expect(() => validateConfig({ approval: { signed: true } }, "terragucci.yml")).toThrow(/approval.signed is not a key of approval/);
    expect(approvalModeOf({ mode: "sealed", require_signed: true })).toBe("sealed");
    expect(approvalModeOf("pr-review")).toBe("pr-review");
    expect(requireSignedOf({ require_signed: true })).toBe(true);
    expect(requireSignedOf("ledger")).toBe(false);
  });
});

describe("agent.login", () => {
  const untouched: ChangeCommit[] = [{ sha: B, message: "alice's own change\n", authorLogin: "alice", authorEmail: "alice@example.com" }];

  it("a review by agent.login on a pull request the agent never touched doesn't count, whatever its case", () => {
    const inv = involvedIn({ author: "alice", pr: 7, commits: untouched, agentLogin: "acme-agent" });
    expect(judge(["Acme-Agent", "dave"], inv)).toEqual({ by: ["dave"], excluded: [{ login: "Acme-Agent", reason: "acme-agent is the account the agent's token acts as (agent.login)" }] });
  });

  it("a ledger approval in agent.login's name doesn't count", () => {
    const inv = involvedIn({ commits: untouched, agentLogin: "acme-agent" });
    const r: ResolutionRecord = { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "github:acme-agent", timestamp: "2026-10-04T10:00:00.000Z", planDigest: "sha256:abc" };
    expect(resolutionRefusal(r, { involved: inv })?.reason).toBe("acme-agent is the account the agent's token acts as (agent.login), so github:acme-agent's approval doesn't count");
  });

  it("the forge's pull request reads put agent.login in the set, and say so when agent.token_env is set without it", async () => {
    const calls = { repo: "acme/infra", get: async () => [], post: async () => null };
    const f: Fetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "" }) as never;
    const pr = { number: 7, head: B, author: "alice" };
    const withLogin = await pullInvolvement({ forge: "github", calls, pr, env: {}, fetch: f, agentTokenEnv: "AGENT_TOKEN", agentLogin: "acme-agent" });
    expect(judge(["acme-agent"], withLogin).by).toEqual([]);
    expect(withLogin.notes).not.toContain(AGENT_NOT_EXCLUDED);
    const without = await pullInvolvement({ forge: "github", calls, pr, env: {}, fetch: f, agentTokenEnv: "AGENT_TOKEN" });
    expect(without.notes).toContain(AGENT_NOT_EXCLUDED);
    expect(AGENT_NOT_EXCLUDED).toMatch(/^the agent's account isn't excluded: set agent.login/);
  });

  it("config check warns when agent.token_env is set without agent.login, and the key takes a login", () => {
    expect(agentLoginWarning({ token_env: "AGENT_FORGE_TOKEN" })).toBe("agent.token_env is set without agent.login, so the agent's account isn't excluded from approving a change: set agent.login to the login AGENT_FORGE_TOKEN's token acts as");
    expect(agentLoginWarning({ token_env: "AGENT_FORGE_TOKEN", login: "acme-agent" })).toBeUndefined();
    expect(agentLoginWarning(undefined)).toBeUndefined();
    expect(() => validateConfig({ agent: { via: "forge", token_env: "AGENT_FORGE_TOKEN", login: "acme-agent" } }, "terragucci.yml")).not.toThrow();
    expect(() => validateConfig({ agent: { via: "forge", token_env: "AGENT_FORGE_TOKEN", login: "$(id)" } }, "terragucci.yml")).toThrow(/agent.login must be the forge login/);
  });
});
