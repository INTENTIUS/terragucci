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
 * Where the installed chant's handover takes those as parameters (chant#4554,
 * ../chant-next.ts), packJs, handoverTrap and checkoutScript are chant's with
 * terragucci's words passed in. The scripts below stay as the fallback for a
 * chant without them (the 0.124.54 pin).
 */
import { HANDOVER_LIMITS, handoverKeys, handoverOutputs, takeOverScript as chantTakeOverScript, UNPACK_JS, type HandoverForge } from "@intentius/chant/ci-handover";
import { chantHandover } from "./chant-next";
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
  const chant = chantHandover();
  if (chant) return chant.packJs(forge, { noteFiles: noteFiles(), label: "terragucci" });
  const { chunk, parts } = HANDOVER_LIMITS[forge];
  return [
    'const fs=require("fs"),p=require("path"),z=require("zlib");',
    "const [dir,out]=process.argv.slice(1);",
    `const CHUNK=${chunk},PARTS=${parts},NOTE=${JSON.stringify(noteFiles())};`,
    "const all={};",
    "const walk=(d,r)=>{let n=[];try{n=fs.readdirSync(d).sort()}catch{return}for(const x of n){const f=p.join(d,x),k=r?r+\"/\"+x:x;let s;try{s=fs.lstatSync(f)}catch{continue}if(s.isDirectory())walk(f,k);else if(s.isFile())all[k]=fs.readFileSync(f).toString(\"base64\")}};",
    'walk(dir,"");',
    'const pack=(o)=>z.gzipSync(JSON.stringify(o)).toString("base64");',
    "let b=pack(all);",
    "if(b.length>CHUNK*PARTS){b=pack(Object.fromEntries(Object.entries(all).filter(([k])=>NOTE.includes(k))));",
    'if(b.length>CHUNK*PARTS){b=pack({});console.error("terragucci: the report is too large to hand to the next job, even cut to the note and the status; it hands on none of it")}',
    'else console.error("terragucci: the report is too large to hand to the next job whole; it hands on the note, the status and report.json")}',
    'let o="";for(let i=0;i*CHUNK<b.length;i++)o+="report_"+i+"="+b.slice(i*CHUNK,(i+1)*CHUNK)+"\\n";',
    "fs.appendFileSync(out,o);",
  ].join("");
}

/**
 * The lines of a step that runs the change's code, after its restarts: when
 * the step ends, however it ends, its report directory goes into the step's
 * outputs. With `sweep` (a re-plan's LEFTOVER_SWEEP) the processes the step
 * started are killed first.
 */
export function handoverTrap(dir: string, forge: HandoverForge, sweep = false): string[] {
  const chant = chantHandover();
  if (chant) return chant.handoverTrap(dir, forge, { noteFiles: noteFiles(), label: "terragucci", ...(sweep ? { before: "tg_sweep" } : {}) });
  return [
    `tg_handover() { node -e '${packJs(forge)}' ${dir} "\${GITHUB_OUTPUT:-/dev/null}" || echo "terragucci: the report could not be handed to the next job" >&2; }`,
    sweep ? "trap 'tg_sweep; tg_handover' EXIT" : "trap tg_handover EXIT",
  ];
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
  const chant = chantHandover();
  if (chant) return chant.checkoutScript(history, false, { tokenEnv: "TG_TOKEN", refEnv: "TG_REF", headName: "terragucci-head" });
  const fetch = history
    ? `git -c protocol.version=2 fetch -q --prune --no-recurse-submodules origin '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*' "+$want:$target"`
    : 'git -c protocol.version=2 fetch -q --no-tags --prune --no-recurse-submodules --depth=1 origin "+$want:$target"';
  return [
    "set -eu",
    'git config --global --add safe.directory "$PWD" 2>/dev/null || true',
    "[ -d .git ] || git init -q .",
    'git remote get-url origin >/dev/null 2>&1 || git remote add origin "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"',
    'if [ -n "${TG_TOKEN:-}" ]; then',
    `  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$TG_TOKEN" | base64 | tr -d '\\n')"`,
    "fi",
    'ref="${TG_REF:-$GITHUB_REF}"',
    'want="${TG_REF:-$GITHUB_SHA}"',
    'case "$ref" in',
    '  refs/heads/*) target="refs/remotes/origin/${ref#refs/heads/}" ;;',
    '  refs/tags/*) target="$ref" ;;',
    '  refs/*) target="refs/remotes/${ref#refs/}" ;;',
    '  *) target="refs/remotes/origin/terragucci-head" ;;',
    "esac",
    "if git rev-parse -q --verify HEAD >/dev/null; then git clean -ffdxq; fi",
    fetch,
    'case "$ref" in',
    '  refs/heads/*) git checkout -q --force -B "${ref#refs/heads/}" "$target" ;;',
    '  *) git checkout -q --force --detach "$target" ;;',
    "esac",
  ].join("\n");
}
