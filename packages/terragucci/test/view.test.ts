import { describe, expect, it } from "vitest";
import { ConfigError, type TerragucciConfig } from "../src/config";
import { BEHOLD_PIN, beholdArgv, beholdEnv, explainBehold, explainRefusal, opener, publishTarget, view, viewReports, viewSource, type ViewChild, type ViewDeps, type ViewOptions, type ViewSource, viewProject } from "../src/view";

const PROJECT = "github.com/acme/infra";
const S3: ViewSource = { source: "s3://acme-reports/tg", kind: "s3" };
const NPX = ["--yes", "-p", "@intentius/behold@0.25.0", "-p", "@intentius/chant-lexicon-terraform@^0.121.0", "-p", "@cdktn/hcl2json@^0.24.0"];

describe("the pin", () => {
  it("names behold and the two peers it reads Terraform with", () => {
    expect(BEHOLD_PIN).toEqual({ behold: "@intentius/behold@0.25.0", lexicon: "@intentius/chant-lexicon-terraform@^0.121.0", hcl2json: "@cdktn/hcl2json@^0.24.0" });
  });
});

describe("viewSource", () => {
  it("reads an S3 bucket at its prefix, with the endpoint of an S3-compatible store", () => {
    expect(viewSource({ bucket: "s3://acme-reports", prefix: "/tg/" }, undefined, "/repo")).toEqual({ source: "s3://acme-reports/tg", kind: "s3" });
    expect(viewSource({ bucket: "acme-reports" }, undefined, "/repo")).toEqual({ source: "s3://acme-reports", kind: "s3" });
    expect(viewSource({ bucket: "s3://acme-reports", prefix: "tg", endpoint: "http://floci:4566/" }, undefined, "/repo")).toEqual({ source: "s3://acme-reports/tg", kind: "s3", endpoint: "http://floci:4566" });
  });

  it("reads a GCS or Azure bucket through reports.url, with the prefix", () => {
    expect(viewSource({ bucket: "gs://acme-reports", prefix: "tg", url: "https://reports.acme.dev/" }, undefined, "/repo")).toEqual({ source: "https://reports.acme.dev/tg", kind: "http" });
    expect(viewSource({ bucket: "az://acmestore/reports", url: "https://reports.acme.dev" }, undefined, "/repo")).toEqual({ source: "https://reports.acme.dev", kind: "http" });
  });

  it("refuses a GCS or Azure bucket with no reports.url, naming --reports", () => {
    expect(() => viewSource({ bucket: "gs://acme-reports", prefix: "tg" }, undefined, "/repo")).toThrow(/behold reads s3:\/\/ or https, and gs:\/\/acme-reports\/tg is neither: set reports.url, or pass --reports <dir> with a synced copy/);
    expect(() => viewSource({ bucket: "az://acmestore/reports" }, undefined, "/repo")).toThrow(ConfigError);
  });

  it("refuses a repo with no reports bucket", () => {
    expect(() => viewSource(undefined, undefined, "/repo")).toThrow(/set reports.bucket in terragucci.yml, or pass --reports/);
  });

  it("takes --reports over the config: a directory, s3:// or https", () => {
    const reports = { bucket: "s3://other", endpoint: "http://floci:4566" };
    expect(viewSource(reports, "./reports", "/repo")).toEqual({ source: "/repo/reports", kind: "dir" });
    expect(viewSource(reports, "/tmp/r", "/repo")).toEqual({ source: "/tmp/r", kind: "dir" });
    expect(viewSource(reports, "s3://acme-reports/tg/", "/repo")).toEqual({ source: "s3://acme-reports/tg", kind: "s3" });
    expect(viewSource(reports, "https://reports.acme.dev/tg/", "/repo")).toEqual({ source: "https://reports.acme.dev/tg", kind: "http" });
    expect(() => viewSource(reports, "gs://acme-reports", "/repo")).toThrow(/behold does not read gs:\/\/acme-reports/);
  });
});

describe("viewReports", () => {
  it("is the repo's reports", () => {
    expect(viewReports({ reports: { bucket: "s3://a", prefix: "p" } }, PROJECT)).toEqual({ bucket: "s3://a", prefix: "p" });
  });

  it("in a control repo, is the project's, else the defaults'", () => {
    const config: TerragucciConfig = { defaults: { reports: { bucket: "s3://d" } }, projects: { [PROJECT]: { reports: { bucket: "s3://own" } }, "github.com/acme/shop": {} } };
    expect(viewReports(config, PROJECT)).toEqual({ bucket: "s3://own" });
    expect(viewReports(config, "github.com/acme/shop")).toEqual({ bucket: "s3://d" });
    expect(viewReports(config, "github.com/acme/elsewhere")).toEqual({ bucket: "s3://d" });
  });
});

describe("viewProject", () => {
  it("names the project as a run names it in the index", () => {
    expect(viewProject("/nowhere", { GITHUB_REPOSITORY: "acme/infra" })).toBe(PROJECT);
    expect(viewProject("/nowhere", { CI_PROJECT_PATH: "acme/infra", CI_SERVER_HOST: "gitlab.acme.dev" })).toBe("gitlab.acme.dev/acme/infra");
  });
});

describe("beholdArgv", () => {
  const base: ViewOptions = { root: "/repo", source: S3, project: PROJECT };

  it("serves the checkout with the reports and the project, on 4600 by default", () => {
    expect(beholdArgv(base)).toEqual([...NPX, "behold", "serve", "/repo", "--terragucci", "s3://acme-reports/tg", "--terragucci-project", PROJECT, "--port", "4600"]);
    expect(beholdArgv({ ...base, port: 4700 }).slice(-2)).toEqual(["--port", "4700"]);
  });

  it("passes an https or directory source as it is", () => {
    expect(beholdArgv({ ...base, source: { source: "https://reports.acme.dev/tg", kind: "http" } })).toContain("https://reports.acme.dev/tg");
    expect(beholdArgv({ ...base, source: { source: "/repo/reports", kind: "dir" } })).toContain("/repo/reports");
  });

  it("exports without source text, and publishes under views/behold", () => {
    expect(beholdArgv({ ...base, export: "/out" })).toEqual([...NPX, "behold", "export", "/repo", "--terragucci", "s3://acme-reports/tg", "--terragucci-project", PROJECT, "--no-source", "--out", "/out"]);
    expect(beholdArgv({ ...base, export: "/out", publish: true }).slice(-2)).toEqual(["--publish", "s3://acme-reports/tg/views/behold"]);
    expect(publishTarget({ source: "s3://acme-reports", kind: "s3" })).toBe("s3://acme-reports/views/behold");
  });

  it("refuses to publish anywhere but S3", () => {
    expect(() => beholdArgv({ ...base, source: { source: "https://reports.acme.dev", kind: "http" }, export: "/out", publish: true })).toThrow(/behold publishes to S3 only/);
    expect(() => publishTarget({ source: "/repo/reports", kind: "dir" })).toThrow(ConfigError);
  });

  it("hands behold the S3-compatible endpoint as AWS_ENDPOINT_URL_S3", () => {
    expect(beholdEnv({ ...S3, endpoint: "http://floci:4566" }, { HOME: "/h" })).toEqual({ HOME: "/h", AWS_ENDPOINT_URL_S3: "http://floci:4566" });
    expect(beholdEnv(S3, { HOME: "/h" })).toEqual({ HOME: "/h" });
  });
});

describe("opener", () => {
  it("is open, xdg-open or start", () => {
    expect(opener("darwin", "http://x")).toEqual(["open", ["http://x"]]);
    expect(opener("linux", "http://x")).toEqual(["xdg-open", ["http://x"]]);
    expect(opener("win32", "http://x")).toEqual(["cmd", ["/c", "start", '""', "http://x"]]);
  });
});

describe("explainBehold", () => {
  const o = { source: S3 };

  it("says the repo asks for a newer reader than the pinned behold reads", () => {
    const line = explainBehold("behold serve: chant workspace ls refused: this declaration needs chant 0.130.0 or newer to read it, and this is chant 0.121.1\n        Run `chant workspace ls` in the workspace root.\n", o);
    expect(line).toBe("chant.workspace.json asks for chant 0.130.0 or newer to read it, and behold 0.25.0, the version terragucci runs, reads with chant 0.121.1: the repo asks for a newer reader than the pinned behold reads");
    expect(explainBehold('{"code":"reader-too-old"}', o)).toMatch(/the repo asks for a newer reader than the pinned behold reads/);
  });

  it("names a peer behold could not load", () => {
    const line = explainBehold("Reading a Terraform estate needs chant's terraform lexicon, which behold does not install: @cdktn/hcl2json is not resolvable from /x.", o);
    expect(line).toBe("behold could not load @cdktn/hcl2json, the Terraform reader npx installs beside it (@intentius/chant-lexicon-terraform@^0.121.0, @cdktn/hcl2json@^0.24.0)");
    expect(explainBehold("Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@intentius/chant-lexicon-terraform' imported from /x", o)).toMatch(/^behold could not load @intentius\/chant-lexicon-terraform,/);
    expect(explainBehold("npm error notarget No matching version found for @intentius/behold@9.9.9.\n", o)).toMatch(/^npx could not fetch @intentius\/behold@9\.9\.9 from the npm registry/);
  });

  it("says the credentials could not read the bucket", () => {
    for (const said of ["An error occurred (AccessDenied) when calling the GetObject operation: Access Denied", "An error occurred (ExpiredToken) when calling the GetObject operation", "Unable to locate credentials. You can configure credentials by running \"aws configure\"."]) {
      expect(explainBehold(`aws s3 cp s3://acme-reports/tg/index.json failed: ${said}`, o)).toMatch(/^behold could not read s3:\/\/acme-reports\/tg with this shell's AWS credentials \(\w[\w ]*\): use a profile with s3:GetObject on the prefix, or pass --reports <dir>/);
    }
    expect(explainBehold("AccessDenied", { ...o, export: "/out", publish: true })).toMatch(/and s3:PutObject on views\/behold\/\* under it/);
  });

  it("shows behold export's refusal of the reports with its remedy, on one line", () => {
    expect(explainBehold("terragucci reports not read: index.json at s3://acme-reports/tg is not JSON\n  Fix or remove it; terragucci writes it again on the next run.\n", o)).toBe("index.json at s3://acme-reports/tg is not JSON Fix or remove it; terragucci writes it again on the next run.");
  });

  it("shows any other behold refusal with its remedy", () => {
    expect(explainBehold("behold serve: /repo has both chant.workspace.json and chant.workspace.jsonc.\n        Keep one of the two files.\n", o)).toBe("/repo has both chant.workspace.json and chant.workspace.jsonc. Keep one of the two files.");
  });

  it("names a busy port", () => {
    expect(explainBehold("Error: listen EADDRINUSE: address already in use 127.0.0.1:4600", { ...o, port: 4600 })).toBe("port 4600 is in use; pass --port with a free one");
  });

  it("is undefined for what it does not know", () => {
    expect(explainBehold("something else", o)).toBeUndefined();
  });
});

describe("explainRefusal", () => {
  it("is behold's own error and remedy", () => {
    expect(explainRefusal(JSON.stringify({ error: "index.json is not JSON.", code: "terragucci-report", remedy: "Fix it." }), { source: S3 })).toBe("index.json is not JSON. Fix it.");
  });

  it("is the credentials line when the read failed on them", () => {
    expect(explainRefusal(JSON.stringify({ error: "Could not read index.json from s3://acme-reports/tg: aws s3 cp failed: An error occurred (ExpiredToken)", code: "terragucci-report", remedy: "Check access." }), { source: S3 })).toMatch(/AWS credentials \(ExpiredToken\)/);
  });
});

// ── the run, with a fake npx ──────────────────────────────────────────────

interface Fake {
  deps: ViewDeps;
  spawns: { cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }[];
  printed: string[];
  warned: string[];
  forwarded: string[];
  killed: NodeJS.Signals[];
  signal(s: NodeJS.Signals): void;
  child: { write(t: string): void; exit(code: number | null, error?: NodeJS.ErrnoException): void };
}

/** A fake runner: `answers` is what each GET of /api/terragucci gets in turn ("down" refuses the connection). */
function fake(answers: (["down"] | [number, string])[], opts: { env?: NodeJS.ProcessEnv; onSpawn?: (f: Fake) => void; portTaken?: boolean } = {}): Fake {
  const f = { spawns: [], printed: [], warned: [], forwarded: [], killed: [] } as unknown as Fake;
  let listener: ((t: string) => void) | undefined;
  let resolveExit: (e: { code: number | null; error?: NodeJS.ErrnoException }) => void = () => {};
  let handler: ((s: NodeJS.Signals) => void) | undefined;
  f.child = {
    write: (t) => listener?.(t),
    exit: (code, error) => resolveExit({ code, ...(error ? { error } : {}) }),
  };
  f.signal = (s) => handler?.(s);
  let i = 0;
  f.deps = {
    spawn(cmd, args, o) {
      f.spawns.push({ cmd, args, env: o.env, cwd: o.cwd });
      if (cmd !== "npx") return { output: () => {}, exit: Promise.resolve({ code: 0 }), kill: () => {} };
      const child: ViewChild = {
        output: (fn) => void (listener = fn),
        exit: new Promise((r) => (resolveExit = r)),
        kill: (s) => {
          f.killed.push(s);
          resolveExit({ code: null });
        },
      };
      queueMicrotask(() => opts.onSpawn?.(f));
      return child;
    },
    async fetch(url) {
      if (!url.endsWith("/api/terragucci")) {
        if (opts.portTaken) return { status: 200, text: async () => "" };
        throw new Error("ECONNREFUSED");
      }
      const a = answers[Math.min(i++, answers.length - 1)];
      if (a[0] === "down") throw new Error("ECONNREFUSED");
      return { status: a[0], text: async () => a[1] };
    },
    env: opts.env ?? { HOME: "/h" },
    platform: "darwin",
    print: (l) => void f.printed.push(l),
    warn: (l) => void f.warned.push(l),
    forward: (t) => void f.forwarded.push(t),
    onSignal(fn) {
      handler = fn;
      return () => (handler = undefined);
    },
    sleep: async () => {},
    readyMs: 5000,
  };
  return f;
}

const serve: ViewOptions = { root: "/repo", source: { ...S3, endpoint: "http://floci:4566" }, project: PROJECT };

describe("view, serving", () => {
  it("runs the pinned behold with npx, waits for /api/terragucci, opens the browser and stays until Ctrl-C", async () => {
    const f = fake([["down"], ["down"], [200, "{}"]], {
      onSpawn: async (f) => {
        f.child.write("behold: listening\n");
        // Ctrl-C once it serves.
        await new Promise((r) => setTimeout(r, 5));
        f.child.write("GET /api/graph\n");
        f.signal("SIGINT");
      },
    });
    const code = await view(serve, f.deps);
    expect(code).toBe(0);
    expect(f.spawns[0]).toEqual({ cmd: "npx", args: beholdArgv(serve), env: { HOME: "/h", AWS_ENDPOINT_URL_S3: "http://floci:4566" }, cwd: "/repo" });
    expect(f.spawns[1]).toMatchObject({ cmd: "open", args: ["http://127.0.0.1:4600"] });
    expect(f.killed).toEqual(["SIGINT"]);
    expect(f.printed.at(-1)).toBe("terragucci view: behold serves http://127.0.0.1:4600; Ctrl-C stops it");
    expect(f.forwarded).toEqual(["GET /api/graph\n"]);
    expect(f.warned).toEqual([]);
  });

  it("opens no browser with --no-open", async () => {
    const f = fake([[200, "{}"]], { onSpawn: async (f) => (await new Promise((r) => setTimeout(r, 5)), f.signal("SIGTERM")) });
    expect(await view({ ...serve, open: false }, f.deps)).toBe(0);
    expect(f.spawns.map((s) => s.cmd)).toEqual(["npx"]);
    expect(f.killed).toEqual(["SIGTERM"]);
  });

  it("shows behold's 422 refusal with its error and remedy, and stops it", async () => {
    const f = fake([["down"], [422, JSON.stringify({ error: "index.json at s3://acme-reports/tg is not JSON.", code: "terragucci-report", remedy: "Fix or remove it." })]]);
    expect(await view(serve, f.deps)).toBe(1);
    expect(f.warned).toEqual(["terragucci view: index.json at s3://acme-reports/tg is not JSON. Fix or remove it."]);
    expect(f.killed).toEqual(["SIGTERM"]);
    expect(f.spawns.map((s) => s.cmd)).toEqual(["npx"]);
  });

  it("says the repo asks for a newer reader when behold exits on it", async () => {
    const f = fake([["down"]], {
      onSpawn: (f) => {
        f.child.write("behold serve: chant workspace ls: this declaration needs chant 0.130.0 or newer to read it, and this is chant 0.121.1\n        Upgrade.\n");
        f.child.exit(1);
      },
    });
    expect(await view(serve, f.deps)).toBe(1);
    expect(f.warned).toHaveLength(1);
    expect(f.warned[0]).toMatch(/^terragucci view: chant\.workspace\.json asks for chant 0\.130\.0 or newer .* the repo asks for a newer reader than the pinned behold reads$/);
  });

  it("says npx is missing", async () => {
    const f = fake([["down"]], { onSpawn: (f) => f.child.exit(null, Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" })) });
    expect(await view(serve, f.deps)).toBe(1);
    expect(f.warned).toEqual(["terragucci view: npx is not on the PATH: terragucci view runs behold with npx, which comes with Node.js"]);
  });

  it("prints behold's last line for a failure it does not know", async () => {
    const f = fake([["down"]], { onSpawn: (f) => (f.child.write("starting\nboom\n"), f.child.exit(7)) });
    expect(await view(serve, f.deps)).toBe(1);
    expect(f.warned).toEqual(["terragucci view: behold exited 7: boom"]);
  });

  it("gives up when behold never answers", async () => {
    const f = fake([["down"]]);
    expect(await view(serve, f.deps)).toBe(1);
    expect(f.warned).toEqual(["terragucci view: behold did not answer on http://127.0.0.1:4600 within 5 s"]);
    expect(f.killed).toEqual(["SIGTERM"]);
  });

  it("refuses a port something already answers on", async () => {
    const f = fake([[200, "{}"]], { portTaken: true });
    expect(await view(serve, f.deps)).toBe(1);
    expect(f.spawns).toEqual([]);
    expect(f.warned[0]).toMatch(/something already answers on http:\/\/127\.0\.0\.1:4600/);
  });
});

describe("view, exporting", () => {
  it("exports and prints behold's summary", async () => {
    const o = { ...serve, export: "/out", publish: true };
    const f = fake([], { onSpawn: (f) => (f.child.write("npm warn exec\nbehold export → /out\n  12 snapshots\n"), f.child.exit(0)) });
    expect(await view(o, f.deps)).toBe(0);
    expect(f.spawns[0].args).toEqual(beholdArgv(o));
    expect(f.spawns[0].args.slice(-4)).toEqual(["--out", "/out", "--publish", "s3://acme-reports/tg/views/behold"]);
    expect(f.spawns[0].env.AWS_ENDPOINT_URL_S3).toBe("http://floci:4566");
    expect(f.printed.slice(1)).toEqual(["behold export → /out", "  12 snapshots"]);
    expect(f.warned).toEqual([]);
  });

  it("maps a credentials failure to one line", async () => {
    const f = fake([], { onSpawn: (f) => (f.child.write("terragucci reports not read: Could not read index.json from s3://acme-reports/tg: aws s3 cp failed: Unable to locate credentials\n  Check access.\n"), f.child.exit(1)) });
    expect(await view({ ...serve, export: "/out" }, f.deps)).toBe(1);
    expect(f.warned).toEqual(["terragucci view: behold could not read s3://acme-reports/tg with this shell's AWS credentials (Unable to locate credentials): use a profile with s3:GetObject on the prefix, or pass --reports <dir> with a copy made by aws s3 sync"]);
  });

  it("maps a missing peer to one line", async () => {
    const f = fake([], { onSpawn: (f) => (f.child.write("Reading a Terraform estate needs chant's terraform lexicon, which behold does not install: @intentius/chant-lexicon-terraform and @cdktn/hcl2json are not resolvable from /x.\n"), f.child.exit(1)) });
    expect(await view({ ...serve, export: "/out" }, f.deps)).toBe(1);
    expect(f.warned).toEqual(["terragucci view: behold could not load @intentius/chant-lexicon-terraform and @cdktn/hcl2json, the Terraform reader npx installs beside it (@intentius/chant-lexicon-terraform@^0.121.0, @cdktn/hcl2json@^0.24.0)"]);
  });
});
