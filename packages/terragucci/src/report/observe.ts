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
import { METRIC } from "../dashboards/names";
import { pinVersion } from "../rollout/pins";
import type { Report } from "./schema";
import { drifted } from "./drift";
import { waveGauges, waveResult, type WaveFacts } from "./wave-telemetry";
import { rootTimings, runTimings, SpanReceiver } from "./spans";

/** One module call's pin in a root, as the Estate and Rollouts dashboards count them. */
export interface ModulePin {
  root: string;
  module: string;
  version: string;
}

/**
 * The pinned module calls of each root, from its plan's configuration: a
 * registry module's version, or a git or OCI source's ref or tag. A local
 * module (`./modules/x`) has no pin and is left out.
 */
export function modulePins(roots: { path: string; plan?: unknown }[]): ModulePin[] {
  const out: ModulePin[] = [];
  for (const r of roots) {
    const calls = ((r.plan as { configuration?: { root_module?: { module_calls?: Record<string, { source?: string; version_constraint?: string }> } } } | undefined)
      ?.configuration?.root_module?.module_calls) ?? {};
    for (const call of Object.values(calls)) {
      const source = call.source ?? "";
      if (!source || source.startsWith(".") || source.startsWith("/")) continue;
      const [base, query = ""] = source.split("?");
      const ref = new URLSearchParams(query).get("ref") ?? new URLSearchParams(query).get("tag");
      const version = ref ? pinVersion(ref) : call.version_constraint;
      if (!version) continue;
      out.push({ root: r.path, module: base.replace(/^git::/, "").replace(/\.git(\/\/|$)/, "$1"), version });
    }
  }
  return out;
}

/** What a drift run found, beyond its report: when its drift was first found. */
export interface DriftFacts {
  /** When the open drift issue was opened, or when this run found drift with no issue to read. */
  since?: string;
}

interface RootTiming {
  path: string;
  start: bigint;
  end?: bigint;
  span?: Span;
  /** Each run of the binary in the root, in seconds. */
  commands: { command: string; seconds: number }[];
  /** Time between `endRoot` and `reopen`, which the root's seconds leave out. */
  idle: bigint;
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
  /** Terragrunt units' times from its run report, by unit, in seconds. */
  private readonly units = new Map<string, number>();
  /** Set by the stage before `finish`: the module pins its plans read. */
  pins: ModulePin[] = [];
  /** Set by a drift stage before `finish`. */
  drift?: DriftFacts;
  /** Set by the stage before `finish` when the report has an address (reports.url): the stage span carries it, so a trace links its report. */
  reportUrl?: string;
  /** Set by a tf-apply wave: its number, what it found out, and its exit code once it has one. */
  wave?: { number: number; facts: WaveFacts; code?: number };

  /** The pull request a tf-plan runs for (`TG_PR`, which the pipeline sets). */
  private readonly pullRequest?: string;

  constructor(readonly telemetry: Telemetry | undefined, readonly stage: string, env: NodeJS.ProcessEnv) {
    const pr = env.TG_PR?.trim();
    if (pr) this.pullRequest = pr;
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
    const t: RootTiming = { path, start: nowNanos(), commands: [], idle: 0n };
    if (this.trace) t.span = this.trace.start(`root ${path}`, this.stageSpan, { "terragucci.root": path });
    this.roots.push(t);
    return t;
  }

  endRoot(t: RootTiming): void {
    t.end = nowNanos();
    if (t.span) t.span.end = t.end;
  }

  /**
   * Time a root again after `endRoot`: a tf-apply wave plans every root,
   * decides its gate, then applies. The gap is left out of the root's seconds.
   */
  reopen(t: RootTiming): void {
    if (t.end === undefined) return;
    t.idle += nowNanos() - t.end;
    t.end = undefined;
  }

  /** A Terragrunt unit's time, from Terragrunt's run report: Terragrunt runs the binary, not terragucci. */
  unitTimed(path: string, secs: number): void {
    if (Number.isFinite(secs) && secs >= 0) this.units.set(path, secs);
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
   * the report. `commands` names the runs of the binary whose spans count:
   * the plan, and on a tf-apply wave the apply too. A Terragrunt unit gets
   * its time from Terragrunt's run report, with no per-resource timings; a
   * unit the report does not time gets none, and the run says why.
   */
  addTimings(report: Report, commands: readonly string[] = ["plan"]): void {
    const binary = report.run.binary.split("/").pop() || report.run.binary;
    for (const r of report.roots) {
      const t = this.roots.find((x) => x.path === r.path);
      if (!t || t.end === undefined) {
        const unit = this.units.get(r.path);
        if (unit !== undefined) r.timings = rootTimings([], { binary, seconds: unit, planSeconds: unit, source: "terragrunt" });
        continue;
      }
      const ran = (c: string) => t.commands.filter((x) => x.command === c).reduce<number | undefined>((n, x) => (n ?? 0) + x.seconds, undefined);
      const plan = ran("plan");
      const apply = commands.includes("apply") ? ran("apply") : undefined;
      r.timings = rootTimings(commands.flatMap((c) => this.receiver?.spansOf(t.path, c) ?? []), {
        binary,
        seconds: seconds(t.start, t.end) - Number(t.idle) / 1e9,
        ...(plan !== undefined ? { planSeconds: plan } : {}),
        ...(apply !== undefined ? { applySeconds: apply } : {}),
      });
    }
    const untimed = report.roots.length > 0 && report.roots.every((r) => r.timings === undefined);
    report.timings = runTimings(report.roots, untimed ? "Terragrunt ran the binary for these units and its run report gave no times, so the report has no per-unit timings" : undefined);
  }

  /** The metrics a finished report gives. */
  gauges(report: Report, version: string | undefined, end: bigint): Gauge[] {
    const project = report.run.project;
    const stage = this.stage;
    const result = report.roots.some((r) => r.status === "failed") ? "failure" : "success";
    // A pull request's plan names it, so Change review can show roots per pull request.
    const pr = stage === "tf-plan" && this.pullRequest ? { pull_request: this.pullRequest } : {};
    const g = (name: string, unit: string, description: string, value: number, attributes: Record<string, string>): Gauge => ({ name, unit, description, value, attributes: { project, stage, ...pr, ...attributes } });
    const out: Gauge[] = [
      g("terragucci_stage_duration_seconds", "s", "How long the stage ran", seconds(this.start, end), { result }),
      g("terragucci_roots_planned", "{root}", "Roots the stage planned, failed ones included", report.roots.length, {}),
      g("terragucci_plan_groups", "{group}", "Groups the plans fold into", report.groups.length, {}),
    ];
    for (const t of this.roots) {
      if (t.end !== undefined) out.push(g(METRIC.rootPlan, "s", "How long one root took to plan", seconds(t.start, t.end), { root: t.path }));
    }
    for (const [action, n] of Object.entries(report.totals)) {
      out.push(g("terragucci_plan_changes", "{change}", "Proposed changes by action", n, { action }));
    }
    if (version) out.push(g("terragucci_binary_version", "", "The binary and version a stage ran", 1, { binary: report.run.binary, version }));
    return [...out, ...this.dashboardGauges(report, end, g)];
  }

  /**
   * The metrics a tf-apply wave sends: how long each root's apply took, and
   * the wave's own gauges (report/wave-telemetry.ts), which the Rollouts and
   * waves dashboard and the waiting-wave alert read.
   */
  applyGauges(report: Report, end: bigint): Gauge[] {
    const project = report.run.project;
    const stage = this.stage;
    const g = (name: string, unit: string, description: string, value: number, attributes: Record<string, string>): Gauge => ({ name, unit, description, value, attributes: { project, stage, ...attributes } });
    const wave: Record<string, string> = this.wave ? { wave: String(this.wave.number) } : {};
    const out: Gauge[] = [];
    for (const r of report.roots) {
      const seconds = r.timings?.apply_seconds;
      if (seconds === undefined) continue;
      out.push(g(METRIC.rootApply, "s", "How long one root took to apply", seconds, { ...wave, root: r.path }));
    }
    out.push(...this.initAndLockGauges(report, g));
    if (this.wave) out.push(...waveGauges(this.wave.number, this.wave.code ?? 1, this.wave.facts, Number(end / 1_000_000n) / 1000, g));
    return out;
  }

  /** Provider start-up and state lock waits per root, which a plan stage and a tf-apply wave both send. */
  private initAndLockGauges(report: Report, g: (name: string, unit: string, description: string, value: number, attributes: Record<string, string>) => Gauge): Gauge[] {
    const out: Gauge[] = [];
    for (const r of report.roots) {
      for (const p of r.timings?.provider_init ?? []) out.push(g(METRIC.providerInit, "s", "Time spent starting a provider in a root", p.ms / 1000, { root: r.path, provider: p.provider }));
      const wait = (r.timings?.lock_waits ?? []).reduce((n, w) => n + w.ms, 0);
      if (r.timings?.lock_waits?.length) out.push(g(METRIC.lockWait, "s", "Time spent waiting for a state lock in a root", wait / 1000, { root: r.path }));
    }
    return out;
  }

  /** The gauges the dashboards read beyond the plan counts (dashboards/names.ts). */
  private dashboardGauges(report: Report, end: bigint, g: (name: string, unit: string, description: string, value: number, attributes: Record<string, string>) => Gauge): Gauge[] {
    const at = Number(end / 1_000_000n) / 1000;
    const out: Gauge[] = [
      g(METRIC.lastRun, "s", "When the stage last ran, in Unix seconds", at, {}),
      g(METRIC.rootsChanged, "{root}", "Roots whose plan changes something", report.roots.filter((r) => r.status === "planned" && r.changes.length > 0).length, {}),
    ];
    if (report.tips) {
      const byRule = new Map<string, number>();
      for (const t of report.tips) byRule.set(t.rule, (byRule.get(t.rule) ?? 0) + 1);
      for (const [rule, n] of byRule) out.push(g(METRIC.tips, "{tip}", "Tips the run gave, by rule", n, { rule }));
    }
    for (const p of this.pins) out.push(g(METRIC.modulePin, "", "A module call's pin in a root", 1, { root: p.root, module: p.module, version: p.version }));
    out.push(...this.initAndLockGauges(report, g));
    for (const x of report.timings?.resources ?? []) out.push(g(METRIC.resource, "s", "How long one of the run's slowest resources took", x.ms / 1000, { root: x.root, address: x.address }));
    if (report.run.stage === "tf-drift") {
      const d = drifted(report);
      out.push(g(METRIC.driftRoots, "{root}", "Roots the drift run found drifted", d.roots, {}));
      if (d.roots > 0) out.push(g(METRIC.driftSince, "s", "When the open drift was first found, in Unix seconds", Date.parse(this.drift?.since ?? report.run.finished) / 1000, {}));
      else if (d.failed === 0) out.push(g(METRIC.driftClear, "s", "When a drift run last found no drift, in Unix seconds", at, {}));
    }
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
    // The metrics carry nothing that changes from run to run, so a project's gauge is one series and the
    // dashboards' latest value is the latest run's, not the largest of any commit's. The trace names the run.
    const metricsResource = { ...tel.resource, "service.version": run.terragucci, "terragucci.project": run.project };
    const resource = {
      ...metricsResource,
      "vcs.ref.head.revision": run.commit,
      ...(run.job_url ? { "cicd.pipeline.run.url.full": run.job_url } : {}),
    };
    const sent: string[] = [];

    if (tel.traces && this.trace && this.stageSpan) {
      const failed = report.roots.filter((r) => r.status === "failed").length;
      const result = this.wave ? waveResult(this.wave.code ?? 1, this.wave.facts) : failed ? "failure" : "success";
      this.trace.end(this.stageSpan, {
        "terragucci.project": run.project,
        "vcs.ref.head.revision": run.commit,
        "terragucci.binary": run.binary,
        "terragucci.runtime": run.runtime,
        "terragucci.change_set": report.change_set,
        "terragucci.roots": report.roots.length,
        "terragucci.roots_failed": failed,
        // How the stage or the wave ended, a dimension of the span metrics the dashboards read.
        "terragucci.result": result,
        ...(this.wave ? { "terragucci.wave": this.wave.number } : {}),
        ...(this.reportUrl ? { "terragucci.report.url": this.reportUrl } : {}),
        ...(run.job_url ? { "cicd.pipeline.run.url.full": run.job_url } : {}),
        ...Object.fromEntries(Object.entries(report.totals).map(([a, n]) => [`terragucci.plan.${a}`, n])),
      }, failed ? `${failed} root(s) failed` : result === "failed" ? `wave ${this.wave?.number} failed` : undefined);
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

    // A tf-apply wave sends its trace, each root's apply time and its wave gauges. The plan's other metrics stay the plan's, since a wave's would count its roots twice.
    if (tel.metrics) {
      const gauges = this.stage === "tf-apply" ? this.applyGauges(report, end) : this.gauges(report, binaryVersion(run.binary, env), end);
      const problem = await send(tel.metrics, metricsBody(gauges, metricsResource, run.terragucci ?? "0.0.0", end), fetchFn);
      if (problem) log(`telemetry: the metrics were not sent: ${problem}`);
      else sent.push(`${gauges.length} metric points`);
    }
    if (sent.length) log(`telemetry: sent ${sent.join(" and ")}`);
  }
}
