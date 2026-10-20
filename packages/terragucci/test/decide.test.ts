/**
 * The typed-decision client (terragucci#29), against recorded responses.
 *
 * Where the fixtures come from:
 *
 *   fixtures/decide/jev-response.json is written from the Jev wire format as
 *   docs.typesafe.ai's API reference publishes it, transcribed in
 *   INTENTIUS/chant#2491 (first comment, "The wire format"): top-level `model`
 *   (the versioned id that answered), `answers` keyed by question name and
 *   `usage`; a noul answer carries only `noul`, a choice `choice`,
 *   `probabilities` and `confidence`, a score `score`, `legend`,
 *   `probabilities` keyed "0".."k-1" and `confidence`. Confidence follows
 *   Jev's `(n * max p - 1) / (n - 1)`. TypeSafe publishes no schema and no
 *   sample payload we could copy byte for byte, so the values are ours and the
 *   shape is theirs.
 *
 *   fixtures/decide/laya-response.json is laya-serve's full payload as Laya
 *   0.3.28's docs/http-api.md shows it (extra `answer_confidence`, `action`,
 *   `routing` and `usage` keys, and Laya's entropy confidence), with the same
 *   probabilities and the model id terragucci-decide stamps on it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, validateConfig } from "../src/config";
import { decide, isConfident, summarize, type DecideFetch, type DecideSettings, type Question } from "../src/decide";
import { QUESTIONS } from "../src/decide/questions";
import { LAYA_MODEL } from "../src/images";

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures/decide", name), "utf-8");

const QS: Record<string, Question> = {
  mismatch: QUESTIONS.prIntent,
  actor: QUESTIONS.driftActor,
  bump: QUESTIONS.versionBump,
  risk: { type: "score", instructions: "How risky is the change?", criteria: ["low", "medium", "high"] },
};
const STATE = { title: "retag email", description: "Tag change only.", summary: { destroy: 1, names: ["aws_ses_domain_identity.main"] } };

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function recorded(text: string, status = 200): { fetch: DecideFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: DecideFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { fetch, calls };
}

const JEV: DecideSettings = { backend: "jev", model: "jev-1.13.0", token_env: "TYPESAFE_API_KEY" };
const ENV = { TYPESAFE_API_KEY: "test-key" };

describe("decide", () => {
  it("with no decide: config, asks nothing and every decision is off", async () => {
    const { fetch, calls } = recorded(fixture("jev-response.json"));
    const r = await decide(undefined, STATE, QS, { fetch });
    expect(calls).toHaveLength(0);
    expect(Object.values(r.decisions).map((d) => d.status)).toEqual(["off", "off", "off", "off"]);
    expect(r.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(isConfident(r.decisions.mismatch)).toBe(false);
  });

  it("sends the Jev request shape: pinned model, state, questions without thresholds, bearer from token_env", async () => {
    const { fetch, calls } = recorded(fixture("jev-response.json"));
    await decide(JEV, STATE, { ...QS, mismatch: { ...QUESTIONS.prIntent, threshold: 0.9 } }, { fetch, env: ENV });
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(c.headers.authorization).toBe("Bearer test-key");
    expect(c.body.model).toBe("jev-1.13.0");
    expect(c.body.state).toEqual(STATE);
    const questions = c.body.questions as Record<string, Record<string, unknown>>;
    expect(Object.keys(questions)).toEqual(["mismatch", "actor", "bump", "risk"]);
    expect(questions.mismatch).toEqual({ type: "noul", instructions: QUESTIONS.prIntent.instructions, criteria: QUESTIONS.prIntent.criteria });
    expect(questions.risk.criteria).toEqual(["low", "medium", "high"]);
  });

  it("reads a recorded Jev response into typed decisions, gating on the answer's probability", async () => {
    const { fetch } = recorded(fixture("jev-response.json"));
    const r = await decide(JEV, STATE, QS, { fetch, env: ENV });
    expect(r.model).toBe("jev-1.13.0");
    expect(r.backend).toBe("jev");
    const { mismatch, actor, bump, risk } = r.decisions;
    expect(mismatch).toMatchObject({ status: "confident", answer: "true", probability: 0.91, threshold: 0.8 });
    expect(mismatch.probabilities?.false).toBeCloseTo(0.09);
    expect(actor).toMatchObject({ status: "confident", answer: "controller", probability: 0.84, threshold: 0.7 });
    expect(bump).toMatchObject({ status: "not-confident", answer: "minor", probability: 0.55 });
    expect(risk).toMatchObject({ status: "confident", answer: "medium", probability: 0.7, score: 1.1 });
    expect(isConfident(actor)).toBe(true);
    expect(isConfident(bump)).toBe(false);
  });

  it("uses the config's thresholds, then the question's own", async () => {
    const { fetch } = recorded(fixture("jev-response.json"));
    const r = await decide({ ...JEV, thresholds: { choice: 0.85, noul: 0.95 } }, STATE, { ...QS, bump: { ...QUESTIONS.versionBump, threshold: 0.5 } }, { fetch, env: ENV });
    expect(r.decisions.actor).toMatchObject({ status: "not-confident", threshold: 0.85 });
    expect(r.decisions.mismatch).toMatchObject({ status: "not-confident", threshold: 0.95 });
    expect(r.decisions.bump).toMatchObject({ status: "confident", threshold: 0.5 });
  });

  it.each(["von", "decider"] as const)("reads the same recorded response the same way for %s", async (backend) => {
    const jev = await decide(JEV, STATE, QS, { fetch: recorded(fixture("jev-response.json")).fetch, env: ENV });
    const { fetch, calls } = recorded(fixture("jev-response.json"));
    const r = await decide({ backend, url: "http://decide.local:9000/", model: "von-1" }, STATE, QS, { fetch });
    expect(calls[0].url).toBe("http://decide.local:9000/v1/systemone");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(r.decisions).toEqual(jev.decisions);
  });

  it("reads laya-serve's full payload, extra keys and all, the same way, and pins terragucci-decide's model by default", async () => {
    const jev = await decide(JEV, STATE, QS, { fetch: recorded(fixture("jev-response.json")).fetch, env: ENV });
    const { fetch, calls } = recorded(fixture("laya-response.json"));
    const r = await decide({ backend: "laya", url: "http://localhost:8790" }, STATE, QS, { fetch });
    expect(calls[0].body.model).toBe(LAYA_MODEL);
    expect(r.model).toBe(LAYA_MODEL);
    expect(r.decisions).toEqual(jev.decisions);
  });

  it("refuses an answer from a model other than the pinned one", async () => {
    const other = fixture("jev-response.json").replace('"jev-1.13.0"', '"jev-1.14.0"');
    const r = await decide(JEV, STATE, QS, { fetch: recorded(other).fetch, env: ENV });
    expect(r.model).toBe("jev-1.14.0");
    for (const d of Object.values(r.decisions)) {
      expect(d.status).toBe("unavailable");
      expect(d.reason).toBe("the service answered as jev-1.14.0, and decide.model pins jev-1.13.0");
    }
  });

  it("an HTTP error, an unreachable service or a malformed body makes every decision unavailable, without throwing", async () => {
    const http = await decide(JEV, STATE, QS, { fetch: recorded('{"detail":"questions.risk: too many levels"}', 422).fetch, env: ENV });
    expect(http.decisions.risk).toMatchObject({ status: "unavailable", reason: "the service answered HTTP 422: questions.risk: too many levels" });

    const down: DecideFetch = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8790");
    };
    const unreachable = await decide({ backend: "laya", url: "http://localhost:8790" }, STATE, QS, { fetch: down });
    expect(Object.values(unreachable.decisions).every((d) => d.status === "unavailable")).toBe(true);
    expect(unreachable.decisions.mismatch.reason).toBe("the service did not answer: connect ECONNREFUSED 127.0.0.1:8790");

    const garbled = await decide(JEV, STATE, QS, { fetch: recorded("<html>bad gateway</html>").fetch, env: ENV });
    expect(garbled.decisions.actor).toMatchObject({ status: "unavailable", reason: "the response is not JSON" });
  });

  it("an answer missing, of the wrong type or naming an unknown option is unavailable on its own", async () => {
    const body = JSON.parse(fixture("jev-response.json")) as { answers: Record<string, Record<string, unknown>> };
    delete body.answers.risk;
    body.answers.mismatch = { type: "unsupported" };
    body.answers.actor.choice = "aliens";
    const r = await decide(JEV, STATE, QS, { fetch: recorded(JSON.stringify(body)).fetch, env: ENV });
    expect(r.decisions.risk).toMatchObject({ status: "unavailable", reason: "the response has no answer for it" });
    expect(r.decisions.mismatch).toMatchObject({ status: "unavailable", reason: 'the answer\'s type is "unsupported", not noul' });
    expect(r.decisions.actor.status).toBe("unavailable");
    expect(r.decisions.bump.status).toBe("not-confident");
  });

  it("a token_env that is not set asks nothing", async () => {
    const { fetch, calls } = recorded(fixture("jev-response.json"));
    const r = await decide(JEV, STATE, QS, { fetch, env: {} });
    expect(calls).toHaveLength(0);
    expect(r.decisions.mismatch).toMatchObject({ status: "unavailable", reason: "TYPESAFE_API_KEY is not set" });
  });

  it("throws on a question the wire format cannot carry", async () => {
    await expect(decide(undefined, STATE, { q: { type: "score", instructions: "x", criteria: ["only"] } })).rejects.toThrow("is a score with 1 levels; use 2 to 10");
    await expect(decide(undefined, STATE, { q: { type: "choice", instructions: "x", criteria: { a: "a" } } })).rejects.toThrow("is a choice with 1 options");
    await expect(decide(undefined, STATE, { "bad name": QUESTIONS.prIntent })).rejects.toThrow("needs a name");
  });

  it("summarizes a decision in one line", async () => {
    const r = await decide(JEV, STATE, QS, { fetch: recorded(fixture("jev-response.json")).fetch, env: ENV });
    expect(summarize(r.decisions.actor, r)).toBe("actor: controller (0.84, threshold 0.70, jev-1.13.0)");
    expect(summarize(r.decisions.bump, r)).toBe("bump: minor (0.55, below the 0.70 threshold, so not used, jev-1.13.0)");
    const off = await decide(undefined, STATE, QS);
    expect(summarize(off.decisions.bump, off)).toBe("bump: not asked; decide is not configured");
  });
});

describe("decide: in terragucci.yml", () => {
  const problems = (decideBlock: unknown): string[] => {
    try {
      validateConfig({ decide: decideBlock }, "terragucci.yml");
      return [];
    } catch (e) {
      return (e as ConfigError).problems ?? [(e as Error).message];
    }
  };

  it("accepts each backend with what it needs", () => {
    expect(problems({ backend: "laya", url: "http://decide:8790" })).toEqual([]);
    expect(problems({ backend: "laya", url: "http://decide:8790", model: LAYA_MODEL, thresholds: { noul: 0.9, choice: 0.75 } })).toEqual([]);
    expect(problems({ backend: "jev", model: "jev-1.13.0", token_env: "TYPESAFE_API_KEY" })).toEqual([]);
    expect(problems({ backend: "von", url: "http://von:8000", model: "von-large-2026-09" })).toEqual([]);
  });

  it("names every problem", () => {
    expect(problems({ url: "http://decide:8790" })).toContain("config.decide.backend is missing; use one of laya, von, decider, jev");
    expect(problems({ backend: "gpt" })).toContain('config.decide.backend is "gpt"; use one of laya, von, decider, jev');
    expect(problems({ backend: "jev", model: "jev-latest" })).toEqual([
      "config.decide.model is jev-latest, an alias that moves when a new version ships; pin a versioned id, such as jev-1.13.0",
      "config.decide.token_env is missing; name the variable holding the Jev API key",
    ]);
    expect(problems({ backend: "decider", url: "http://d:1" })).toEqual(["config.decide.model is missing; pin the model version the decider service answers as"]);
    expect(problems({ backend: "laya" })).toEqual(["config.decide.url is missing; name the service's base URL"]);
    expect(problems({ backend: "laya", url: "decide:8790", thresholds: { noul: 1.5, vibe: 0.5 } })).toEqual([
      "config.decide.url must be an http or https URL, such as http://localhost:8790",
      "config.decide.thresholds.noul must be a probability above 0 and at most 1",
      "config.decide.thresholds.vibe is not a question type (types: noul, choice, score)",
    ]);
    expect(problems({ backend: "laya", url: "http://d:1", cache: true })).toContain("config.decide.cache is not a setting (settings: backend, url, model, token_env, thresholds)");
  });
});
