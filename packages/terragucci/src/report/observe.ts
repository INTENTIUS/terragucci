/**
 * A stage run as a trace and as pipeline metrics. The stage is one trace:
 * its waves and roots are spans, and each run of the binary is a span the
 * binary's own spans hang under. The metrics are read from the finished
 * report, so they match what reviewers saw.
 *
 * Whether or not telemetry is on, the binary's own spans are collected for
 * the run (`spans.ts`), and the report names the slowest roots and, in each
 * root, the slowest resources and provider calls.
 */
import { spawnSync } from "node:child_process";
import { binaryEnv, metricsBody, nowNanos, send, Trace, tracesBody, type Gauge, type OtlpFetch, type Span, type Telemetry } from "../telemetry";
import type { Report } from "./schema";
import { rootTimings, runTimings, SpanReceiver } from "./spans";

interface RootTiming {
  path: string;
  start: bigint;
  end?: bigint;
  span?: Span;
  /** Each run of the binary in the root, in seconds. */
  commands: { command: string; seconds: number }[];
}

const seconds = (from: bigint, to: bigint): number => Number(to - from) / 1e9;

/** The binary's version, from `<binary> version -json`. */
export function binaryVersion(binary: string, env: NodeJS.ProcessEnv): string | undefined {
  const r = spawnSync(binary, ["version", "-json"], { encoding: "utf-8", env });
  try {
    const v = (JSON.parse(r.stdout) as { terraform_version?: string }).terraform_version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

export class StageObserver {
  readonly trace?: Trace;
  private readonly stageSpan?: Span;
  private readonly start = nowNanos();
  private readonly roots: RootTiming[] = [];
  private receiver?: SpanReceiver;

  constructor(readonly telemetry: Telemetry | undefined, readonly stage: string, env: NodeJS.ProcessEnv) {
    if (telemetry?.traces) {
      this.trace = new Trace(env.TRACEPARENT);
      this.stageSpan = this.trace.start(`terragucci ${stage}`, undefined, { "terragucci.stage": stage });
    }
  }

  /**
   * Start collecting the binary's spans for the report. Without it the
   * report still times each root, with no per-resource timings.
   */
  async collectSpans(log: (line: string) => void): Promise<void> {
    const receiver = new SpanReceiver(this.trace ? this.telemetry?.traces : undefined);
    const problem = await receiver.listen();
    if (problem) log(`timings: the binary's spans are not collected (${problem})`);
    else this.receiver = receiver;
  }

  /** Start timing a root; end it with `endRoot`. */
  root(path: string): RootTiming {
    const t: RootTiming = { path, start: nowNanos(), commands: [] };
    if (this.trace) t.span = this.trace.start(`root ${path}`, this.stageSpan, { "terragucci.root": path });
    this.roots.push(t);
    return t;
  }

  endRoot(t: RootTiming): void {
    t.end = nowNanos();
    if (t.span) t.span.end = t.end;
  }

  /** Run the binary inside a root, as a span of its own when tracing. */
  command<R extends { status: number | null; error?: Error }>(t: RootTiming, binary: string, args: string[], env: NodeJS.ProcessEnv, spawn: (env: NodeJS.ProcessEnv) => R): R {
    if (!this.trace || !t.span) return spawn(env);
    const span = this.trace.start(`${binary} ${args[0]}`, t.span, { "process.executable.name": binary, "process.command_args": args.join(" ") }, 3);
    const r = spawn(binaryEnv(env, this.trace, span, t.path));
    this.trace.end(span, { "process.exit.code": r.status ?? -1 }, r.status === 0 ? undefined : (r.error?.message ?? `exit ${r.status}`));
    return r;
  }

  /**
   * `command` for a run that does not block, so roots can plan at once. The
   * binary's spans also go to the stage's span receiver, which a blocking
   * run would starve.
   */
  async commandAsync<R extends { status: number | null; error?: Error }>(t: RootTiming, binary: string, args: string[], env: NodeJS.ProcessEnv, spawn: (env: NodeJS.ProcessEnv) => Promise<R>): Promise<R> {
    const start = nowNanos();
    const span = this.trace && t.span ? this.trace.start(`${binary} ${args[0]}`, t.span, { "process.executable.name": binary, "process.command_args": args.join(" ") }, 3) : undefined;
    let runEnv = span ? binaryEnv(env, this.trace!, span, t.path) : env;
    if (this.receiver) runEnv = this.receiver.env(runEnv, t.path, args[0]);
    const r = await spawn(runEnv);
    t.commands.push({ command: args[0], seconds: seconds(start, nowNanos()) });
    if (span) this.trace!.end(span, { "process.exit.code": r.status ?? -1 }, r.status === 0 ? undefined : (r.error?.message ?? `exit ${r.status}`));
    return r;
  }

  /**
   * Put each root's timings, and the run's slowest roots and resources, on
   * the report. A root this observer did not time (a Terragrunt unit, which
   * Terragrunt runs the binary for) gets none, and the run says why.
   */
  addTimings(report: Report): void {
    const binary = report.run.binary.split("/").pop() || report.run.binary;
    for (const r of report.roots) {
      const t = this.roots.find((x) => x.path === r.path);
      if (!t || t.end === undefined) continue;
      const plan = t.commands.find((c) => c.command === "plan");
      r.timings = rootTimings(this.receiver?.spansOf(t.path, "plan") ?? [], {
        binary,
        seconds: seconds(t.start, t.end),
        ...(plan ? { planSeconds: plan.seconds } : {}),
      });
    }
    const untimed = report.roots.length > 0 && report.roots.every((r) => r.timings === undefined);
    report.timings = runTimings(report.roots, untimed ? "Terragrunt ran the binary for these units, so the report has no per-unit timings" : undefined);
  }

  /** The metrics a finished report gives. */
  gauges(report: Report, version: string | undefined, end: bigint): Gauge[] {
    const project = report.run.project;
    const stage = this.stage;
    const result = report.roots.some((r) => r.status === "failed") ? "failure" : "success";
    const g = (name: string, unit: string, description: string, value: number, attributes: Record<string, string>): Gauge => ({ name, unit, description, value, attributes: { project, stage, ...attributes } });
    const out: Gauge[] = [
      g("terragucci_stage_duration_seconds", "s", "How long the stage ran", seconds(this.start, end), { result }),
      g("terragucci_roots_planned", "{root}", "Roots the stage planned, failed ones included", report.roots.length, {}),
      g("terragucci_plan_groups", "{group}", "Groups the plans fold into", report.groups.length, {}),
    ];
    for (const t of this.roots) {
      if (t.end !== undefined) out.push(g("terragucci_root_plan_seconds", "s", "How long one root took to plan", seconds(t.start, t.end), { root: t.path }));
    }
    for (const [action, n] of Object.entries(report.totals)) {
      out.push(g("terragucci_plan_changes", "{change}", "Proposed changes by action", n, { action }));
    }
    if (version) out.push(g("terragucci_binary_version", "", "The binary and version a stage ran", 1, { binary: report.run.binary, version }));
    return out;
  }

  /** Close the trace from the report, then send the trace and the metrics. Never throws. */
  async finish(report: Report, env: NodeJS.ProcessEnv, log: (line: string) => void, fetchFn?: OtlpFetch): Promise<void> {
    if (this.receiver) {
      for (const u of this.receiver.unreadable) log(`timings: a batch of spans could not be read: ${u}`);
      const failed = await this.receiver.close();
      if (failed.length) log(`telemetry: ${failed.length} of the binary's span batches were not forwarded: ${failed[0]}`);
    }
    const tel = this.telemetry;
    if (!tel) return;
    for (const s of tel.skipped) log(`telemetry: ${s}`);
    const end = nowNanos();
    const run = report.run;
    const resource = {
      ...tel.resource,
      "service.version": run.terragucci,
      "terragucci.project": run.project,
      "vcs.ref.head.revision": run.commit,
      ...(run.job_url ? { "cicd.pipeline.run.url.full": run.job_url } : {}),
    };
    const sent: string[] = [];

    if (tel.traces && this.trace && this.stageSpan) {
      const failed = report.roots.filter((r) => r.status === "failed").length;
      this.trace.end(this.stageSpan, {
        "terragucci.project": run.project,
        "vcs.ref.head.revision": run.commit,
        "terragucci.binary": run.binary,
        "terragucci.runtime": run.runtime,
        "terragucci.change_set": report.change_set,
        "terragucci.roots": report.roots.length,
        "terragucci.roots_failed": failed,
        ...Object.fromEntries(Object.entries(report.totals).map(([a, n]) => [`terragucci.plan.${a}`, n])),
      }, failed ? `${failed} root(s) failed` : undefined);
      // Waves are known once every root has planned, so their spans are set
      // around the roots they hold.
      for (const w of report.waves) {
        const held = this.roots.filter((t) => w.roots.includes(t.path) && t.span);
        if (held.length === 0) continue;
        const span = this.trace.start(`wave ${w.number}`, this.stageSpan, { "terragucci.wave": w.number, "terragucci.set_digest": w.set_digest ?? undefined, "terragucci.approval": w.approval });
        span.start = held.reduce((m, t) => (t.start < m ? t.start : m), held[0].start);
        span.end = held.reduce((m, t) => (t.end! > m ? t.end! : m), held[0].end!);
        for (const t of held) t.span!.parentSpanId = span.spanId;
      }
      for (const t of this.roots) {
        const r = report.roots.find((x) => x.path === t.path);
        if (!r || !t.span) continue;
        Object.assign(t.span.attributes, {
          "terragucci.status": r.status,
          "terragucci.plan_digest": r.plan_digest ?? undefined,
          ...Object.fromEntries(Object.entries(r.counts).map(([a, n]) => [`terragucci.plan.${a}`, n])),
        });
        if (r.error) t.span.error = r.error.split("\n")[0];
      }
      const problem = await send(tel.traces, tracesBody(this.trace.spans, resource, run.terragucci ?? "0.0.0"), fetchFn);
      if (problem) log(`telemetry: the trace was not sent: ${problem}`);
      else sent.push(`trace ${this.trace.traceId} (${this.trace.spans.length} spans)`);
    }

    if (tel.metrics) {
      const gauges = this.gauges(report, binaryVersion(run.binary, env), end);
      const problem = await send(tel.metrics, metricsBody(gauges, resource, run.terragucci ?? "0.0.0", end), fetchFn);
      if (problem) log(`telemetry: the metrics were not sent: ${problem}`);
      else sent.push(`${gauges.length} metric points`);
    }
    if (sent.length) log(`telemetry: sent ${sent.join(" and ")}`);
  }
}
