// scripts/demo-pulls.ts: each reset deletes the demo repos' old closed pull
// requests in Forgejo, never one still needed, and has Forgejo gc its repos at
// most hourly (behold#603). The choices are tested on their own, then the
// script against a stand-in Forgejo and bucket that answer as Forgejo 16 and
// floci do.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maintenanceDue, PULLS_DELETE_MAX, PULLS_KEEP_MIN, pullsToDelete, referencedPulls } from "../scripts/demo-pulls-lib";

const root = join(__dirname, "..");
const closed = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ number: from + i, state: "closed" }));

describe("pullsToDelete", () => {
  it("deletes the closed pull requests past the newest kept, oldest first, a few at a time", () => {
    const ids = pullsToDelete({ oldest: closed(1, 80), closed: 80, keep: 50, newest: 81, protect: new Set() });
    expect(ids).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    // Never more than PULLS_DELETE_MAX in one reset.
    expect(pullsToDelete({ oldest: closed(1, 200), closed: 2000, keep: 50, newest: 2001, protect: new Set() })).toHaveLength(PULLS_DELETE_MAX);
  });

  it("never deletes an open one, the newest, or one the bucket names", () => {
    const oldest = closed(1, 30);
    oldest[2] = { number: 3, state: "open" };
    const ids = pullsToDelete({ oldest, closed: 30, keep: 10, newest: 5, protect: new Set([7, 9]) });
    expect(ids).not.toContain(3);
    expect(ids).not.toContain(5);
    expect(ids).not.toContain(7);
    expect(ids).not.toContain(9);
    expect(ids).toEqual([1, 2, 4, 6, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it("keeps at least PULLS_KEEP_MIN, and deletes nothing from a repo with fewer", () => {
    expect(pullsToDelete({ oldest: closed(1, 15), closed: 15, keep: 0, newest: 15, protect: new Set() })).toEqual([1, 2, 3, 4, 5]);
    expect(PULLS_KEEP_MIN).toBe(10);
    expect(pullsToDelete({ oldest: closed(1, 9), closed: 9, keep: 0, newest: 9, protect: new Set() })).toEqual([]);
  });
});

describe("referencedPulls", () => {
  it("takes the pull requests of the repo's stored cycles and of the runs in the index", () => {
    const cycle = { schema: "demo.cycle/v1", repo: "admin/demo", steps: [{ pull: null }, { pull: 41 }, { pull: 41 }], runs: [1, 2] };
    const other = { schema: "demo.cycle/v1", repo: "admin/demo-terragrunt", steps: [{ pull: 12 }], runs: [] };
    const index = {
      schema: "demo.runs/v1",
      runs: [
        { id: 1, repo: "admin/demo", pull: 40 },
        { id: 2, repo: "admin/demo-terragrunt", pull: 13 },
        { id: 3, repo: null, pull: 39 },
        { id: 4, repo: "admin/demo", pull: null },
      ],
    };
    expect([...referencedPulls("admin/demo", [cycle, other, index])].sort()).toEqual([39, 40, 41]);
    expect([...referencedPulls("admin/demo-terragrunt", [cycle, other, index])].sort()).toEqual([12, 13, 39]);
  });
});

describe("maintenanceDue", () => {
  it("is due when it never ran, or an hour after it last did", () => {
    expect(maintenanceDue(null, 1000)).toBe(true);
    expect(maintenanceDue(1000, 1000 + 3599)).toBe(false);
    expect(maintenanceDue(1000, 1000 + 3600)).toBe(true);
    expect(maintenanceDue(Number.NaN, 1000)).toBe(true);
  });
});

interface Stand {
  url: string;
  deleted: string[];
  cron: string[];
  close: () => void;
}

/** A stand-in Forgejo (pulls paged and sorted as Forgejo 16 does, with X-Total-Count) and reports bucket. */
async function stand(pulls: Record<string, { number: number; state: string }[]>, bucket: Record<string, string>, opts: { bucketDown?: boolean } = {}): Promise<Stand> {
  const deleted: string[] = [];
  const cron: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    req.resume();
    req.on("end", () => {
      const send = (code: number, out: string, headers: Record<string, string> = {}) => {
        res.writeHead(code, headers);
        res.end(out);
      };
      if (url.pathname.startsWith("/api/v1/")) {
        if (req.headers.authorization !== "token sekrit") return send(401, "");
        let m = /^\/api\/v1\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(url.pathname);
        if (m && req.method === "GET") {
          const repo = m[1];
          const live = (pulls[repo] ?? []).filter((p) => !deleted.includes(`${repo}#${p.number}`));
          const state = url.searchParams.get("state") ?? "";
          let list = state === "open" || state === "closed" ? live.filter((p) => p.state === state) : live;
          list = [...list].sort((a, b) => (url.searchParams.get("sort") === "oldest" ? a.number - b.number : b.number - a.number));
          const page = Number(url.searchParams.get("page") ?? 1);
          const limit = Math.min(Number(url.searchParams.get("limit") ?? 30), 50);
          return send(200, JSON.stringify(list.slice((page - 1) * limit, page * limit)), { "x-total-count": String(list.length) });
        }
        m = /^\/api\/v1\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url.pathname);
        if (m && req.method === "DELETE") {
          deleted.push(`${m[1]}#${m[2]}`);
          return send(204, "");
        }
        m = /^\/api\/v1\/admin\/cron\/(\w+)$/.exec(url.pathname);
        if (m && req.method === "POST") {
          cron.push(m[1]);
          return send(204, "");
        }
        return send(404, "");
      }
      if (opts.bucketDown) return send(503, "");
      if (url.searchParams.get("list-type") === "2") {
        const p = url.searchParams.get("prefix") ?? "";
        const keys = Object.keys(bucket).filter((k) => k.startsWith(p));
        return send(200, `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`);
      }
      const key = url.pathname.replace(/^\/demo-reports\//, "");
      if (key in bucket) return send(200, bucket[key]);
      send(404, "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, deleted, cron, close: () => server.close() };
}

function prune(s: Stand, extra: Record<string, string> = {}, stateDir = mkdtempSync(join(tmpdir(), "demo-pulls-"))): Promise<{ stderr: string; code: number }> {
  return new Promise((resolve) =>
    execFile(
      join(root, "node_modules", ".bin", "tsx"),
      [join(root, "scripts", "demo-pulls.ts")],
      {
        env: {
          PATH: process.env.PATH ?? "",
          DEMO_PULLS_FORGE_URL: s.url,
          DEMO_PULLS_TOKEN: "sekrit",
          DEMO_PULLS_REPOS: "admin/demo terraform\nadmin/demo-chant chant",
          DEMO_PULLS_KEEP: "50",
          DEMO_PULLS_BUCKET_URL: `${s.url}/demo-reports`,
          DEMO_PULLS_PREFIX: "demo",
          DEMO_PULLS_STATE: stateDir,
          ...extra,
        },
      },
      (err, _out, stderr) => resolve({ stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 }),
    ),
  );
}

describe("scripts/demo-pulls.ts", () => {
  it("deletes each repo's old closed pull requests, keeps what the bucket names, then has Forgejo gc", async () => {
    const demo = closed(1, 120);
    demo[119] = { number: 120, state: "open" }; // the cycle at hand, never closed by a reset that failed
    const chant = closed(1, 30);
    const s = await stand(
      { "admin/demo": demo, "admin/demo-chant": chant },
      {
        "demo/runs/index.json": JSON.stringify({ schema: "demo.runs/v1", runs: [{ id: 9, repo: "admin/demo", pull: 4 }] }),
        "demo/cycles/terraform/latest.json": JSON.stringify({ schema: "demo.cycle/v1", repo: "admin/demo", steps: [{ pull: 2 }], runs: [] }),
        "demo/cycles/terraform/88.json": JSON.stringify({ schema: "demo.cycle/v1", repo: "admin/demo", steps: [{ pull: 2 }], runs: [] }),
        "demo/cycles/terraform/87.json": JSON.stringify({ schema: "demo.cycle/v1", repo: "admin/demo", steps: [{ pull: 6 }], runs: [] }),
      },
    );
    try {
      const state = mkdtempSync(join(tmpdir(), "demo-pulls-"));
      const r = await prune(s, {}, state);
      expect(r.code).toBe(0);
      // admin/demo: 119 closed, 69 past the newest 50; at most 50 go, never 2, 4 or 6.
      const demoGone = s.deleted.filter((d) => d.startsWith("admin/demo#")).map((d) => Number(d.split("#")[1]));
      expect(demoGone).toHaveLength(50);
      expect(demoGone).toEqual([1, 3, 5, ...Array.from({ length: 47 }, (_, i) => 7 + i)]);
      expect(demoGone).not.toContain(120);
      // admin/demo-chant: 30 closed, under the newest 50.
      expect(s.deleted.filter((d) => d.startsWith("admin/demo-chant#"))).toEqual([]);
      expect(r.stderr).toContain("pulls: deleted 50 closed pull requests of admin/demo past the newest 50 (119 closed before)");
      expect(s.cron).toEqual(["cleanup_actions", "git_gc_repos"]);
      expect(Number(readFileSync(join(state, "maintenance.at"), "utf8"))).toBeGreaterThan(0);

      // The next reset, within the hour: the rest of the backlog, and no gc.
      const again = await prune(s, {}, state);
      expect(again.code).toBe(0);
      expect(s.deleted.filter((d) => d.startsWith("admin/demo#"))).toHaveLength(66);
      expect(s.cron).toEqual(["cleanup_actions", "git_gc_repos"]);
    } finally {
      s.close();
    }
  });

  it("deletes nothing when the bucket cannot be read, and says so", async () => {
    const s = await stand({ "admin/demo": closed(1, 120) }, {}, { bucketDown: true });
    try {
      const state = mkdtempSync(join(tmpdir(), "demo-pulls-"));
      writeFileSync(join(state, "maintenance.at"), `${Math.floor(Date.now() / 1000)}\n`);
      const r = await prune(s, {}, state);
      expect(r.code).toBe(1);
      expect(s.deleted).toEqual([]);
      expect(r.stderr).toContain("deleting no pull request");
    } finally {
      s.close();
    }
  });
});

describe("stack/demo.sh", () => {
  it("prunes the pull requests at a reset whose prune is due, after closing the open ones, and never fails the reset on it", () => {
    const demo = readFileSync(join(root, "stack", "demo.sh"), "utf8");
    const work = demo.slice(demo.indexOf("\nreset_work() {"), demo.indexOf("\nreset_written() {"));
    expect(work.indexOf('state":"closed')).toBeGreaterThan(-1);
    expect(work.indexOf("pulls_prune")).toBeGreaterThan(work.indexOf('state":"closed'));
    expect(work.match(/pulls_prune/g)).toHaveLength(2);
    const fn = demo.slice(demo.indexOf("\npulls_prune() {"), demo.indexOf("\n}\n", demo.indexOf("\npulls_prune() {")));
    expect(fn).toContain("scripts/demo-pulls.ts) \\\n    || log");
    expect(fn).toContain('DEMO_PULLS_KEEP="$FORGE_PULLS"');
    expect(demo).toMatch(/^FORGE_PULLS="\$\{DEMO_FORGE_PULLS:-50\}"/m);
  });
});
