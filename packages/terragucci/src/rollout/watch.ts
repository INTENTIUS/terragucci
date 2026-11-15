/**
 * `rollouts.watch`: start a rollout when a module or provider a root uses has
 * a newer release.
 *
 * The `rollouts` job runs this after it has continued the rollouts in flight.
 * It reads each root on the default branch for the module calls that pin an
 * exact version and the providers its lock file holds, keeps the ones a rule
 * of `rollouts.watch` names, and asks the registry what has been released.
 * For each, the newest release that is a bump the rule follows, and old
 * enough, becomes the `to` of an ordinary rollout from the version the roots
 * are at. The rollout then runs as one a person started: a wave at a time,
 * the next only after the last merged and applied.
 *
 * A bot that already opens pull requests for the bump is the canary. Renovate
 * and Dependabot name their branches `renovate/` and `dependabot/`; a pull
 * request there that names the module or provider and the new version is the
 * canary wave. While it is open, the watch waits. Once it has merged and
 * applied, the roots it moved are at the new version, and the watch starts the
 * rollout for the roots that are not. A bot pull request closed without
 * merging is a person's no, and the watch starts nothing for that release.
 *
 * A module call whose `version` is a constraint is not followed: the
 * constraint already floats, and a release outside it needs the constraint
 * changed. `terragucci pin modules` turns those into exact pins, and the
 * watch follows them from then on.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { isTerragruntFile, readModulePin } from "@intentius/chant-lexicon-terraform/pin";
import { ConfigError, FOLLOW_DEFAULT, findConfig, loadConfig, resolveRepo, rolloutsWatch, ttlMs, type WatchRule } from "../config";
import { globMatch } from "../detect";
import { compareSemver, parseSemver } from "../publish/semver";
import { detectShape } from "../shape";
import { loadHclParser } from "./parser";
import { continueRollouts, openProjects, rollout, rootsOf, type InFlight, type RolloutOptions, type RolloutResult } from "./index";
import { appliedState, type CommitCheck, type ListedPullRequest, type RolloutForge } from "./forge";
import { LOCK_FILE, readLock } from "./lock";
import { pinFiles, pinVersion } from "./pins";
import { namesOf, pickRelease, plainReleases, registrySources, type ReleaseSources, type Subject } from "./releases";

export interface WatchOptions extends Omit<RolloutOptions, "kind" | "name" | "to" | "from" | "aliases" | "only"> {
  /** The rules. Default: the config's `rollouts.watch`. */
  watch?: WatchRule[];
  /** The releases a subject has and when. Default: the registries. */
  sources?: ReleaseSources;
  /** The rollouts in flight, when the caller has just read them. */
  inFlight?: InFlight[];
  now?: Date;
}

/**
 * `started`: wave 1 opened. `would-start`: it would open (the dry run).
 * `waiting-on-bot`: a Renovate or Dependabot pull request is the canary and
 * has not merged and applied. `in-flight`: a rollout of the subject is
 * running. `up-to-date`: nothing newer. `held`: a newer release exists that
 * no rule lets through yet. `stopped`: the bot's pull request was closed, or
 * its apply failed. `skipped`: it cannot be followed, and `reason` says why.
 * `failed`: the run threw.
 */
export type WatchAction = "started" | "would-start" | "waiting-on-bot" | "in-flight" | "up-to-date" | "held" | "stopped" | "skipped" | "failed";

export interface Watched {
  kind: Subject["kind"];
  name: string;
  /** The versions the roots pin, newest first. */
  at: string[];
  /** The newest release. */
  latest?: string;
  /** The version the rollout moves from and to, when there is one. */
  from?: string;
  to?: string;
  action: WatchAction;
  reason?: string;
  /** Roots whose call names a constraint, which the watch does not follow. */
  constraints?: string[];
  /** The Renovate or Dependabot pull request treated as the canary. */
  bot?: string;
  result?: RolloutResult;
}

export interface WatchResult {
  mode: "dry-run" | "apply";
  watched: Watched[];
}

/** 1 when a watched subject's run threw. */
export const watchExit = (r: WatchResult): number => (r.watched.some((w) => w.action === "failed") ? 1 : 0);

interface Seen {
  subject: Subject;
  rule: WatchRule;
  /** Roots by the exact version they pin. */
  pins: Map<string, string[]>;
  constraints: string[];
}

const isLocal = (source: string): boolean => /^\.\.?\//.test(source);

/** Every remote module call that pins an exact version or names a constraint, and every locked provider, by root. */
async function scan(dir: string, roots: string[], rules: WatchRule[], parser: Hcl2Json): Promise<Seen[]> {
  const found = new Map<string, Seen>();
  const ruleFor = (subject: Subject): WatchRule | undefined =>
    rules.find((r) => (subject.kind === "module" ? r.module : r.provider) !== undefined && namesOf(subject).some((n) => globMatch((subject.kind === "module" ? r.module : r.provider)!, n)));
  const seen = (subject: Subject): Seen | undefined => {
    const id = `${subject.kind}\0${subject.name}`;
    const held = found.get(id);
    if (held) return held;
    const rule = ruleFor(subject);
    if (!rule) return undefined;
    const s: Seen = { subject, rule, pins: new Map(), constraints: [] };
    found.set(id, s);
    return s;
  };
  for (const root of roots) {
    for (const file of pinFiles(dir, root)) {
      const tree = (await parser.parse(file, readFileSync(join(dir, file), "utf-8"))) as Record<string, unknown>;
      const bodies: Record<string, unknown>[] = isTerragruntFile(file)
        ? ((tree.terraform as Record<string, unknown>[] | undefined) ?? [])
        : Object.values((tree.module as Record<string, Record<string, unknown>[]> | undefined) ?? {}).flat();
      for (const body of bodies) {
        if (typeof body.source !== "string" || isLocal(body.source)) continue;
        const pin = readModulePin(body.source, typeof body.version === "string" ? body.version : undefined);
        const s = seen({ kind: "module", name: pin.module });
        if (!s) continue;
        if (pin.pin !== null) {
          const v = pinVersion(pin.pin);
          if (parseSemver(v)) s.pins.set(v, [...new Set([...(s.pins.get(v) ?? []), root])]);
        } else if (pin.at === "version" && /is a constraint/.test(pin.unpinned ?? "")) s.constraints.push(root);
      }
    }
    const lock = join(dir, root, LOCK_FILE);
    if (existsSync(lock)) {
      for (const [address, version] of readLock(readFileSync(lock, "utf-8"))) {
        const s = seen({ kind: "provider", name: address });
        if (s && parseSemver(version)) s.pins.set(version, [...new Set([...(s.pins.get(version) ?? []), root])]);
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.subject.name < b.subject.name ? -1 : a.subject.name > b.subject.name ? 1 : 0));
}

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a bot's pull request names the subject and moves it to `to`. */
function namesBump(pr: ListedPullRequest, subject: Subject, to: string): boolean {
  const text = `${pr.title}\n${pr.branch}\n${pr.body}`.toLowerCase();
  const named = namesOf(subject).some((n) => text.includes(n.toLowerCase().replace(/^oci:\/\//, "")));
  return named && new RegExp(`(?<![\\d.])v?${escaped(to)}(?![\\d.])`).test(text);
}

/** Whether a merge commit's apply has finished: per-root `apply/<root>` checks when there are some, else the apply jobs. */
export function botApply(checks: CommitCheck[]): CommitCheck["state"] {
  const own = checks.filter((c) => c.name.startsWith("apply/"));
  if (own.length > 0) return own.some((c) => c.state === "failure") ? "failure" : own.some((c) => c.state === "pending") ? "pending" : "success";
  return appliedState(checks, "");
}

type Canary = { state: "none" } | { state: "wait" | "stop"; url: string; reason: string } | { state: "applied"; url: string };

/** What the bots' pull requests for this bump say about starting the rollout. */
async function canaryOf(forge: RolloutForge, bots: ListedPullRequest[], subject: Subject, to: string): Promise<Canary> {
  const mine = bots.filter((pr) => namesBump(pr, subject, to));
  const open = mine.find((pr) => pr.state === "open");
  if (open) return { state: "wait", url: open.url, reason: `${open.url} is open from ${open.branch.split("/")[0]}; it is the canary, and the rollout starts for the other roots once it has merged and applied` };
  const merged = mine.find((pr) => pr.state === "merged");
  if (merged) {
    const found = await forge.findPullRequest(merged.branch);
    const checks = found?.mergeCommit ? await forge.commitChecks(found.mergeCommit) : [];
    const state = botApply(checks);
    if (state === "failure") return { state: "stop", url: merged.url, reason: `${merged.url} merged and its apply failed` };
    if (state === "pending") return { state: "wait", url: merged.url, reason: `${merged.url} merged and its apply has not reported` };
    return { state: "applied", url: merged.url };
  }
  const closed = mine.find((pr) => pr.state === "closed");
  if (closed) return { state: "stop", url: closed.url, reason: `${closed.url} was closed without merging, so ${subject.name} ${to} is left alone` };
  return { state: "none" };
}

export async function watchRollouts(cwd: string, options: WatchOptions = {}): Promise<WatchResult> {
  const mode = options.mode ?? "dry-run";
  let repo: string;
  try {
    repo = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new ConfigError("terragucci rollouts.watch runs in a git repository");
  }
  const configPath = options.config ?? findConfig(repo);
  const config = configPath ? await loadConfig(configPath) : {};
  const rules = options.watch ?? (config.projects ? [] : rolloutsWatch(resolveRepo(config).rollouts));
  if (rules.length === 0) return { mode, watched: [] };
  if (config.projects) throw new ConfigError("rollouts.watch reads the roots of one repository, so it runs in a repository with its roots, not a control repository");
  const refused = detectShape(repo, resolveRepo(config)).refuses("rollouts");
  if (refused) throw new ConfigError(`terragucci rollouts.watch: ${refused}`);

  const now = options.now ?? new Date();
  const sources = options.sources ?? registrySources({ fetch: options.registryFetch });
  const inFlight = options.inFlight ?? (await continueRollouts(repo, { ...passed(options), mode: "dry-run" })).rollouts;
  const parser = options.parser ?? (await loadHclParser("terragucci rollouts.watch reads module calls"));

  const projects: Awaited<ReturnType<typeof openProjects>> = [];
  let seen: Seen[];
  let forge: RolloutForge;
  let bots: ListedPullRequest[];
  try {
    await openProjects(repo, config, { ...passed(options), mode }, projects);
    const project = projects[0]!;
    seen = await scan(project.dir, rootsOf(project), rules, parser);
    forge = project.forge;
    bots = seen.length > 0 ? [...(await forge.listPullRequests("renovate/")), ...(await forge.listPullRequests("dependabot/"))] : [];
  } finally {
    for (const p of projects) p.cleanup();
  }

  const watched: Watched[] = [];
  for (const s of seen) {
    const { subject } = s;
    const at = [...s.pins.keys()].sort((a, b) => compareSemver(parseSemver(b)!, parseSemver(a)!));
    const w: Watched = { kind: subject.kind, name: subject.name, at, action: "up-to-date", ...(s.constraints.length > 0 ? { constraints: s.constraints } : {}) };
    watched.push(w);
    try {
      await decide(w, s, { options, mode, repo, sources, inFlight, forge, bots, now });
    } catch (e) {
      w.action = "failed";
      w.reason = (e as Error).message;
    }
  }
  return { mode, watched };
}

/** The options a nested read or rollout takes from the caller's. */
function passed(o: WatchOptions): Omit<RolloutOptions, "kind" | "name" | "to" | "from" | "mode"> {
  const { watch: _w, sources: _s, inFlight: _i, now: _n, mode: _m, ...rest } = o;
  return rest;
}

async function decide(w: Watched, s: Seen, c: { options: WatchOptions; mode: "dry-run" | "apply"; repo: string; sources: ReleaseSources; inFlight: InFlight[]; forge: RolloutForge; bots: ListedPullRequest[]; now: Date }): Promise<void> {
  const { subject } = s;
  const note = s.constraints.length > 0 ? ` ${s.constraints.length === 1 ? "One root names" : `${s.constraints.length} roots name`} a version constraint, which the watch does not follow; terragucci pin modules makes it an exact pin.` : "";
  const say = (text: string): string => `${text}${note ? `.${note}` : ""}`;
  const versions = await c.sources.versions(subject);
  if (versions === undefined) {
    w.action = "skipped";
    w.reason = say("its releases are not listed for this kind of source");
    return;
  }
  const releases = plainReleases(versions);
  if (releases.length > 0) w.latest = `${releases[0]!.major}.${releases[0]!.minor}.${releases[0]!.patch}`;
  const rule = { follow: s.rule.follow ?? FOLLOW_DEFAULT, ...(s.rule.min_age !== undefined ? { minAgeMs: ttlMs(s.rule.min_age)! } : {}) };
  const published = (v: string) => c.sources.published(subject, v);

  // The newest pin that has a release to move to is the version this rollout moves from.
  let held: string | undefined;
  for (const v of w.at) {
    const pick = await pickRelease(v, releases, rule, published, c.now);
    if (pick.to) {
      w.from = v;
      w.to = pick.to;
      break;
    }
    held ??= pick.held;
  }
  if (!w.to) {
    w.action = held ? "held" : "up-to-date";
    w.reason = say(held ?? "no newer release");
    return;
  }

  const running = c.inFlight.find((r) => r.kind === subject.kind && r.name === subject.name && r.action !== "done");
  if (running) {
    w.action = "in-flight";
    w.reason = `a rollout to ${running.to} is ${running.action}${running.reason ? `: ${running.reason}` : ""}`;
    return;
  }
  const done = c.inFlight.find((r) => r.kind === subject.kind && r.name === subject.name && r.to === w.to && r.action === "done");
  if (done) {
    w.action = "skipped";
    w.reason = `a rollout to ${w.to} already ran; ${s.pins.get(w.from!)!.length} root${s.pins.get(w.from!)!.length === 1 ? " is" : "s are"} still at ${w.from}, and terragucci rollout ${subject.kind === "provider" ? "--provider " : ""}${subject.name} ${w.to} --from ${w.from} moves them`;
    return;
  }

  const canary = await canaryOf(c.forge, c.bots, subject, w.to);
  if (canary.state === "wait" || canary.state === "stop") {
    w.action = canary.state === "wait" ? "waiting-on-bot" : "stopped";
    w.bot = canary.url;
    w.reason = canary.reason;
    return;
  }
  if (canary.state === "applied") w.bot = canary.url;

  const { watch: _w, sources: _s, inFlight: _i, now: _n, ...rest } = c.options;
  const result = await rollout(c.repo, { ...rest, kind: subject.kind, name: subject.name, from: w.from, to: w.to, mode: c.mode });
  w.result = result;
  if (result.waves.length === 0) {
    w.action = "skipped";
    w.reason = say(`no root is at ${w.from} on the default branch`);
  } else if (result.status === "stopped") {
    w.action = "stopped";
    w.reason = result.stop;
  } else {
    w.action = c.mode === "apply" ? "started" : "would-start";
    w.reason = say(`${canary.state === "applied" ? `${canary.url} was the canary. ` : ""}${result.waves.length} wave${result.waves.length === 1 ? "" : "s"}`);
  }
}

export function describeWatch(r: WatchResult): string {
  if (r.watched.length === 0) return "rollouts.watch names no module or provider the roots use";
  return r.watched
    .map((w) => {
      const what = w.kind === "module" ? w.name : `provider ${w.name}`;
      const move = w.to ? `${w.from} -> ${w.to}` : `at ${w.at.join(", ") || "no exact pin"}${w.latest ? `, newest ${w.latest}` : ""}`;
      return `${what} ${move}: ${w.action}${w.reason ? ` (${w.reason})` : ""}`;
    })
    .join("\n");
}
