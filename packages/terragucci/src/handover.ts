/**
 * On GitHub and Forgejo, the jobs that run the change's code (`check`,
 * `plan`, `replan`) end with the step that runs it. A later step in the same
 * container holds a token. Forgejo's runner gives the run's token to every
 * step (as ACTIONS_RUNTIME_TOKEN, and to an action as its `token` input).
 * GitHub's runner gives every JavaScript action ACTIONS_RUNTIME_TOKEN and its
 * inputs as INPUT_* variables, defaults included, in its post step too, and
 * actions/checkout's `token` input defaults to `github.token`. Such a step
 * runs beside whatever the change's code left running in the container, runs
 * the binaries and reads the files that code could have replaced, and starts
 * with what the code wrote to GITHUB_ENV and GITHUB_PATH (LD_PRELOAD, say, or
 * its own `git` ahead on the path). So no step comes after it: no artifact
 * upload, no cache save, and no checkout action, whose post step runs at the
 * job's end with the token.
 *
 * The step hands its report directory on as the job's outputs instead, which
 * the runner reports itself once the step ends: every regular file, gzipped
 * JSON in base64, cut to the forge's HANDOVER_LIMITS. The job after it
 * (`check-report`, `plan-note`, `replan-note`) starts in a fresh container,
 * writes the files back, keeps them as the artifact the job kept before, and
 * posts. What it reads is the change's: it is data, written only under the
 * report directory, by a path of plain segments.
 *
 * The checkout is a script (checkoutScript), with the job's token for its
 * fetches alone.
 *
 * chant's generated plan job keeps the same order (@intentius/chant/ci-handover),
 * and this file takes from it what terragucci's jobs share with it: the output
 * limits and names, the job outputs, and the note job's take-over. What stays
 * here is terragucci's own: the files a cut report keeps, the re-plan's sweep
 * before the handover, and a checkout of a ref the step names (`TG_REF`).
 *
 * chant's handover takes those as parameters (chant#4554): packJs,
 * handoverTrap and checkoutScript are chant's with terragucci's words passed
 * in.
 */
import {
  checkoutScript as chantCheckoutScript,
  HANDOVER_LIMITS,
  handoverKeys,
  handoverOutputs,
  handoverTrap as chantHandoverTrap,
  packJs as chantPackJs,
  takeOverScript as chantTakeOverScript,
  UNPACK_JS,
  type HandoverForge,
} from "@intentius/chant/ci-handover";
import { PLAN_NOTE_FILE, PLAN_STATUS_FILE } from "./plan-note-gitlab";

export { HANDOVER_LIMITS, handoverKeys, handoverOutputs, UNPACK_JS, type HandoverForge };

/** The files a note job reads, which a report too large to hand on whole is cut to. */
function noteFiles(): string[] {
  return [PLAN_NOTE_FILE, PLAN_STATUS_FILE, "drift-schedule.json", "report.json"];
}

/**
 * Packs the report directory (argv 1) into the step's output file (argv 2).
 * Only regular files, found without following a link. A report too large is
 * cut to the files the note job reads, and to none when even those are too
 * large; the log says which.
 */
export function packJs(forge: HandoverForge): string {
  return chantPackJs(forge, { noteFiles: noteFiles(), label: "terragucci" });
}

/**
 * The lines of a step that runs the change's code, after its restarts: when
 * the step ends, however it ends, its report directory goes into the step's
 * outputs. With `sweep` (a re-plan's LEFTOVER_SWEEP) the processes the step
 * started are killed first.
 */
export function handoverTrap(dir: string, forge: HandoverForge, sweep = false): string[] {
  return chantHandoverTrap(dir, forge, { noteFiles: noteFiles(), label: "terragucci", ...(sweep ? { before: "tg_sweep" } : {}) });
}

/**
 * The script of the step that takes the report job `job` handed on into
 * `dir`: chant's takeOverScript, whose log lines name the job it read.
 */
export function takeOverScript(job: string, dir: string, forge: HandoverForge): string {
  const script = chantTakeOverScript(job, dir, forge);
  return job === "plan" ? script : script.replaceAll("the plan job", `the ${job} job`);
}

/**
 * Checks the change out with git, as actions/checkout does without
 * credentials kept: by `TG_REF` when the step sets it (a ref, fetched by
 * name), else the run's commit (`GITHUB_SHA`, under `GITHUB_REF`). With
 * `history`, every branch and tag too. The job's token (`TG_TOKEN`) reaches
 * the fetches alone, through the environment, never the git config. A
 * workspace already checked out is cleaned first, as actions/checkout does.
 */
export function checkoutScript(history: boolean): string {
  return chantCheckoutScript(history, false, { tokenEnv: "TG_TOKEN", refEnv: "TG_REF", headName: "terragucci-head" });
}
