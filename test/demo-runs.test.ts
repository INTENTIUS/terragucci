// scripts/demo-runs.ts: the demo's runs as behold's kiosk reads them from the
// reports bucket. The fixtures are runs 443 (a pull request's plan), 444 (a
// merge whose wave 2 waited at the gate) and 445 (the /terragucci apply that
// resumed it), as the demo host's Forgejo returned them.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildIndex,
  buildJob,
  buildRun,
  type ForgeJob,
  type ForgeRun,
  type IndexDoc,
  type Job,
  keptIds,
  mapStatus,
  parseSteps,
  readMarks,
  runKeys,
  type RunDoc,
  toPrune,
  UNNAMED,
  workflowSteps,
} from "../scripts/demo-runs-lib";

const root = join(__dirname, "..");
const fx = join(__dirname, "fixtures", "demo-runs");
const text = (f: string) => readFileSync(join(fx, f), "utf8");
const json = <T>(f: string) => JSON.parse(text(f)) as T;

// The demo's workflow at run 444's commit; 443 and 445 ran the same one.
const workflow = workflowSteps(text("workflow-444.yml"));

/** The run's jobs, steps named from the workflow, or from the log alone with `bare`. */
function jobsOf(run: number, bare = false): Job[] {
  return json<ForgeJob[]>(`jobs-${run}.json`).map((j) => {
    let log: string | null = null;
    try {
      log = text(`log-${run}-${j.id}.txt`);
    } catch {
      log = null;
    }
    return buildJob(j, log, [], bare ? null : (workflow.get(j.name) ?? null));
  });
}

describe("the workflow's steps", () => {
  it("names each job's steps by name, else uses", () => {
    expect(workflow.get("apply-wave-2")).toEqual([
      { name: "https://code.forgejo.org/actions/checkout@v4", uses: "https://code.forgejo.org/actions/checkout@v4" },
      { name: "Apply wave 2 of 3", uses: null },
      { name: "Keep the apply report", uses: "https://code.forgejo.org/actions/upload-artifact@v3" },
    ]);
    // Steps whose first key is if: or id:.
    expect(workflow.get("replan")?.map((s) => s.name)).toEqual([
      "https://code.forgejo.org/actions/checkout@v4",
      "Read the comment and decide whether it re-plans",
      "https://code.forgejo.org/actions/checkout@v4",
      "Re-plan the pull request on request and write the plan report",
      "Keep the plan report",
    ]);
    expect(workflow.size).toBe(11);
  });

  it("names a step with neither by the first line of its run", () => {
    const w = workflowSteps("on: push\njobs:\n  a:\n    steps:\n      - run: |\n          echo one\n          echo two\n      - run: echo three\n");
    expect(w.get("a")?.map((s) => s.name)).toEqual(["echo one", "echo three"]);
  });
});

describe("statuses", () => {
  it("maps Forgejo's queued states to queued, and a gate's failure to waiting", () => {
    expect(mapStatus("waiting")).toBe("queued");
    expect(mapStatus("blocked")).toBe("queued");
    expect(mapStatus("running")).toBe("running");
    expect(mapStatus("failure")).toBe("failure");
    expect(mapStatus("failure", true)).toBe("waiting");
    expect(mapStatus("cancelled")).toBe("cancelled");
  });
});

describe("steps of run 444's apply-wave-2, held at the gate", () => {
  const job = jobsOf(444).find((j) => j.name === "apply-wave-2") as Job;

  it("is waiting, not failed", () => {
    expect(job.status).toBe("waiting");
    expect(job.needs).toEqual(["apply-wave-1"]);
    expect(job.started_at).toBe("2026-10-15T04:09:40.064Z");
    expect(job.ended_at).toBe("2026-10-15T04:09:45.039Z");
  });

  it("puts the gate's output and the wait on the workflow's run step", () => {
    expect(job.steps.map((s) => [s.name, s.status])).toEqual([
      ["Set up job", "success"],
      ["https://code.forgejo.org/actions/checkout@v4", "success"],
      ["Apply wave 2 of 3", "waiting"],
      ["Keep the apply report", "success"],
      ["Post https://code.forgejo.org/actions/checkout@v4", "success"],
      ["Complete job", "success"],
    ]);
    const [setup, checkout, held, keep, , done] = job.steps;
    expect(setup.log[0]).toMatch(/^Runner .* received task 1588 of job apply-wave-2/);
    expect(setup.log.some((l) => l.startsWith("⭐"))).toBe(false);
    expect(checkout.log.at(-1)).toBe("::remove-matcher owner=checkout-git::");
    expect(checkout.log.some((l) => l.startsWith("wave "))).toBe(false);
    expect(held.log[0]).toBe("wave 2 of 3: planning app");
    expect(held.log.some((l) => l.includes("wave 2 of 3 waits for an approval of digest"))).toBe(true);
    expect(held.log.at(-1)).toBe("⚙️ [runner]: exitcode '3': failure");
    expect(held.ended_at).toBe("2026-10-15T04:09:44.488Z");
    expect(keep.log[0]).toBe("With the provided path, there will be 7 files uploaded");
    expect(keep.log.at(-1)).toBe("Artifact terragucci-report-apply-wave-2 has been successfully uploaded!");
    expect(done.log).toEqual(["🏁  Job failed", "Job 'apply-wave-2' failed"]);
    // Stamps are gone from every line.
    for (const s of job.steps) for (const l of s.log) expect(l).not.toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("without the workflow, splits the same places and names the unmarked steps Run", () => {
    const bare = jobsOf(444, true).find((j) => j.name === "apply-wave-2") as Job;
    expect(UNNAMED).toBe("Run");
    expect(bare.steps.map((s) => [s.name, s.status])).toEqual([
      ["Set up job", "success"],
      ["https://code.forgejo.org/actions/checkout@v4", "success"],
      ["Run", "waiting"],
      ["Run", "success"],
      ["Post https://code.forgejo.org/actions/checkout@v4", "success"],
      ["Complete job", "success"],
    ]);
  });

  it("makes the run waiting", () => {
    const { doc, entry } = buildRun(json<ForgeRun>("run-444.json"), jobsOf(444), {
      id: 444,
      trigger: "merge",
      cycle: 90,
      scenario: "a-output",
      pull: 278,
    });
    expect(doc.status).toBe("waiting");
    expect(doc.ended_at).toBe("2026-10-15T04:09:45Z");
    expect(entry).toMatchObject({ trigger: "merge", ref: "main", pull: 278, cycle: 90, scenario: "a-output" });
    expect(entry.jobs.find((j) => j.name === "plan")?.status).toBe("skipped");
    expect("steps" in entry.jobs[0]).toBe(false);
  });
});

describe("the other samples", () => {
  it("names the plan run's steps, and reads its pull request from its ref", () => {
    const jobs = jobsOf(443);
    const plan = jobs.find((j) => j.name === "plan") as Job;
    expect(plan.steps.map((s) => [s.name, s.status])).toEqual([
      ["Set up job", "success"],
      ["Say on the head that the plan started", "success"],
      ["https://code.forgejo.org/actions/checkout@v4", "success"],
      ["Plan the roots the change reaches and write the plan report", "success"],
      ["Keep the plan report", "success"],
      ["Post https://code.forgejo.org/actions/checkout@v4", "success"],
      ["Complete job", "success"],
    ]);
    const note = jobs.find((j) => j.name === "plan-note") as Job;
    expect(note.steps.map((s) => s.name)).toEqual(["Set up job", "Fetch the plan report", "Post the plan note and terragucci/plan", "Complete job"]);
    expect(note.steps[2].log[0]).toBe("terragucci plan-note: posted the plan note on pull request 278");
    const { doc, entry } = buildRun(json<ForgeRun>("run-443.json"), jobs, undefined);
    expect(doc).toMatchObject({ schema: "demo.run/v1", status: "success", trigger: "plan", pull: 278, cycle: null });
    expect(entry.ref).toBeNull();
  });

  it("shows the resume run as a success", () => {
    const { doc } = buildRun(json<ForgeRun>("run-445.json"), jobsOf(445), { id: 445, trigger: "resume" });
    expect(doc.status).toBe("success");
    expect(doc.jobs.find((j) => j.name === "apply-comment")?.steps.map((s) => s.name)).toEqual([
      "Set up job",
      "https://code.forgejo.org/actions/checkout@v4",
      "Apply a merged pull request on request, from its merge commit",
      "Keep the apply report",
      "Post https://code.forgejo.org/actions/checkout@v4",
      "Complete job",
    ]);
    expect(doc.trigger).toBe("resume");
  });
});

describe("the step parser", () => {
  const at = (s: number) => `2026-10-15T04:00:${String(s).padStart(2, "0")}.0000000Z`;

  it("keeps each step's last 300 lines, cuts lines to 500 characters and strips ANSI", () => {
    const lines = [`${at(0)} setup`, `${at(1)} ⭐ Run Main big`];
    for (let i = 0; i < 305; i++) lines.push(`${at(2)} \x1b[31mline ${i}\x1b[0m`);
    lines.push(`${at(3)} ${"x".repeat(600)}`, `${at(4)}   ✅  Success - Main big`, `${at(5)} 🏁  Job succeeded`);
    const [, big] = parseSteps(lines.join("\n"), "success");
    expect(big.truncated).toBe(6);
    expect(big.log).toHaveLength(300);
    expect(big.log[0]).toBe("line 6");
    expect(big.log.at(-1)).toHaveLength(500);
  });

  it("leaves a line holding a guarded string out", () => {
    const log = [`${at(0)} ⭐ Run Main s`, `${at(1)} token abc123 here`, `${at(2)} AWS_SECRET_ACCESS_KEY=x`, `${at(3)} fine`].join("\n");
    const steps = parseSteps(log, "running", ["abc123", "AWS_SECRET_ACCESS_KEY"]);
    expect(steps.at(-1)).toMatchObject({ name: "s", status: "running", log: ["fine"], ended_at: null });
  });

  it("marks a failed step, and a job that failed without the gate", () => {
    const log = [`${at(0)} ⭐ Run Main boom`, `${at(1)} waits for an approval`, `${at(2)} ⚙️ [runner]: exitcode '1': failure`, `${at(3)} ❌  Failure - Main boom`, `${at(4)} 🏁  Job failed`].join("\n");
    const job = buildJob({ id: 1, name: "j", needs: null, status: "failure", task_id: 9 }, log);
    expect(job.status).toBe("failure");
    expect(job.steps.map((s) => s.status)).toEqual(["failure", "failure"]);
  });

  it("gives a queued job no steps", () => {
    expect(buildJob({ id: 1, name: "j", needs: ["a"], status: "waiting", task_id: 0 }, null)).toMatchObject({
      status: "queued",
      steps: [],
      started_at: null,
      ended_at: null,
    });
  });
});

describe("keeping 30", () => {
  it("keeps the newest, prunes the rest, and reads the bucket's keys", () => {
    const ids = Array.from({ length: 40 }, (_, i) => 400 + i);
    const kept = keptIds(ids);
    expect(kept).toHaveLength(30);
    expect(kept[0]).toBe(439);
    expect(kept.at(-1)).toBe(410);
    expect(toPrune([401, 410, 439, 300], kept)).toEqual([300, 401]);
    const xml = "<ListBucketResult><Contents><Key>demo/runs/index.json</Key></Contents><Contents><Key>demo/runs/12.json</Key></Contents><Contents><Key>demo/x/13.json</Key></Contents></ListBucketResult>";
    expect(runKeys(xml, "demo")).toEqual([12]);
  });

  it("orders the index newest first", () => {
    const idx = buildIndex([1, 3, 2].map((id) => ({ id }) as never), new Date("2026-10-15T04:00:00.123Z"));
    expect(idx.runs.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(idx).toMatchObject({ schema: "demo.runs/v1", keep: 30, updated_at: "2026-10-15T04:00:00Z" });
  });

  it("reads the driver's marks, later over earlier", () => {
    const m = readMarks('{"id":5,"cycle":3,"scenario":"a"}\n{"id":5,"trigger":"merge"}\nnot json\n');
    expect(m.get(5)).toEqual({ id: 5, cycle: 3, scenario: "a", trigger: "merge" });
  });
});

// The exporter end to end, against a stand-in for Forgejo and the bucket.
describe("scripts/demo-runs.ts", () => {
  it("writes the index and the runs, keeps 30 and deletes older objects", async () => {
    const base = json<ForgeRun>("run-443.json");
    const listed: ForgeRun[] = Array.from({ length: 32 }, (_, i) => ({ ...base, id: 415 + i, prettyref: "main" }));
    // 444 is the real waiting merge, with its jobs and logs.
    const at = listed.findIndex((r) => r.id === 444);
    listed[at] = json<ForgeRun>("run-444.json");
    const bucket = new Map<string, string>([["demo/runs/400.json", "{}"], ["demo/runs/416.json", "{}"]]);
    const seen: string[] = [];

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://x");
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push(`${req.method} ${url.pathname}`);
        const send = (code: number, out: string) => {
          res.writeHead(code);
          res.end(out);
        };
        if (url.pathname === `/admin/demo/raw/commit/${json<ForgeRun>("run-444.json").commit_sha}/.forgejo/workflows/terragucci.yml`) {
          return req.headers.authorization === "token sekrit" ? send(200, text("workflow-444.yml")) : send(404, "");
        }
        const api = "/api/v1/repos/admin/demo";
        if (url.pathname.startsWith(api)) {
          if (req.headers.authorization !== "token sekrit") return send(401, "");
          const p = url.pathname.slice(api.length);
          if (p === "/actions/runs") return send(200, JSON.stringify({ workflow_runs: listed }));
          let m = /^\/actions\/runs\/(\d+)$/.exec(p);
          if (m) return send(200, JSON.stringify(listed.find((r) => r.id === Number(m?.[1]))));
          m = /^\/actions\/runs\/(\d+)\/jobs$/.exec(p);
          if (m) return send(200, m[1] === "444" ? text("jobs-444.json") : "[]");
          m = /^\/actions\/jobs\/(\d+)\/logs$/.exec(p);
          if (m) {
            try {
              return send(200, text(`log-444-${m[1]}.txt`));
            } catch {
              return send(404, "");
            }
          }
          return send(404, "");
        }
        if (url.pathname === "/demo-reports" && url.searchParams.get("list-type") === "2") {
          const keys = [...bucket.keys()].filter((k) => k.startsWith(url.searchParams.get("prefix") ?? ""));
          return send(200, `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`);
        }
        const key = url.pathname.replace(/^\/demo-reports\//, "");
        if (req.method === "PUT") bucket.set(key, body);
        if (req.method === "DELETE") bucket.delete(key);
        send(200, "");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const state = mkdtempSync(join(tmpdir(), "demo-runs-"));
    const run = () =>
      new Promise<void>((resolve, reject) =>
        execFile(
          join(root, "node_modules", ".bin", "tsx"),
          [join(root, "scripts", "demo-runs.ts")],
          {
            env: {
              PATH: process.env.PATH ?? "",
              DEMO_RUNS_FORGE_URL: `http://127.0.0.1:${port}`,
              DEMO_RUNS_TOKEN: "sekrit",
              DEMO_RUNS_REPO: "admin/demo",
              DEMO_RUNS_BUCKET_URL: `http://127.0.0.1:${port}/demo-reports`,
              DEMO_RUNS_PREFIX: "demo",
              DEMO_RUNS_STATE: state,
              DEMO_RUNS_CYCLE: "90",
              DEMO_RUNS_SCENARIO: "a-output",
              DEMO_RUNS_CYCLE_STARTED: String(Date.parse("2026-10-15T04:08:00Z") / 1000),
            },
          },
          (err, _out, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve()),
        ),
      );
    try {
      await run();
      const index = JSON.parse(bucket.get("demo/runs/index.json") ?? "{}") as IndexDoc;
      expect(index.runs).toHaveLength(30);
      expect(index.runs[0].id).toBe(446);
      expect(index.runs.at(-1)?.id).toBe(417);
      expect(index.runs.find((r) => r.id === 444)).toMatchObject({ status: "waiting", cycle: 90, scenario: "a-output", trigger: "push" });
      const r444 = JSON.parse(bucket.get("demo/runs/444.json") ?? "{}") as RunDoc;
      const wave2 = r444.jobs.find((j) => j.name === "apply-wave-2");
      expect(wave2?.status).toBe("waiting");
      expect(wave2?.steps.find((s) => s.status === "waiting")?.name).toBe("Apply wave 2 of 3");
      expect([...bucket.keys()].filter((k) => /runs\/\d+\.json$/.test(k))).toHaveLength(30);
      expect(bucket.has("demo/runs/400.json")).toBe(false);
      expect(bucket.has("demo/runs/416.json")).toBe(false);
      expect(bucket.has("demo/runs/415.json")).toBe(false);

      // A second export with nothing changed writes nothing, and a mark the driver adds rewrites that run.
      seen.length = 0;
      await run();
      expect(seen.filter((s) => s.startsWith("PUT"))).toEqual([]);
      const { appendFileSync } = await import("node:fs");
      appendFileSync(join(state, "marks.jsonl"), '{"id":444,"trigger":"merge","pull":278}\n');
      seen.length = 0;
      await run();
      expect(seen.filter((s) => s.startsWith("PUT")).sort()).toEqual(["PUT /demo-reports/demo/runs/444.json", "PUT /demo-reports/demo/runs/index.json"]);
      expect((JSON.parse(bucket.get("demo/runs/444.json") ?? "{}") as RunDoc).trigger).toBe("merge");
    } finally {
      server.close();
    }
  });
});
