/**
 * On Forgejo, the jobs that run the change's code (`check`, `plan`,
 * `replan`) end with the step that runs it. Forgejo's runner gives the run's
 * token to every step of a job (as ACTIONS_RUNTIME_TOKEN, and to an action as
 * its `token` input), and a later step in the same container runs beside
 * whatever the change's code left running there, and runs the binaries and
 * reads the files that code could have replaced. So no step comes after it:
 * no artifact upload, no cache save, and no checkout action, whose post step
 * runs at the job's end with the token.
 *
 * The step hands its report directory on as the job's outputs instead, which
 * the runner reports itself once the step ends: every regular file, gzipped
 * JSON in base64, cut into HANDOVER_PARTS outputs of HANDOVER_CHUNK
 * characters at most (Forgejo keeps an output to 1 MiB). The job after it
 * (`check-report`, `plan-note`, `replan-note`) starts in a fresh container,
 * writes the files back, keeps them as the artifact the job kept before, and
 * posts. What it reads is the change's: it is data, written only under the
 * report directory, by a path of plain segments.
 *
 * The checkout is a script (forgejoCheckoutScript), with the job's token for
 * its fetches alone.
 */
import { PLAN_NOTE_FILE, PLAN_STATUS_FILE } from "./plan-note-gitlab";

/** The most characters one output holds: under Forgejo's 1 MiB for an output's value. */
export const HANDOVER_CHUNK = 1_000_000;
/** How many outputs a job hands its report on in. */
export const HANDOVER_PARTS = 4;
/** The outputs' names: report_0, report_1, ... */
export const HANDOVER_KEYS = Array.from({ length: HANDOVER_PARTS }, (_, i) => `report_${i}`);

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
export function packJs(): string {
  return [
    'const fs=require("fs"),p=require("path"),z=require("zlib");',
    "const [dir,out]=process.argv.slice(1);",
    `const CHUNK=${HANDOVER_CHUNK},PARTS=${HANDOVER_PARTS},NOTE=${JSON.stringify(noteFiles())};`,
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
 * Writes back, under the directory argv 1 names, the files a job handed on:
 * stdin holds its outputs, one JSON string a line. A path is kept only when
 * it is plain segments (no empty one, no `.` or `..`, no backslash or control
 * character), so nothing lands outside the directory.
 */
export const UNPACK_JS = [
  'const fs=require("fs"),p=require("path"),z=require("zlib");',
  "const dir=process.argv[1];",
  'let b="";',
  'for(const l of fs.readFileSync(0,"utf8").split("\\n")){if(!l.trim())continue;let s="";try{s=JSON.parse(l)}catch{}if(typeof s==="string")b+=s}',
  'if(!b){console.log("terragucci: the job handed on no report");process.exit(0)}',
  'let files;try{files=JSON.parse(z.gunzipSync(Buffer.from(b,"base64"),{maxOutputLength:268435456}).toString("utf8"))}catch(e){console.log("terragucci: the report the job handed on does not read: "+e.message);process.exit(0)}',
  'if(!files||typeof files!=="object"||Array.isArray(files)){console.log("terragucci: the report the job handed on is not a set of files");process.exit(0)}',
  "let n=0;",
  'for(const [k,v] of Object.entries(files)){const parts=k.split("/");',
  'if(typeof v!=="string"||k.length>1024||parts.some((x)=>!x||x==="."||x===".."||/[\\\\\\x00-\\x1f]/.test(x))){console.log("terragucci: left out "+JSON.stringify(k));continue}',
  'try{const f=p.join(dir,...parts);fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,Buffer.from(v,"base64"));n++}catch(e){console.log("terragucci: could not write "+JSON.stringify(k)+": "+e.message)}}',
  'console.log("terragucci: took "+n+" report files from the job")',
].join("");

/**
 * The lines of a step that runs the change's code, after its restarts: when
 * the step ends, however it ends, its report directory goes into the step's
 * outputs. With `sweep` (a re-plan's LEFTOVER_SWEEP) the processes the step
 * started are killed first.
 */
export function handoverTrap(dir: string, sweep = false): string[] {
  return [
    `tg_handover() { node -e '${packJs()}' ${dir} "\${GITHUB_OUTPUT:-/dev/null}" || echo "terragucci: the report could not be handed to the next job" >&2; }`,
    sweep ? "trap 'tg_sweep; tg_handover' EXIT" : "trap tg_handover EXIT",
  ];
}

/** A job's outputs that carry the report its step `step` handed on. */
export function handoverOutputs(step: string): Record<string, string> {
  return Object.fromEntries(HANDOVER_KEYS.map((k) => [k, `\${{ steps.${step}.outputs.${k} }}`]));
}

/**
 * The script of the step that takes the report job `job` handed on into
 * `dir`. Each output comes in as toJSON's string, one line of a quoted heredoc
 * whose end no JSON string can be, so the change's outputs stay data.
 */
export function takeOverScript(job: string, dir: string): string {
  return [
    "set -u",
    `node -e '${UNPACK_JS}' ${dir} <<'END_OF_REPORT'`,
    ...HANDOVER_KEYS.map((k) => `\${{ toJSON(needs.${job}.outputs.${k}) }}`),
    "END_OF_REPORT",
  ].join("\n");
}

/**
 * Checks the change out with git, as actions/checkout does without
 * credentials kept: by `TG_REF` when the step sets it (a ref, fetched by
 * name), else the run's commit (`GITHUB_SHA`, under `GITHUB_REF`). With
 * `history`, every branch and tag too. The job's token (`TG_TOKEN`) reaches
 * the fetches alone, through the environment, never the git config. A
 * workspace already checked out is cleaned first, as actions/checkout does.
 */
export function forgejoCheckoutScript(history: boolean): string {
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
