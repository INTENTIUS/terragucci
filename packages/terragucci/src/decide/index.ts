/**
 * Typed decisions (terragucci#28, #29): one small client for any service that
 * speaks the Jev request and response shape, `POST <url>/v1/systemone`.
 * terragucci's own `terragucci-decide` image (Laya on CPU) speaks it, and so do
 * Von, Decider and TypeSafe's Jev API, so `decide.backend` changes defaults and
 * checks, never the code that asks.
 *
 * How a use asks (the whole API is `decide`, `isConfident` and `summarize`):
 *
 *   const record = await decide(settings.decide, state, { mismatch: QUESTIONS.prIntent });
 *   const d = record.decisions.mismatch;
 *   if (isConfident(d) && d.answer === "true") raiseFlag(summarize(d, record));
 *   // anything else: the deterministic response, unchanged
 *
 * The rules every use keeps:
 *
 *   - With no `decide:` in the config, `decide` makes no request and every
 *     decision is `off`. An unreachable service, an HTTP error, a malformed
 *     answer or a model other than the pinned one makes every decision
 *     `unavailable`. `decide` never throws for any of these, so a use cannot
 *     fail a pipeline by asking.
 *   - A decision is `confident` only when the probability of its answer reaches
 *     the threshold: the question's own, else `decide.thresholds.<type>`, else
 *     DEFAULT_THRESHOLDS. The probability is read from `probabilities` (or
 *     `noul`), never from a backend's `confidence`: Jev and Laya define that
 *     number differently, so one threshold would gate differently per backend.
 *   - The state is the redacted report or text a person could read: no secret
 *     and no raw plan value. A decision flags, routes or suggests; it never
 *     approves, applies, resolves a gate or changes a digest.
 *   - The record names the backend, the model that answered and a digest of
 *     the state, so the decision can be replayed against another version.
 */
import { createHash } from "node:crypto";
import { DECIDE_BACKENDS, QUESTION_TYPES, type DecideBackend, type DecideSettings, type QuestionType } from "../config";
import { LAYA_MODEL } from "../images";

export { DECIDE_BACKENDS, QUESTION_TYPES };
export type { DecideBackend, DecideSettings, QuestionType };

/** TypeSafe's endpoint, the default `url` for `backend: jev`. */
export const JEV_URL = "https://api.typesafe.ai";

/** The probability an answer needs, per question type, when neither the question nor the config sets one. */
export const DEFAULT_THRESHOLDS: Record<QuestionType, number> = { noul: 0.8, choice: 0.7, score: 0.7 };

interface QuestionBase {
  /** What to decide, in a sentence. */
  instructions: string;
  /** This question's threshold, overriding the config's for its type. */
  threshold?: number;
}
/** Yes or no. The answer is the probability of `true`. */
export interface NoulQuestion extends QuestionBase {
  type: "noul";
  criteria: { true: string; false: string };
}
/** One of named options (2 to 255), each with a description. */
export interface ChoiceQuestion extends QuestionBase {
  type: "choice";
  criteria: Record<string, string>;
}
/** A level on an ordered scale (2 to 10 levels, lowest first). */
export interface ScoreQuestion extends QuestionBase {
  type: "score";
  criteria: string[];
}
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** What the model reads: text, a JSON object, or a list of texts. */
export type DecideState = string | Record<string, unknown> | string[];

export type DecisionStatus = "confident" | "not-confident" | "off" | "unavailable";

export interface Decision {
  question: string;
  type: QuestionType;
  /**
   * confident: answered at or above the threshold. not-confident: answered
   * below it. off: no `decide:` configured. unavailable: no usable answer.
   * Only `confident` may change what a use does.
   */
  status: DecisionStatus;
  /** noul: "true" or "false"; choice: the option; score: the most likely level's text. */
  answer?: string;
  /** The probability of `answer`. */
  probability?: number;
  /** Every option's probability; a noul's are `true` and `false`. */
  probabilities?: Record<string, number>;
  /** score only: the expected level, from 0 (the first level), which may fall between levels. */
  score?: number;
  threshold: number;
  /** Why the decision is off or unavailable. */
  reason?: string;
}

export interface DecisionRecord {
  backend?: DecideBackend;
  /** The endpoint asked, without credentials. */
  url?: string;
  /** The model that answered (or was asked for, when nothing answered). */
  model?: string;
  /** `sha256:<hex>` of the state as sent. */
  stateDigest: string;
  /** Milliseconds the request took, when one was made. */
  ms?: number;
  decisions: Record<string, Decision>;
}

/** What `decide` needs from fetch; the global fetch fits. */
export type DecideFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface DecideOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: DecideFetch;
  /** Default 30 000: a cold CPU service answers its first request slowly. */
  timeoutMs?: number;
}

/** Backends whose response names the versioned model that answered, so a mismatch is refused. */
const ECHOES_MODEL: Record<DecideBackend, boolean> = { laya: true, jev: true, von: false, decider: false };

/** A question terragucci itself declares is wrong when it breaks the wire format's limits; that is a bug, so it throws. */
function checkQuestion(name: string, q: Question): void {
  const bad = (why: string): never => {
    throw new Error(`decide: question ${name} ${why}`);
  };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) bad("needs a name of letters, digits, - and _");
  if (!q.instructions) bad("has no instructions");
  if (q.threshold !== undefined && !(q.threshold > 0 && q.threshold <= 1)) bad("has a threshold outside (0, 1]");
  if (q.type === "noul") {
    if (!q.criteria?.true || !q.criteria?.false) bad("is a noul and needs criteria.true and criteria.false");
  } else if (q.type === "choice") {
    const n = Object.keys(q.criteria ?? {}).length;
    if (n < 2 || n > 255) bad(`is a choice with ${n} options; use 2 to 255`);
  } else if (q.type === "score") {
    const n = q.criteria?.length ?? 0;
    if (n < 2 || n > 10) bad(`is a score with ${n} levels; use 2 to 10`);
  } else bad(`has type ${JSON.stringify((q as { type: unknown }).type)}; use noul, choice or score`);
}

function thresholdOf(q: Question, settings: DecideSettings | undefined): number {
  return q.threshold ?? settings?.thresholds?.[q.type] ?? DEFAULT_THRESHOLDS[q.type];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** The base URL's decision endpoint. */
export function endpointOf(settings: DecideSettings): string | undefined {
  const base = settings.url ?? (settings.backend === "jev" ? JEV_URL : undefined);
  if (!base) return undefined;
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/systemone") ? trimmed : `${trimmed}/v1/systemone`;
}

/** The model a request pins: `decide.model`, or for laya the version terragucci-decide serves. */
export function modelOf(settings: DecideSettings): string | undefined {
  return settings.model ?? (settings.backend === "laya" ? LAYA_MODEL : undefined);
}

/** Read one answer into a Decision, or say why it cannot be used. */
function readAnswer(name: string, q: Question, raw: unknown, threshold: number): Decision {
  const base = { question: name, type: q.type, threshold };
  const unusable = (reason: string): Decision => ({ ...base, status: "unavailable", reason });
  if (raw === null || typeof raw !== "object") return unusable("the response has no answer for it");
  const a = raw as Record<string, unknown>;
  if (a.type !== q.type) return unusable(`the answer's type is ${JSON.stringify(a.type)}, not ${q.type}`);
  let answer: string;
  let probability: number;
  let probabilities: Record<string, number>;
  let score: number | undefined;
  if (q.type === "noul") {
    if (!isNum(a.noul)) return unusable("the noul answer is not a probability");
    answer = a.noul >= 0.5 ? "true" : "false";
    probability = Math.max(a.noul, 1 - a.noul);
    probabilities = { true: a.noul, false: 1 - a.noul };
  } else {
    const p = a.probabilities;
    if (p === null || typeof p !== "object" || !Object.values(p).every(isNum)) return unusable("the answer has no probabilities");
    probabilities = p as Record<string, number>;
    if (q.type === "choice") {
      if (typeof a.choice !== "string" || !(a.choice in q.criteria)) return unusable(`the choice ${JSON.stringify(a.choice)} is not one of the options`);
      if (!isNum(probabilities[a.choice])) return unusable("the chosen option has no probability");
      answer = a.choice;
      probability = probabilities[a.choice];
    } else {
      // Probabilities are keyed by level index ("0".."k-1"); the answer is the likeliest level.
      const levels = q.criteria.map((_, i) => String(i));
      if (!levels.every((k) => isNum(probabilities[k]))) return unusable("the score's probabilities do not cover every level");
      const top = levels.reduce((best, k) => (probabilities[k] > probabilities[best] ? k : best), levels[0]);
      answer = q.criteria[Number(top)];
      probability = probabilities[top];
      if (typeof a.score === "number" && Number.isFinite(a.score)) score = a.score;
    }
  }
  return { ...base, status: probability >= threshold ? "confident" : "not-confident", answer, probability, probabilities, ...(score === undefined ? {} : { score }) };
}

/**
 * Ask the configured service every question over one state. Resolves to a
 * decision per question; never rejects for anything the service or the network
 * does. With `settings` undefined (no `decide:`), no request is made.
 */
export async function decide(
  settings: DecideSettings | undefined,
  state: DecideState,
  questions: Record<string, Question>,
  options: DecideOptions = {},
): Promise<DecisionRecord> {
  for (const [name, q] of Object.entries(questions)) checkQuestion(name, q);
  const stateDigest = `sha256:${createHash("sha256").update(JSON.stringify(state)).digest("hex")}`;
  const every = (status: DecisionStatus, reason: string): Record<string, Decision> =>
    Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, { question: name, type: q.type, status, threshold: thresholdOf(q, settings), reason }]));

  if (!settings) return { stateDigest, decisions: every("off", "decide is not configured") };
  const url = endpointOf(settings);
  const model = modelOf(settings);
  const head = { backend: settings.backend, url, model, stateDigest };
  if (!url) return { ...head, decisions: every("unavailable", "decide.url is not set") };

  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (settings.token_env) {
    const token = (options.env ?? process.env)[settings.token_env];
    if (!token) return { ...head, decisions: every("unavailable", `${settings.token_env} is not set`) };
    headers.authorization = `Bearer ${token}`;
  }
  // The wire format has no threshold field; thresholds stay on this side.
  const wire = Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, { type: q.type, instructions: q.instructions, criteria: q.criteria }]));
  const body = JSON.stringify({ ...(model ? { model } : {}), state, questions: wire });

  const doFetch = options.fetch ?? (globalThis.fetch as unknown as DecideFetch);
  const started = Date.now();
  let status: number;
  let text: string;
  try {
    const res = await doFetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
    status = res.status;
    text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { detail?: unknown; error?: unknown };
        const d = j.detail ?? j.error;
        if (d !== undefined) detail = typeof d === "string" ? d : JSON.stringify(d);
      } catch {
        // not JSON: keep the text
      }
      return { ...head, ms: Date.now() - started, decisions: every("unavailable", `the service answered HTTP ${status}: ${detail}`) };
    }
  } catch (e) {
    return { ...head, ms: Date.now() - started, decisions: every("unavailable", `the service did not answer: ${(e as Error).message}`) };
  }
  const ms = Date.now() - started;

  let parsed: { model?: unknown; answers?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { ...head, ms, decisions: every("unavailable", "the response is not JSON") };
  }
  if (parsed === null || typeof parsed !== "object" || parsed.answers === null || typeof parsed.answers !== "object") {
    return { ...head, ms, decisions: every("unavailable", "the response has no answers") };
  }
  const answeredBy = typeof parsed.model === "string" ? parsed.model : undefined;
  if (ECHOES_MODEL[settings.backend] && model && answeredBy !== model) {
    return { ...head, model: answeredBy ?? model, ms, decisions: every("unavailable", `the service answered as ${answeredBy ?? "no model"}, and decide.model pins ${model}`) };
  }
  const answers = parsed.answers as Record<string, unknown>;
  const decisions = Object.fromEntries(
    Object.entries(questions).map(([name, q]) => [name, readAnswer(name, q, answers[name], thresholdOf(q, settings))]),
  );
  return { ...head, model: answeredBy ?? model, ms, decisions };
}

/** Whether a use may act on the decision. Everything but `confident` means the deterministic response. */
export function isConfident(d: Decision | undefined): d is Decision & { answer: string; probability: number } {
  return d?.status === "confident";
}

/** One line for a note or a report: the answer, its probability against the threshold, and the model. */
export function summarize(d: Decision, record: Pick<DecisionRecord, "model">): string {
  const by = record.model ? `, ${record.model}` : "";
  if (d.status === "off") return `${d.question}: not asked; decide is not configured`;
  if (d.status === "unavailable") return `${d.question}: no decision; ${d.reason}`;
  const p = (d.probability ?? 0).toFixed(2);
  const t = d.threshold.toFixed(2);
  if (d.status === "confident") return `${d.question}: ${d.answer} (${p}, threshold ${t}${by})`;
  return `${d.question}: ${d.answer} (${p}, below the ${t} threshold, so not used${by})`;
}
