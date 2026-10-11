/**
 * `terragucci view [--export <dir>] [--publish]`: the repo's roots as one
 * graph in behold (INTENTIUS/behold), each resource marked with what the
 * newest drift check, plan or waiting wave found, read from the reports
 * bucket.
 *
 * behold is not a dependency of the package. terragucci holds the versions it
 * runs and is tested with in BEHOLD_PIN and starts them with `npx`, so a repo
 * that never runs `view` never fetches behold, and the bundle stays as it is.
 *
 * The command reads `reports` from the config (a control repo's project, or
 * its defaults) and names the project the way a run names it in the index
 * (`runFacts`: the CI environment, else the git remote, else the directory).
 * behold reads `s3://<bucket>/<prefix>`, an https address or a directory; a
 * GCS or Azure bucket is read through its `reports.url`, or from a synced
 * copy passed with `--reports`. An S3-compatible `reports.endpoint` reaches
 * behold as `AWS_ENDPOINT_URL_S3`, which its own signer and the aws CLI read.
 *
 * Read-only: behold refuses every write on a terragucci repo, and this
 * command writes nothing to the repo. `--export` writes the static view to
 * the directory it is given, and `--publish` uploads it under
 * `<prefix>/views/behold`, which no terragucci upload writes.
 *
 * The child process is injectable (ViewDeps), so tests run no npx.
 */
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ConfigError, resolveProject, resolveRepo, type TerragucciConfig } from "./config";
import { bucketUrl, parseReportsBucket } from "./report/object-store";
import { runFacts } from "./report/stage";
import { VIEWS_DIR } from "./report/store";

/** The behold `terragucci view` runs, and the two peers it reads Terraform with. Tested together; move them together. */
export const BEHOLD_PIN = {
  behold: "@intentius/behold@0.23.0",
  lexicon: "@intentius/chant-lexicon-terraform@^0.102.0",
  hcl2json: "@cdktn/hcl2json@^0.24.0",
} as const;

/** behold's own default port. */
export const VIEW_PORT = 4600;

/** Where `--publish` puts the view, under the reports prefix. */
export const VIEW_DIR = `${VIEWS_DIR}/behold`;

type Reports = NonNullable<TerragucciConfig["reports"]>;

/** What behold's `--terragucci` reads. */
export interface ViewSource {
  /** `s3://<bucket>/<prefix>`, an http(s) address or an absolute directory. */
  source: string;
  kind: "s3" | "http" | "dir";
  /** An S3-compatible store's address, from `reports.endpoint`. */
  endpoint?: string;
}

const trim = (s: string): string => s.replace(/^\/+|\/+$/g, "");

/** The behold version the pin names. */
export const beholdVersion = (): string => BEHOLD_PIN.behold.slice(BEHOLD_PIN.behold.lastIndexOf("@") + 1);

/** The `reports` block of the repo, or of a control repo's project (its defaults when the project is not listed). */
export function viewReports(config: TerragucciConfig, project: string): Reports | undefined {
  if (config.projects && Object.keys(config.projects).length > 0) {
    return config.projects[project] !== undefined ? resolveProject(config, project).reports : config.defaults?.reports;
  }
  return resolveRepo(config).reports;
}

/** Where behold reads the reports: `--reports` when given, else the config's `reports`. */
export function viewSource(reports: Reports | undefined, flag: string | undefined, cwd: string): ViewSource {
  if (flag !== undefined) {
    if (/^s3:\/\/[^/\s]+/.test(flag)) return { source: `s3://${trim(flag.slice(5))}`, kind: "s3" };
    if (/^https?:\/\//.test(flag)) return { source: flag.replace(/\/+$/, ""), kind: "http" };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(flag)) throw new ConfigError(`--reports takes a directory, s3://<bucket>/<prefix> or an https address; behold does not read ${flag}`);
    return { source: resolve(cwd, flag), kind: "dir" };
  }
  if (!reports?.bucket) throw new ConfigError("view reads the reports bucket: set reports.bucket in terragucci.yml, or pass --reports <dir|s3://<bucket>/<prefix>|https://...>");
  const bucket = parseReportsBucket(reports.bucket);
  const prefix = trim(reports.prefix ?? "");
  if (bucket.kind === "s3") {
    return { source: ["s3:/", bucket.bucket, prefix].filter(Boolean).join("/"), kind: "s3", ...(reports.endpoint ? { endpoint: reports.endpoint.replace(/\/+$/, "") } : {}) };
  }
  if (reports.url) return { source: [reports.url.replace(/\/+$/, ""), prefix].filter(Boolean).join("/"), kind: "http" };
  const where = [bucketUrl(bucket), prefix].filter(Boolean).join("/");
  throw new ConfigError(`behold reads s3:// or https, and ${where} is neither: set reports.url, or pass --reports <dir> with a synced copy of ${where}`);
}

/** Where `--publish` uploads the view: `<source>/views/behold`, on S3 only. */
export function publishTarget(source: ViewSource): string {
  if (source.kind !== "s3") throw new ConfigError(`--publish uploads the view to the reports bucket's ${VIEW_DIR}/, and behold publishes to S3 only; ${source.source} is not an s3:// prefix`);
  return `${source.source}/${VIEW_DIR}`;
}

export interface ViewOptions {
  /** The checkout behold draws. */
  root: string;
  source: ViewSource;
  /** The project's name in the index, `<host>/<path>`. */
  project: string;
  port?: number;
  /** Open the browser once behold answers. Default true. */
  open?: boolean;
  /** Export a static view to this directory instead of serving. */
  export?: string;
  /** With `export`: also upload it to the reports bucket. */
  publish?: boolean;
}

/** npx's arguments for behold: serve, or export with `--export`. */
export function beholdArgv(o: ViewOptions): string[] {
  const packages = ["--yes", "-p", BEHOLD_PIN.behold, "-p", BEHOLD_PIN.lexicon, "-p", BEHOLD_PIN.hcl2json];
  const reads = ["--terragucci", o.source.source, "--terragucci-project", o.project];
  if (o.export !== undefined) {
    return [...packages, "behold", "export", o.root, ...reads, "--no-source", "--out", o.export, ...(o.publish ? ["--publish", publishTarget(o.source)] : [])];
  }
  return [...packages, "behold", "serve", o.root, ...reads, "--port", String(o.port ?? VIEW_PORT)];
}

/** The environment behold runs in: this one, with the S3-compatible endpoint the config names. */
export function beholdEnv(source: ViewSource, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return source.endpoint ? { ...env, AWS_ENDPOINT_URL_S3: source.endpoint } : env;
}

/** A started child process, as the command sees it. */
export interface ViewChild {
  /** Called with each chunk the child writes to stdout or stderr. */
  output(fn: (text: string) => void): void;
  /** How it ended: its exit code (null when a signal stopped it), or the error that kept it from starting. */
  exit: Promise<{ code: number | null; error?: NodeJS.ErrnoException }>;
  kill(signal: NodeJS.Signals): void;
}

export type ViewSpawn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; detached?: boolean }) => ViewChild;

export interface ViewDeps {
  spawn: ViewSpawn;
  fetch: (url: string) => Promise<{ status: number; text(): Promise<string> }>;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** A line for stdout. */
  print(line: string): void;
  /** A line for stderr. */
  warn(line: string): void;
  /** behold's own output once it serves, passed through. */
  forward(text: string): void;
  /** Call `fn` on SIGINT and SIGTERM until the returned function is called. */
  onSignal(fn: (signal: NodeJS.Signals) => void): () => void;
  sleep(ms: number): Promise<void>;
  /** How long to wait for behold to answer; npx may be downloading it. Default 300 s. */
  readyMs?: number;
}

const POLL_MS = 500;

/** The one line a failure prints, collapsed and cut to a readable length. */
const oneLine = (s: string): string => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > 400 ? `${line.slice(0, 397)}...` : line;
};

const CREDENTIALS = /\b(AccessDenied|Access Denied|ExpiredToken|ExpiredTokenException|InvalidAccessKeyId|InvalidClientTokenId|SignatureDoesNotMatch|Unable to locate credentials|no AWS credentials in the environment|Token has expired|Error when retrieving token from sso)\b/;

/**
 * The one line that says why behold stopped, from what it printed, or
 * undefined when nothing in it is recognized. `source` names what it read.
 */
export function explainBehold(text: string, o: Pick<ViewOptions, "source" | "port" | "export" | "publish">): string | undefined {
  const pinned = `behold ${beholdVersion()}, the version terragucci runs`;
  // chant's refusal of a declaration whose minReader is newer than the chant reading it.
  const reader = /this declaration needs chant (\S+) or newer to read it, and this is chant ([^\s;,.]+(?:\.[^\s;,.]+)*)/.exec(text);
  if (reader) return `chant.workspace.json asks for chant ${reader[1]} or newer to read it, and ${pinned}, reads with chant ${reader[2]}: the repo asks for a newer reader than the pinned behold reads`;
  if (/\breader-too-old\b/.test(text)) return `chant.workspace.json asks for a newer chant reader than ${pinned}, reads with: the repo asks for a newer reader than the pinned behold reads`;
  if (/this chant writes a newer workspace contract than it knows/.test(text)) return `the repo's chant writes a newer workspace contract than ${pinned}, reads: the repo asks for a newer reader than the pinned behold reads`;
  // The Terraform reader's peers: behold's refusal, a module that will not load, or npx unable to fetch one.
  const peers = /needs chant's terraform lexicon, which behold does not install: (.+?) (?:is|are) not resolvable/.exec(text);
  if (peers) return `behold could not load ${peers[1]}, the Terraform reader npx installs beside it (${BEHOLD_PIN.lexicon}, ${BEHOLD_PIN.hcl2json})`;
  const module = /Cannot find (?:package|module) ['"](@intentius\/chant-lexicon-terraform|@cdktn\/hcl2json)[^'"]*['"]/.exec(text);
  if (module) return `behold could not load ${module[1]}, the Terraform reader npx installs beside it (${BEHOLD_PIN.lexicon}, ${BEHOLD_PIN.hcl2json})`;
  const fetchFailed = /No matching version found for (\S+?)\.?(?:\s|$)/.exec(text) ?? /404\s+'?(\S+?)'? is not in this registry/.exec(text);
  if (fetchFailed) return `npx could not fetch ${fetchFailed[1]} from the npm registry; terragucci runs ${BEHOLD_PIN.behold} with ${BEHOLD_PIN.lexicon} and ${BEHOLD_PIN.hcl2json}`;
  const creds = CREDENTIALS.exec(text);
  if (creds) {
    const put = o.export !== undefined && o.publish ? ` and s3:PutObject on ${VIEW_DIR}/* under it` : "";
    return `behold could not read ${o.source.source} with this shell's AWS credentials (${creds[1]}): use a profile with s3:GetObject on the prefix${put}, or pass --reports <dir> with a copy made by aws s3 sync`;
  }
  if (/EADDRINUSE/.test(text)) return `port ${o.port ?? VIEW_PORT} is in use; pass --port with a free one`;
  // behold export's refusal of the reports, with its remedy on the next line.
  const refused = /terragucci reports not read: ([^\n]*)(?:\n\s+([^\n]*))?/.exec(text);
  if (refused) return oneLine(`${refused[1]} ${refused[2] ?? ""}`);
  // Any other refusal behold prints: `behold <verb>: <error>`, its remedy indented below.
  const said = /^behold (?:serve|export): ([^\n]*)(?:\n {2,}([^\n]*))?/m.exec(text);
  if (said) return oneLine(`${said[1]} ${said[2] ?? ""}`);
  return undefined;
}

/** A 422 from /api/terragucci: behold's own error and remedy, or the credentials line when the read failed on them. */
export function explainRefusal(body: string, o: Pick<ViewOptions, "source" | "port">): string {
  let refusal: { error?: unknown; remedy?: unknown };
  try {
    refusal = JSON.parse(body) as typeof refusal;
  } catch {
    return oneLine(`behold refused the reports: ${body}`);
  }
  const error = typeof refusal.error === "string" ? refusal.error : "behold refused the reports";
  const creds = CREDENTIALS.exec(error);
  if (creds) return explainBehold(error, o)!;
  return oneLine(`${error} ${typeof refusal.remedy === "string" ? refusal.remedy : ""}`);
}

/** What an unrecognized failure prints: behold's last line. */
function lastWords(text: string, code: number | null): string {
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return oneLine(`behold exited ${code ?? "on a signal"}${last ? `: ${last}` : ""}`);
}

const NO_NPX = "npx is not on the PATH: terragucci view runs behold with npx, which comes with Node.js";

/** The command and arguments that open `url` in the browser. */
export function opener(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", '""', url]];
  return ["xdg-open", [url]];
}

/** Run behold: serve and open the browser until Ctrl-C, or export. Returns the exit code. */
export async function view(o: ViewOptions, deps: ViewDeps): Promise<number> {
  const fail = (line: string): number => {
    deps.warn(`terragucci view: ${line}`);
    return 1;
  };
  const port = o.port ?? VIEW_PORT;
  const url = `http://127.0.0.1:${port}`;
  if (o.export === undefined) {
    // Something already answering there would pass for behold.
    try {
      await deps.fetch(`${url}/`);
      return fail(`something already answers on ${url}; stop it or pass --port with a free one`);
    } catch {
      // Nothing there: the port is free.
    }
  }
  const argv = beholdArgv(o);
  const child = deps.spawn("npx", argv, { cwd: o.root, env: beholdEnv(o.source, deps.env) });
  let out = "";
  let serving = false;
  child.output((t) => {
    out = (out + t).slice(-65536);
    if (serving) deps.forward(t);
  });
  let ended: { code: number | null; error?: NodeJS.ErrnoException } | undefined;
  void child.exit.then((e) => (ended = e));
  let stopped = false;
  const unhook = deps.onSignal((signal) => {
    stopped = true;
    child.kill(signal);
  });
  const ending = (e: { code: number | null; error?: NodeJS.ErrnoException }): number => {
    if (e.error) return fail(e.error.code === "ENOENT" ? NO_NPX : `could not start npx: ${e.error.message}`);
    if (stopped) return 0;
    if (e.code === 0) return 0;
    return fail(explainBehold(out, o) ?? lastWords(out, e.code));
  };
  try {
    if (o.export !== undefined) {
      deps.print(`terragucci view: exporting with behold ${beholdVersion()} to ${o.export}${o.publish ? ` and ${publishTarget(o.source)}` : ""}`);
      const e = await child.exit;
      if (!e.error && !stopped && e.code === 0) {
        const done = out.split("\n").map((l) => l.trimEnd()).filter((l) => /^behold export|^ {2}\S/.test(l));
        for (const l of done) deps.print(l);
      }
      return ending(e);
    }
    deps.print(`terragucci view: starting behold ${beholdVersion()} with npx, reading ${o.source.source} for ${o.project}`);
    const tries = Math.max(1, Math.ceil((deps.readyMs ?? 300_000) / POLL_MS));
    for (let i = 0; ; i++) {
      if (ended) return ending(ended);
      let answer: { status: number; body: string } | undefined;
      try {
        const res = await deps.fetch(`${url}/api/terragucci`);
        answer = { status: res.status, body: await res.text() };
      } catch {
        // Not listening yet.
      }
      if (answer) {
        if (answer.status >= 200 && answer.status < 300) break;
        child.kill("SIGTERM");
        if (answer.status === 422) return fail(explainRefusal(answer.body, o));
        return fail(oneLine(`behold answered /api/terragucci with ${answer.status}: ${answer.body}`));
      }
      if (i + 1 >= tries) {
        child.kill("SIGTERM");
        return fail(explainBehold(out, o) ?? `behold did not answer on ${url} within ${Math.round((tries * POLL_MS) / 1000)} s`);
      }
      await deps.sleep(POLL_MS);
    }
    serving = true;
    deps.print(`terragucci view: behold serves ${url}; Ctrl-C stops it`);
    if (o.open !== false) {
      const [cmd, args] = opener(deps.platform, url);
      const browser = deps.spawn(cmd, args, { cwd: o.root, env: deps.env, detached: true });
      void browser.exit.then((e) => {
        if (e.error || e.code) deps.warn(`terragucci view: open ${url} in a browser`);
      });
    }
    return ending(await child.exit);
  } finally {
    unhook();
  }
}

/** The checkout's top directory, or `cwd` outside git. */
export function repoRoot(cwd: string): string {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : cwd;
}

/** The project's name in the index, as a run in this checkout names it. */
export function viewProject(root: string, env: NodeJS.ProcessEnv): string {
  return runFacts(root, env).project;
}

/** The real process, network and signals. */
export function nodeViewDeps(): ViewDeps {
  return {
    spawn(cmd, args, opts) {
      const child = nodeSpawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: opts.detached ? "ignore" : ["ignore", "pipe", "pipe"],
        ...(opts.detached ? { detached: true } : {}),
        // npx is npx.cmd on Windows, which Node starts only through a shell.
        ...(process.platform === "win32" ? { shell: true } : {}),
      });
      const listeners: ((t: string) => void)[] = [];
      child.stdout?.on("data", (d) => listeners.forEach((f) => f(String(d))));
      child.stderr?.on("data", (d) => listeners.forEach((f) => f(String(d))));
      const exit = new Promise<{ code: number | null; error?: NodeJS.ErrnoException }>((res) => {
        child.on("error", (error) => res({ code: null, error }));
        child.on("close", (code) => res({ code }));
      });
      if (opts.detached) child.unref();
      return {
        output: (fn) => void listeners.push(fn),
        exit,
        kill: (signal) => void child.kill(signal),
      };
    },
    fetch: (url) => fetch(url, { signal: AbortSignal.timeout(2000) }),
    env: process.env,
    platform: process.platform,
    print: (line) => console.log(line),
    warn: (line) => console.error(line),
    forward: (text) => void process.stdout.write(text),
    onSignal(fn) {
      const h = (s: NodeJS.Signals) => fn(s);
      process.on("SIGINT", h);
      process.on("SIGTERM", h);
      return () => {
        process.off("SIGINT", h);
        process.off("SIGTERM", h);
      };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
