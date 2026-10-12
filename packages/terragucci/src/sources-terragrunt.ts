/**
 * sources: a Terragrunt unit's check after `init` and before `plan`
 * (./sources.ts).
 *
 * A wave plans its units with one `terragrunt run --all plan`, and Terragrunt
 * inits each unit inside it, so terragucci never gets a turn between a unit's
 * init and its plan. It takes one through `TG_TF_PATH`: with `sources:` in
 * force, each plan run is pointed at a wrapper (sourcesWrapper) that, when
 * Terragrunt calls the binary's `plan` for a unit, asks the stage to check
 * what the unit's init fetched and locked, in the unit's working directory.
 * A unit the lists refuse never runs `plan`: the wrapper exits 1, Terragrunt
 * fails the unit, and the stage reports the refusal lines, which name the
 * unit and the module path or provider. Every other call (init, show,
 * output, version) runs the binary as it is. A `plan` call whose `-out`
 * names no unit under the run's plan directories is refused too, since the
 * unit it plans could not be checked, and the stage holds a unit that planned
 * without being asked about as unchecked (uncheckedUnit): the check fails
 * closed.
 *
 * The check runs in the stage's own process, so the wrapper only carries the
 * question and the answer, over a socket on 127.0.0.1 that lives as long as
 * the one `run --all`. Without `sources:` nothing here runs, and the plan
 * runs exactly as it did.
 */
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import type { SourceChecker } from "./sources";

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The variable the wrapper finds the next binary in: the one Terragrunt would have called. */
export const SOURCES_NEXT_ENV = "TERRAGUCCI_SOURCES_NEXT";

/** What the wrapper says before the refusal lines, and what a refused unit's report says it was not. */
export const UNIT_REFUSED = "refused by sources after init, so it was not planned";

/** Why a unit that planned although the wrapper never asked about it is not used: its plan was never checked. */
export function uncheckedUnit(what: "planned" | "applied"): string {
  return `what its init fetched and locked was not checked against sources before its plan, so it is not ${what}`;
}

/**
 * The client the wrapper runs with node: it sends the unit and its working
 * directory, prints what the stage answers to stderr, and exits 1 when the
 * unit is refused or no answer came, so a check that did not run never lets
 * a plan through.
 */
const CLIENT_JS =
  'const [p,u,d]=process.argv.slice(1);let b="";const s=require("net").connect(Number(p),"127.0.0.1");' +
  's.on("data",(x)=>{b+=x});' +
  's.on("end",()=>{let r;try{r=JSON.parse(b)}catch{console.error("terragucci: the sources check gave no answer for "+u);process.exit(1)}for(const l of r.lines)console.error(l);process.exit(r.lines.length?1:0)});' +
  's.on("error",(e)=>{console.error("terragucci: the sources check could not be asked about "+u+": "+e.message);process.exit(1)});' +
  's.end(JSON.stringify({unit:u,dir:d}));';

/**
 * The `TG_TF_PATH` wrapper for one `run --all plan`. `plans` are the run's
 * `--out-dir` as given and as its real path: Terragrunt hands each unit's
 * plan `-out=<out-dir>/<unit>/tfplan.tfplan`, which names the unit. That
 * plan call asks the stage on `port` first, from the unit's working
 * directory, and runs only when the answer is empty. A `plan` call that
 * names no unit there exits 1 unasked, unless it only asks for help.
 */
export function sourcesWrapper(binary: string, plans: readonly string[], node: string, port: number): string {
  const lines = [
    "#!/bin/sh",
    "# terragucci: checks what each unit's init fetched and locked against sources before its plan. Written for one run.",
    `next="\${${SOURCES_NEXT_ENV}:-}"`,
    `[ -n "$next" ] || next=${shq(binary)}`,
    'if [ "$1" = plan ]; then',
    '  out=""',
    '  prev=""',
    '  help=""',
    '  for a in "$@"; do',
    '    case "$a" in -out=*|--out=*) out="${a#*=}" ;; -help|--help|-h) help=1 ;; esac',
    '    if [ "$prev" = "-out" ] || [ "$prev" = "--out" ]; then out="$a"; fi',
    '    prev="$a"',
    "  done",
    '  unit=""',
    '  case "$out" in',
  ];
  for (const d of [...new Set(plans)]) lines.push(`    ${shq(d)}/*/tfplan.tfplan) unit="\${out#${shq(d)}/}" ;;`);
  lines.push(
    "  esac",
    '  if [ -n "$unit" ]; then',
    `    ${shq(node)} -e ${shq(CLIENT_JS)} ${port} "\${unit%/tfplan.tfplan}" "$(pwd -P)" || exit 1`,
    '  elif [ -z "$help" ]; then',
    `    echo "terragucci: a plan in $(pwd -P) names no unit under ${[...new Set(plans)].join(" or ").replace(/["$`\\]/g, "")} (-out=\${out:-none}), so what its init fetched and locked cannot be checked against sources; it is not run" >&2`,
    "    exit 1",
    "  fi",
    "fi",
    'exec "$next" "$@"',
  );
  return lines.join("\n") + "\n";
}

/** The `--out-dir` of a `run --all plan`, or undefined for any other call. */
function planOutDir(args: readonly string[]): string | undefined {
  const at = args.indexOf("--");
  if (at < 0 || args[at + 1] !== "plan") return undefined;
  const i = args.indexOf("--out-dir");
  return i >= 0 && i < at ? args[i + 1] : undefined;
}

/**
 * The runner whose `run --all plan` calls check each unit through the
 * wrapper before its plan. `asked` collects every unit the wrapper asked
 * about, and `refused` each refused unit's lines;
 * `binary` is what Terragrunt calls when the run's environment names none.
 * The runner's other calls (render, output, find, apply) pass through.
 */
export function unitSourcesExec(inner: TerragruntExec, check: SourceChecker, binary: string, env: NodeJS.ProcessEnv, refused: Map<string, string[]>, asked: Set<string>): TerragruntExec {
  return async (file, args, opts) => {
    const outDir = planOutDir(args);
    if (outDir === undefined) return inner(file, args, opts);
    const abs = resolve(opts.cwd, outDir);
    let real = abs;
    try {
      real = join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      // The path as given is matched alone.
    }
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      let body = "";
      socket.on("data", (x) => {
        body += String(x);
      });
      socket.on("end", () => {
        void (async () => {
          let lines: string[];
          let unit = "";
          try {
            const q = JSON.parse(body) as { unit: string; dir: string };
            unit = q.unit;
            asked.add(unit);
            lines = await check.unitAfterInit(q.unit, q.dir, env);
          } catch (e) {
            lines = [`${unit || "a unit"}: ${(e as Error).message}`];
          }
          if (lines.length > 0 && unit) refused.set(unit, lines);
          socket.end(JSON.stringify({ lines: lines.length > 0 ? [`${unit}: ${UNIT_REFUSED}`, ...lines] : [] }));
        })();
      });
      socket.on("error", () => {
        // The wrapper went away: it exits 1 on its own.
      });
    });
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => done());
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const next = opts.env.TG_TF_PATH ?? binary;
      const dir = `${abs}.sources`;
      mkdirSync(dir, { recursive: true });
      const wrapper = join(dir, basename(next) || "tofu");
      writeFileSync(wrapper, sourcesWrapper(next, [abs, real], process.execPath, port));
      chmodSync(wrapper, 0o755);
      return await inner(file, args, { ...opts, env: { ...opts.env, TG_TF_PATH: wrapper, [SOURCES_NEXT_ENV]: next } });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  };
}
