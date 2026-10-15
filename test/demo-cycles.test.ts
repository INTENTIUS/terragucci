// scripts/demo-cycles.ts: the record of a demo cycle that behold's per-tool
// page replays between live runs.
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCycle, type CycleDoc, cycleKeys, cyclesToPrune, type CycleStep, readTimeline } from "../scripts/demo-cycles-lib";
import { readMarks } from "../scripts/demo-runs-lib";

const root = join(__dirname, "..");

const step = (cycle: number, name: string, at: string, extra: Partial<CycleStep> = {}): CycleStep => ({
  cycle,
  scenario: "tg-planned-outputs",
  step: name,
  started_at: "2026-10-20T10:00:00Z",
  at,
  ...extra,
});

const ran: CycleStep[] = [
  step(14, "pull-request", "2026-10-20T10:00:01Z"),
  step(14, "planned", "2026-10-20T10:00:40Z"),
  step(14, "merged", "2026-10-20T10:01:00Z"),
  step(14, "applied", "2026-10-20T10:01:50Z"),
  step(14, "reset", "2026-10-20T10:02:10Z"),
];

const marks = readMarks(
  ['{"id":72,"cycle":13}', '{"id":75,"trigger":"merge","cycle":14}', '{"id":74,"trigger":"plan","cycle":14}', '{"id":76,"trigger":"reset","cycle":14}'].join("\n"),
);

const build = (steps: CycleStep[], scenario = "tg-planned-outputs") =>
  buildCycle({ tool: "terragrunt", repo: "admin/demo-terragrunt", scenario, cycle: 14, steps, marks });

describe("a cycle's record", () => {
  it("holds every step of the cycle, its start and end, and the runs it started, oldest first", () => {
    const got = build([step(13, "reset", "2026-10-20T09:59:00Z"), ...ran]);
    expect("doc" in got).toBe(true);
    const doc = (got as { doc: CycleDoc }).doc;
    expect(doc).toMatchObject({
      schema: "demo.cycle/v1",
      tool: "terragrunt",
      repo: "admin/demo-terragrunt",
      scenario: "tg-planned-outputs",
      cycle: 14,
      started: "2026-10-20T10:00:00Z",
      ended: "2026-10-20T10:02:10Z",
      runs: [74, 75, 76],
    });
    expect(doc.steps.map((s) => s.step)).toEqual(["pull-request", "planned", "merged", "applied", "reset"]);
  });

  it("is never made for a cycle that stalled, even once it reset", () => {
    const stalled = [...ran.slice(0, 3), step(14, "stalled", "2026-10-20T10:05:00Z"), step(14, "reset", "2026-10-20T10:05:30Z")];
    expect(build(stalled)).toEqual({ skip: "cycle 14 stalled, so it does not replace the latest" });
  });

  it("is not made before the reset, or for the base", () => {
    expect(build(ran.slice(0, 4))).toMatchObject({ skip: expect.stringContaining("has not reset yet") });
    expect(build(ran, "base")).toMatchObject({ skip: expect.stringContaining("base") });
    expect(build([])).toMatchObject({ skip: expect.stringContaining("no step of cycle 14") });
  });

  it("reads the timeline a line at a time and skips a torn line", () => {
    expect(readTimeline('{"step":"planned"}\n{"step":\n\n[1]\n{"step":"reset"}\n').map((s) => s.step)).toEqual(["planned", "reset"]);
  });
});

describe("keeping 5 per tool", () => {
  it("deletes all but the newest 5, oldest first", () => {
    expect(cyclesToPrune([3, 9, 4, 12, 7, 10, 9, 1])).toEqual([1, 3]);
    expect(cyclesToPrune([2, 1])).toEqual([]);
  });

  it("reads only the tool's numbered records from a bucket listing, never latest.json or another tool's", () => {
    const xml = ["demo/cycles/terragrunt/7.json", "demo/cycles/terragrunt/latest.json", "demo/cycles/terraform/8.json", "demo/cycles/terragrunt/12.json"]
      .map((k) => `<Contents><Key>${k}</Key></Contents>`)
      .join("");
    expect(cycleKeys(`<ListBucketResult>${xml}</ListBucketResult>`, "demo", "terragrunt")).toEqual([7, 12]);
  });
});

// The publish end to end, against a stand-in for the bucket.
describe("scripts/demo-cycles.ts", () => {
  const serve = (bucket: Map<string, string>) =>
    createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://x");
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (url.searchParams.get("list-type") === "2") {
          const keys = [...bucket.keys()].filter((k) => k.startsWith(url.searchParams.get("prefix") ?? ""));
          res.writeHead(200);
          return res.end(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`);
        }
        const key = url.pathname.replace(/^\/demo-reports\//, "");
        if (req.method === "PUT") bucket.set(key, body);
        if (req.method === "DELETE") bucket.delete(key);
        res.writeHead(200);
        res.end("");
      });
    });

  const publish = (port: number, dir: string, steps: CycleStep[]) => {
    writeFileSync(join(dir, "timeline.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
    writeFileSync(join(dir, "marks.jsonl"), '{"id":74,"cycle":14}\n');
    return new Promise<void>((resolve, reject) =>
      execFile(
        join(root, "node_modules", ".bin", "tsx"),
        [join(root, "scripts", "demo-cycles.ts")],
        {
          env: {
            PATH: process.env.PATH ?? "",
            DEMO_CYCLES_TIMELINE: join(dir, "timeline.jsonl"),
            DEMO_CYCLES_MARKS: join(dir, "marks.jsonl"),
            DEMO_CYCLES_BUCKET_URL: `http://127.0.0.1:${port}/demo-reports`,
            DEMO_CYCLES_PREFIX: "demo",
            DEMO_CYCLES_TOOL: "terragrunt",
            DEMO_CYCLES_REPO: "admin/demo-terragrunt",
            DEMO_CYCLES_CYCLE: "14",
            DEMO_CYCLES_SCENARIO: "tg-planned-outputs",
          },
        },
        (err, _out, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve()),
      ),
    );
  };

  it("writes the cycle and latest, prunes the tool's older cycles, and leaves latest alone for a stalled cycle", async () => {
    const bucket = new Map<string, string>(
      [1, 2, 3, 4, 5, 6].map((n) => [`demo/cycles/terragrunt/${n}.json`, "{}"] as [string, string]).concat([["demo/cycles/terraform/1.json", "{}"]]),
    );
    bucket.set("demo/cycles/terragrunt/latest.json", '{"cycle":6}');
    const server = serve(bucket);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), "demo-cycles-"));
    try {
      // A stalled cycle: nothing written, nothing deleted.
      await publish(port, dir, [...ran.slice(0, 2), step(14, "stalled", "2026-10-20T10:05:00Z"), step(14, "reset", "2026-10-20T10:05:30Z")]);
      expect(bucket.get("demo/cycles/terragrunt/latest.json")).toBe('{"cycle":6}');
      expect(bucket.has("demo/cycles/terragrunt/14.json")).toBe(false);
      expect(bucket.has("demo/cycles/terragrunt/1.json")).toBe(true);

      await publish(port, dir, ran);
      const latest = JSON.parse(bucket.get("demo/cycles/terragrunt/latest.json") ?? "{}") as CycleDoc;
      expect(latest).toMatchObject({ cycle: 14, tool: "terragrunt", runs: [74] });
      expect(bucket.get("demo/cycles/terragrunt/14.json")).toBe(bucket.get("demo/cycles/terragrunt/latest.json"));
      expect([...bucket.keys()].filter((k) => /cycles\/terragrunt\/\d+\.json$/.test(k)).sort()).toEqual(
        ["demo/cycles/terragrunt/14.json", "demo/cycles/terragrunt/3.json", "demo/cycles/terragrunt/4.json", "demo/cycles/terragrunt/5.json", "demo/cycles/terragrunt/6.json"],
      );
      // Another tool's cycles are its own.
      expect(bucket.has("demo/cycles/terraform/1.json")).toBe(true);
    } finally {
      server.close();
    }
  });
});
