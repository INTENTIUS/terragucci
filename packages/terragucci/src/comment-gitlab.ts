/**
 * `terragucci comment --forge gitlab --poll`: comment commands on GitLab.
 *
 * GitLab starts no pipeline for a merge request note, so the comments
 * schedule's pipeline (TERRAGUCCI_SCHEDULE=comments, from the default
 * branch) runs this poll. The note loop is chant's (`pollNoteCommands`,
 * `@intentius/chant/ci-note-commands`): it lists the merge requests updated
 * in the last day, reads their notes, and answers each `/terragucci` note
 * once. A note is answered when a reply from the job's own token carries
 * `<!-- terragucci:note=<id> -->`, and chant also records it on
 * `chant/lifecycle` (`_notes/<mr>-<note>.json`).
 *
 * Each note is read with terragucci's words. Its author must be a Developer
 * or above on the project; anyone else gets no reply and nothing runs, as on
 * GitHub. What a command runs is terragucci's answer (`answer` below), read
 * again through the grammar in comment.ts:
 *
 * - `/terragucci plan [root]` on an open merge request from this project
 *   starts a new merge request pipeline, whose plan job plans and updates the
 *   plan note as a push does. GitLab takes no variables for that pipeline, so
 *   a named root must be one of the pipeline's roots and the whole merge
 *   request is planned.
 * - `/terragucci apply` on a merged merge request retries the first apply
 *   job that did not succeed in the default branch's pipeline at its merge
 *   commit. `stage tf-apply` decides the gate again, so a wave with no
 *   approval waits again, and GitLab then runs the waves after it, each
 *   behind its own gate. A merge commit a later apply superseded is refused,
 *   as on GitHub (chant checks it). GitLab cannot stop the waves after a
 *   retried one, so `wave-<n>` is refused.
 * - With `apply.when: pull-request`, `/terragucci apply [wave-<n>]` on an
 *   open merge request is checked against `apply.requires` here, then starts
 *   a pipeline on the default branch whose `mr-apply` job applies the head
 *   (comment-apply-gitlab.ts); `/terragucci lock` and `/terragucci unlock`
 *   start the same pipeline, which locks or releases the merge request's
 *   roots. It is started with TG_MERGE_TOKEN (apply.merge_token_env), since
 *   a pipeline on a protected default branch needs a token that may merge
 *   there. A merged merge request has nothing to apply: it applied before it
 *   merged.
 * - With `agent.comment` (`--agent`), `/terragucci agent <ask>` on an open
 *   merge request of this project starts a pipeline on the default branch
 *   whose `agent` and `agent-push` jobs run the agent and push its change to
 *   the source branch (gitlab-agent.ts). Each job reads the merge request and
 *   the note again first.
 * - Otherwise `/terragucci lock` and `/terragucci unlock` are answered as
 *   unsupported, and so is `/terragucci agent`.
 *
 * With `review.agent` (`--review`), each open merge request whose head's plan
 * job has ended and has no review of that head gets one: the poll starts the
 * review's pipeline on the default branch and says so in the review note.
 * Those pipelines start with the job's own CI_JOB_TOKEN, so they run as the
 * user the comments schedule runs as.
 *
 * The plan notes and `terragucci/plan` are chant's plan-note job's, in the
 * plan notes pipeline (../product-plan.ts). The reviews are a loop of
 * terragucci's own over the merge requests updated in the window.
 *
 * The job runs nothing it reads: it calls GitLab's API with the project's
 * token and holds no cloud credentials.
 */
import { memoryNoteLog, noteCommandMarker, NOTE_COMMANDS_WINDOW_MINUTES, pollNoteCommands, type NoteCommand, type NoteLog, type NoteOutcome, type NoteRun } from "@intentius/chant/ci-note-commands";
import type { ForgeReads } from "@intentius/chant/pr-forge-reads";
import { commentProductWords, productWords } from "./ci-words";
import { agentSettingsAt } from "./involved";
import { allowRoot, parseComment, parseOptions, SHA } from "./comment";
import { HEAD_VAR, MR_VAR, NOTE_VAR, openChecks, pipelinesWith } from "./comment-apply-gitlab";
import { ConfigError, type ApplyRequire, type ApplyWhen } from "./config";
import { jobReads, poster, type Fetch } from "./forge";
import { CHANT_AGENT_ASK_VAR, CHANT_AGENT_PR_VAR } from "./render-chant-agent";
import { AGENT_HEAD_VAR, AGENT_MR_VAR, AGENT_NOTE_VAR, defaultPipelines, startReview, type ReviewStart } from "./gitlab-agent";

export type { NoteOutcome } from "@intentius/chant/ci-note-commands";

/** The marker a reply carries, naming the note it answers. */
export const noteMarker = (id: number): string => noteCommandMarker("terragucci", id);

/** The apply jobs a `/terragucci apply` on a merged merge request retries: a wave's own job, then its share jobs (share 0 is the wave's job). */
const WAVE_JOBS = /^apply-wave-([1-9][0-9]*)(?:-share-([1-9][0-9]*))?$/;

export interface GitLabPollOptions {
  /** The roots the pipeline was written with, one array per layer. */
  layers: string[][];
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  /** The poll's clock. Default: now. */
  now?: Date;
  /** `apply.when`. With `pull-request` an open merge request applies from its head. Default `merge`. */
  when?: ApplyWhen;
  /** `apply.requires`: what an open merge request needs before it applies. Default: every requirement. */
  requires?: readonly ApplyRequire[];
  /** How the checks wait between reads of a merge request GitLab has not finished checking. Default: a timer. */
  wait?: (ms: number) => Promise<void>;
  /**
   * `agent.comment`: a `/terragucci agent <ask>` note starts the agent's
   * pipeline. `"chant"`: the agent's jobs are chant's (chant#4616), and the
   * pipeline is started with CHANT_AGENT_PR and CHANT_AGENT_ASK.
   */
  agent?: boolean | "chant";
  /** `review.agent`: start the review of each open merge request's head once its plan ended. */
  review?: boolean;
  /** Where the answered notes are kept. Default: none beyond the job's replies, whose markers answer each note once. */
  log?: NoteLog;
}

export interface GitLabPoll {
  outcomes: NoteOutcome[];
  /** The reviews started, or that failed to start. */
  reviews?: ReviewStart[];
  /** Set when the poll could not list the merge requests or their notes. */
  fail?: string;
}

const short = (sha: string): string => sha.slice(0, 8);

/** The default branch and the job's token, checked first: everything else comes from chant's reading of the job's environment. */
function checkedEnv(env: NodeJS.ProcessEnv): string {
  const base = env.CI_DEFAULT_BRANCH;
  if (!env.CI_API_V4_URL || !env.CI_PROJECT_ID || !env.TG_TOKEN || !base) throw new ConfigError("comment --forge gitlab --poll needs CI_API_V4_URL, CI_PROJECT_ID, CI_DEFAULT_BRANCH and TG_TOKEN in the environment");
  return base;
}

export async function pollGitLabComments(o: GitLabPollOptions): Promise<GitLabPoll> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? fetch;
  const now = o.now ?? new Date();
  const base = checkedEnv(env);
  const reads = jobReads("gitlab", env, doFetch);
  const forge = poster("gitlab", env, doFetch);

  // The reviews are per merge request.
  const reviews: ReviewStart[] = [];
  if (o.review) {
    const failed = await perMergeRequest(o, { reads, env, fetch: doFetch, base, now, reviews, forge });
    if (failed) return { outcomes: [], reviews, fail: failed };
  }

  // The job's own reply, which carries the note's marker, is what answers a note once: the comments job has no remote it may
  // push chant/lifecycle to, so it keeps no record there.
  const log = o.log ?? memoryNoteLog();
  const parseEnv: Record<string, string> = parseOptions(env).atlantis ? { TG_ATLANTIS_COMMENTS: "1" } : {};
  const poll = await pollNoteCommands({
    reads,
    forge,
    pipelines: pipelinesWith(env, env.TG_TOKEN, doFetch),
    words: commentProductWords() ?? productWords(),
    base,
    log,
    now,
    env: parseEnv,
    runs: (c) => answer({ env, fetch: doFetch, reads, forge, layers: o.layers, ...(o.when ? { when: o.when } : {}), ...(o.requires ? { requires: o.requires } : {}), ...(o.wait ? { wait: o.wait } : {}), ...(o.agent ? { agent: o.agent } : {}) }, c),
  });
  return { outcomes: poll.outcomes, reviews, ...(poll.fail ? { fail: poll.fail } : {}) };
}

/** The reviews of the merge requests updated in the window. Returns why it stopped, when it could not read them. */
async function perMergeRequest(
  o: GitLabPollOptions,
  c: { reads: ForgeReads; env: NodeJS.ProcessEnv; fetch: Fetch; base: string; now: Date; reviews: ReviewStart[]; forge: ReturnType<typeof poster> },
): Promise<string | undefined> {
  const since = new Date(c.now.getTime() - NOTE_COMMANDS_WINDOW_MINUTES * 60_000).toISOString();
  let me;
  let mrs;
  try {
    me = await c.reads.tokenUser();
    mrs = await c.reads.pullRequestsUpdated(since);
  } catch (e) {
    return `could not list the merge requests (${(e as Error).message.split("\n")[0]})`;
  }
  if (!me) return "GitLab did not say which user the job's token acts as";
  for (const mr of mrs) {
    let notes;
    try {
      notes = await c.reads.pullRequestNotes(mr.number);
    } catch (e) {
      return `could not read the notes of !${mr.number} (${(e as Error).message.split("\n")[0]})`;
    }
    if (o.review) {
      const started = await startReview({ reads: c.reads, me, base: c.base, env: c.env, fetch: c.fetch, forge: c.forge }, mr, notes);
      if (started) c.reviews.push(started);
    }
  }
  return undefined;
}

interface Ask {
  env: NodeJS.ProcessEnv;
  fetch: Fetch;
  reads: ForgeReads;
  forge: ReturnType<typeof poster>;
  layers: string[][];
  when?: ApplyWhen;
  requires?: readonly ApplyRequire[];
  wait?: (ms: number) => Promise<void>;
  /** `agent.comment` is set; `"chant"` on chant's agent job. */
  agent?: boolean | "chant";
}

/** What a Developer's command runs: terragucci's answer to chant's poll. */
async function answer(ask: Ask, c: NoteCommand): Promise<NoteRun> {
  const { mr, note, base } = c;
  const { layers } = ask;
  const prMode = ask.when === "pull-request";
  const iid = mr.number;
  const reply = (text: string): NoteRun => ({ kind: "reply", text });
  const broke = (reason: string): NoteRun => ({ kind: "fail", reason });

  // terragucci's grammar, on top of chant's: the atlantis forms, the plan's flags and the action's roots.
  const parsed = parseComment(note.body, parseOptions(ask.env));
  if (!parsed) return reply("this note is not a terragucci command");
  if (parsed.kind === "refused") return reply(parsed.reason);
  // A day-2 action runs from the action workflow on GitHub and Forgejo (./action.ts); a GitLab project runs it from a checkout.
  if (parsed.kind === "action") return reply(`\`/terragucci action\` does not run from a merge request note: run \`terragucci action ${parsed.root} ${parsed.address}\` from a checkout of the default branch`);
  if (parsed.kind === "agent" && !ask.agent) return reply("the agent command is off in this project; `agent.comment` in terragucci.yml turns it on");
  if ((parsed.kind === "lock" || parsed.kind === "unlock") && !prMode) {
    return reply(`\`/terragucci ${parsed.kind}\` does not run here: this project applies after merge, so merge requests take no locks`);
  }

  const fork = !mr.sameRepo;
  const open = mr.state === "open";

  // agent.comment: the agent runs in a pipeline of the default branch, whose jobs read the merge request and the note again.
  if (parsed.kind === "agent") {
    if (!open) return reply(`!${iid} is not open, so the agent does not run`);
    if (fork) return reply("a merge request from a fork gets no agent: its branch is not this project's to push to");
    if (mr.head === base) return reply(`!${iid}'s source branch is the default branch, and an agent never pushes there`);
    const sha = mr.headSha;
    if (typeof sha !== "string" || !SHA.test(sha)) return broke(`!${iid}'s head is not a commit`);
    // chant's agent job reads the merge request and the ask from these two, and the head again itself.
    const variables: Record<string, string> = ask.agent === "chant" ? { [CHANT_AGENT_PR_VAR]: String(iid), [CHANT_AGENT_ASK_VAR]: parsed.ask } : { [AGENT_MR_VAR]: String(iid), [AGENT_NOTE_VAR]: String(note.id), [AGENT_HEAD_VAR]: sha };
    return {
      kind: "pipeline",
      ref: base,
      variables,
      doing: `run the agent on !${iid}'s head ${short(sha)} (it reads !${iid} and this note again before the agent runs, and pushes what the agent changes to \`${mr.head}\`)`,
      with: defaultPipelines(ask.env, ask.fetch),
    };
  }

  // apply.when: pull-request: an open merge request's apply, lock and unlock run in a pipeline of the default branch.
  if (prMode && parsed.kind !== "plan") {
    if (!open) {
      if (parsed.kind === "apply") {
        return reply(mr.state === "merged"
          ? `!${iid} is merged, and this project applies a merge request from its head before it merges, so there is nothing of it left to apply; the push after the merge ran \`confirm\``
          : `!${iid} was closed without merging, so there is nothing of it to apply`);
      }
      return reply(`!${iid} is not open, so it holds no lock: the next merge request that reaches its roots takes them over`);
    }
    if (fork) return reply("a merge request from a fork is never applied: its code would run with this project's apply credentials");
    if (mr.base !== base) return reply(`!${iid} targets ${String(mr.base)}, not the default branch ${base}, so it is not applied`);
    const sha = mr.headSha;
    if (typeof sha !== "string" || !SHA.test(sha)) return broke(`!${iid}'s head is not a commit`);
    if (parsed.kind === "apply") {
      const verdict = await openChecks({ reads: ask.reads, forge: ask.forge, mr, base, ...(await agentSettingsAt(process.cwd())), env: ask.env, fetch: ask.fetch, ...(ask.requires ? { requires: ask.requires } : {}), ...(ask.wait ? { wait: ask.wait } : {}) });
      if (verdict && "fail" in verdict) return broke(verdict.fail);
      if (verdict) return reply(verdict.refuse);
    }
    // A pipeline on a protected default branch needs a token that may merge there; the comments job's own may not.
    if (!ask.env.TG_MERGE_TOKEN) return broke(`the comments job has no TG_MERGE_TOKEN, the token apply.merge_token_env names, so it cannot start a pipeline on ${base} for !${iid}`);
    const wave = parsed.kind === "apply" ? parsed.wave : undefined;
    const through = wave !== undefined ? ` through wave ${wave}` : "";
    const doing = parsed.kind === "apply" ? `apply !${iid}'s head ${short(sha)}${through}` : `${parsed.kind} the roots of !${iid}`;
    return {
      kind: "pipeline",
      ref: base,
      variables: { [MR_VAR]: String(iid), [NOTE_VAR]: String(note.id), [HEAD_VAR]: sha },
      doing: `${doing} (its job reads !${iid} again before it ${parsed.kind === "apply" ? "applies" : parsed.kind + "s"})`,
      with: pipelinesWith(ask.env, ask.env.TG_MERGE_TOKEN, ask.fetch),
    };
  }

  if (parsed.kind === "plan") {
    if (parsed.root !== undefined && !allowRoot(parsed.root, layers)) {
      return reply(`${parsed.root} is not a root of this repository. The roots are ${layers.flat().sort().map((r) => `\`${r}\``).join(", ")}.`);
    }
    if (!open) return reply(`!${iid} is not open, so it is not planned`);
    // A fork's code never meets the read-only plan role, here or in the plan job.
    if (fork) return reply("a merge request from a fork is not re-planned: its code never runs with this project's credentials");
    // GitLab takes no variables for a merge request pipeline, so the plan job plans what the merge request reaches.
    const whole = parsed.root !== undefined ? ` (GitLab re-plans every root the merge request reaches, \`${parsed.root}\` among them)` : "";
    return { kind: "merge-request-pipeline", doing: `re-plan !${iid}${whole}` };
  }

  // apply (a lock or unlock got its answer above)
  if (parsed.kind !== "apply") return reply(`\`/terragucci ${parsed.kind}\` does not run here`);
  if (parsed.wave !== undefined) {
    return reply(`GitLab runs the waves after a retried apply job by itself, so \`wave-${parsed.wave}\` cannot stop them; write \`/terragucci apply\`, and each wave still waits behind its own gate`);
  }
  if (open) {
    return reply(`!${iid} is not merged: \`/terragucci apply\` retries the apply of a merged merge request, from the default branch, and never applies a merge request's branch`);
  }
  if (mr.state !== "merged") return reply(`!${iid} was closed without merging, so there is nothing of it to apply`);
  if (fork) return reply("a merge request from a fork is not applied on a note: its apply runs when it reaches the default branch");
  if (mr.base !== base) return reply(`!${iid} was merged into ${String(mr.base)}, not the default branch ${base}, so nothing applies from it`);
  const sha = mr.mergeCommit;
  if (typeof sha !== "string" || !SHA.test(sha)) return broke(`!${iid} has no merge commit`);
  // chant finds the newest push pipeline at the merge commit with a wave job, refuses one a later apply superseded, and retries the first wave job that did not succeed.
  return { kind: "retry", sha, jobs: WAVE_JOBS };
}
