/**
 * `terragucci waves-spec`: the `tf-apply` spec at one commit, for chant's
 * Op waves jobs (`renderSpec`, chant issue 4982).
 *
 * chant runs it with `CHANT_WAVES_SPEC_AT` set to a commit (the wave's base,
 * or a newer commit on the branch for the stand-down) and reads the spec from
 * what it prints. It is the spec the job runs and the gate policy, so every
 * rule comes from that commit: the shape is the spec file committed there
 * (the pipeline's waves, their runs, shares, job groups and step, which
 * `terragucci init` writes beside the pipeline), and the rules are
 * terragucci.yml there: each wave's gate (the top-level gate and, with
 * `environments`, the strictest of its roots'), the approval mode, who
 * counts at the gate, `apply.point`, `apply.branches`, `apply.resume` and
 * `notify`. A commit with no committed spec prints nothing.
 *
 * Two things are not rules and come from the job's checkout, as they did in
 * `stage tf-apply`: each root's workspace and its Atmos reads (the run's
 * `input`). Wave 1 always carries the state migration hooks; they look for
 * migrations in the checkout and do nothing when there are none, since a
 * migration comes with the change and the spec is read at base.
 *
 * The job's own render at the applied commit (chant's `renderSpec:
 * { runsAtHead: true }`, chant issue 5046) also gets `CHANT_WAVES_SPEC_BASE`,
 * the base commit. With it the runs are what the change base..AT reaches,
 * as `stage tf-apply` works them out: with `waves.compose` on, the roots it
 * reaches run as one composed run in the earliest wave they are in
 * (`together`), and a root a pending estate migration plans is left out of
 * its wave until the migration applies. The rules still come from chant's
 * render at base, which gets no such variable.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { OpWave, OpWaveHook, OpWavesSpec } from "@intentius/chant/op";
import type { GateQuorumRule } from "@intentius/chant/gate-decision";
import { atmosStateReads as terraformAtmosReads } from "@intentius/chant-lexicon-terraform/state-reads";
import { approvalRule } from "./approval";
import { atmosEdges } from "./atmos";
import { WAVES_APPROVALS, WAVES_OP, WAVES_SPEC, waveCallArgv, wavesSpecText } from "./chant-waves";
import { isComposeTarget, stepWavesWithRun, type Composition } from "./compose";
import type { WaveMember } from "@intentius/chant/gated-waves";
import { ConfigError, LEDGER_PROVES_NOBODY, normalizeGate, resolveRepo, type Gate } from "./config";
import { anyRootGate, strictestGate, topGate, waveGate as rootsGate } from "./environments";
import type { Fetch } from "./forge";
import { AGENT_NOT_EXCLUDED, tokenUsers } from "./involved";
import { resumeCron } from "./render";
import { configAtBase } from "./report/policy";
import { forgeOfEnv, rootsParallelism } from "./report/stage";
import { branchLayers, changeComposition, migrationRunsOut, stepComposition } from "./apply";
import { rootWorkspace } from "./workspace";

/** The variables chant hands the command (chant's `OP_WAVES_SPEC_AT_ENV` and `OP_WAVES_SPEC_FILE_ENV`). */
export const SPEC_AT_ENV = "CHANT_WAVES_SPEC_AT";
export const SPEC_FILE_ENV = "CHANT_WAVES_SPEC_FILE";
/** chant's `OP_WAVES_SPEC_BASE_ENV` (chant issue 5046): set only in the job's own render at the applied commit, to the base commit. */
export const SPEC_BASE_ENV = "CHANT_WAVES_SPEC_BASE";
/** chant's `OP_WAVES_SPEC_RUNS_ENV`: `head` on a job whose spec's runs come from the applied commit. */
export const SPEC_RUNS_ENV = "CHANT_WAVES_SPEC_RUNS";

export interface WavesSpecAtOptions {
  /** The commit to read the spec at. */
  at: string;
  /** The base commit of the change `at` applies (`CHANT_WAVES_SPEC_BASE`): the runs are then what the change reaches. */
  base?: string;
  /** The spec file's path in the repo. Default: `.chant/op-waves/tf-apply.spec.json`. */
  specFile?: string;
  /** The config file, as `--config` names it. */
  config?: string;
  env?: NodeJS.ProcessEnv;
  /** The forge call that finds the agent's login from `agent.token_env`. Tests pass one. */
  fetch?: Fetch;
  log?: (line: string) => void;
}

const git = (repo: string, args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf-8" });

/** The branch the job runs on, as the forge names it; undefined when the job's variables name none. */
function jobBranch(env: NodeJS.ProcessEnv): string | undefined {
  const name = env.CI_COMMIT_BRANCH || env.GITHUB_REF_NAME || (env.GITHUB_REF?.startsWith("refs/heads/") ? env.GITHUB_REF.slice("refs/heads/".length) : undefined);
  return name || undefined;
}

/**
 * The spec at `o.at`, or undefined when that commit has no committed spec.
 * Throws a ConfigError when the commit is not in the checkout or its config
 * cannot be read, so the job fails rather than run without its rules.
 */
export async function wavesSpecAt(repo: string, o: WavesSpecAtOptions): Promise<OpWavesSpec | undefined> {
  return (await wavesSpecReach(repo, o))?.spec;
}

/** The spec at `o.at` and, with `o.base`, what the change reaches, which a `terragucci run wave` job hands its wave (runWaveJob). */
export interface WavesSpecReach {
  spec: OpWavesSpec;
  /** `waves.compose`: the composed run the change comes to, when it composes. */
  composition?: Composition;
  /** By wave number: the roots a pending estate migration plans, as the digest members that stand for them. */
  migrationMembers: Map<number, WaveMember[]>;
  /** The waves with nothing of their own to apply: every root is in an earlier wave's composed run, or planned by a migration. */
  nothing: Map<number, string>;
}

/** {@link wavesSpecAt}, with what the change reaches. */
export async function wavesSpecReach(repo: string, o: WavesSpecAtOptions): Promise<WavesSpecReach | undefined> {
  const env = o.env ?? process.env;
  const log = o.log ?? ((l: string) => console.error(l));
  const file = (o.specFile ?? WAVES_SPEC).replace(/^\.\//, "");
  const sha = git(repo, ["rev-parse", "--verify", "--quiet", `${o.at}^{commit}`]).stdout.trim();
  if (!sha) throw new ConfigError(`the waves' spec is read at ${o.at}, which this checkout does not have`);
  const shown = git(repo, ["show", `${sha}:${file}`]);
  if (shown.status !== 0) return undefined;
  let shape: OpWavesSpec;
  try {
    shape = JSON.parse(shown.stdout) as OpWavesSpec;
  } catch (e) {
    throw new ConfigError(`${file} at ${sha.slice(0, 12)} is not JSON (${(e as Error).message})`);
  }
  if (!Array.isArray(shape?.waves)) throw new ConfigError(`${file} at ${sha.slice(0, 12)} lists no waves`);
  const read = await configAtBase(repo, sha, o.config ? { config: o.config } : {});
  if ("error" in read) throw new ConfigError(`the waves' rules are read from the config at ${sha.slice(0, 12)}, and it could not be read (${read.error})`);
  const config = read.config;
  const settings = resolveRepo(config);
  const rule = await approvalRule(repo, { at: sha, ...(o.config ? { config: o.config } : {}) });
  if (rule.point && rule.mode !== "ledger") throw new ConfigError(`apply.point is set at base and approval is ${rule.mode}; a wave gate that asks a decision point takes its quorum from the point, so set approval to ledger or drop apply.point`);
  if (rule.point && rule.approvalRules) throw new ConfigError("apply.point and approval_rules are both set at base; a wave gate that asks a decision point takes its deciders and quorum from the point, so drop one of them");
  if (rule.mode === "ledger" && rule.approvalRules?.some((r) => r.roles?.length || r.notAuthor)) throw new ConfigError(`approval_rules at base names roles or not_author, and approval is ledger (${rule.source}): ${LEDGER_PROVES_NOBODY}`);
  // allow_unattended at base: chant's gate is never, and terragucci's after-plan hook holds a wave its gate would hold.
  const unattended = rule.policyOutcomes?.includes("allow_unattended") === true;

  // apply.branches: the runs this branch applies, cut as stage tf-apply cut its layers.
  const routes = settings.apply?.branches && Object.keys(settings.apply.branches).length > 0 ? settings.apply.branches : undefined;
  let layers = shape.waves.map((w) => (w.runs ?? []).map((r) => r.target));
  if (routes && !shape.waves.some((w) => w.discover)) {
    const branch = jobBranch(env);
    const cut = branchLayers(layers, routes, branch !== undefined && Object.hasOwn(routes, branch) ? branch : undefined);
    log(`terragucci waves-spec: ${cut.note}`);
    layers = cut.layers;
  }

  // CHANT_WAVES_SPEC_BASE (chant issue 5046): the job's own render at the applied commit, whose runs are what the change base..at reaches.
  let composition: Composition | undefined;
  let together: number | undefined;
  const migrationMembers = new Map<number, WaveMember[]>();
  const nothing = new Map<number, string>();
  if (o.base && !shape.waves.some((w) => w.discover)) {
    if (settings.waves?.compose === true) {
      // One apply job per identity: a composed run takes roots of one group only.
      const groups: Record<string, string[]> = {};
      for (const g of shape.waves.flatMap((w) => w.jobs ?? [])) groups[g.name] = [...(groups[g.name] ?? []), ...(g.runs ?? [])];
      composition = await changeComposition(repo, { layers, base: o.base, ...(o.config ? { config: o.config } : {}), env, ...(Object.keys(groups).length ? { groups } : {}) });
      const c = stepComposition(composition);
      if (c) {
        layers.forEach((roots, i) => {
          if (i + 1 !== c.wave && roots.length > 0 && roots.every((r) => c.roots.includes(r))) nothing.set(i + 1, `its roots apply in the composed run in wave ${c.wave}`);
        });
        layers = stepWavesWithRun(layers, c);
        together = c.wave;
      }
    }
    const out = migrationRunsOut(repo, layers, new Set(), log);
    layers = out.listed;
    for (const [k, members] of out.members) migrationMembers.set(k, members);
    for (const k of out.emptied) if (!nothing.has(k)) nothing.set(k, "every root in it is planned by its estate migration");
  }

  // The agent's account never approves. With agent.token_env and no agent.login, its login is the one its token acts as.
  let agent = rule.agentLogin;
  if (!agent && rule.agentTokenEnv) {
    const users = await tokenUsers({ forge: forgeOfEnv(env), env, ...(o.fetch ? { fetch: o.fetch } : {}), agentTokenEnv: rule.agentTokenEnv });
    agent = users.find((u) => u.which.startsWith("the agent's token") && u.login)?.login;
    if (!agent) log(`terragucci waves-spec: ${AGENT_NOT_EXCLUDED}`);
  }
  const quorum: GateQuorumRule[] | undefined = rule.approvalRules?.length && !rule.point ? rule.approvalRules : undefined;
  // chant's spend rules (chant issue 5047), with who counts at the gate.
  const approvals = rule.point ? { ...WAVES_APPROVALS } : { ...WAVES_APPROVALS, reviewLedger: WAVES_OP, involved: { ...(agent ? { agents: [agent] } : {}), exclude: true as const }, ...(quorum ? { quorum } : {}) };

  const all = layers.flat().filter((r) => !isComposeTarget(r));
  const workspaces = Object.fromEntries(all.flatMap((r) => { const w = rootWorkspace(join(repo, r)); return w ? [[r, w]] : []; }));
  const reads = Object.fromEntries(all.flatMap((r) => {
    const list = terraformAtmosReads(atmosEdges(join(repo, r)), (u) => u, (u) => { const w = rootWorkspace(join(repo, u)); return { dir: u, ...(w ? { workspace: w } : {}) }; });
    return list.length ? [[r, list]] : [];
  }));
  const runInput = (root: string): Record<string, unknown> | undefined => {
    const i = { ...(reads[root]?.length ? { reads: reads[root] } : {}), ...(workspaces[root] ? { workspace: workspaces[root] } : {}) };
    return Object.keys(i).length ? i : undefined;
  };

  const hook = (name: string, what: "migrate-check" | "migrate" | "gate", onFailure?: "approve"): OpWaveHook => ({ name, command: waveCallArgv(what, "{runs}"), ...(onFailure ? { onFailure } : {}) });
  const terragrunt = (shape.step as { kind?: string } | undefined)?.kind === "terragrunt-apply";
  const waves: OpWave[] = shape.waves.map((w, i) => {
    // The stricter of the pipeline's gate and the top-level gate at this commit; with environments, the strictest of the wave's roots'.
    const top = strictestGate([normalizeGate(w.gate) ?? "on-destructive", topGate(config)]);
    const gate: Gate = unattended ? "never" : w.discover ? anyRootGate(config, top) : rootsGate(layers[i] ?? [], config, top);
    const runs = w.discover ? (w.runs ?? []) : (layers[i] ?? []).map((target) => { const input = runInput(target); return { target, ...(input ? { input } : {}) }; });
    const { hooks: _hooks, approval: _approval, ...rest } = w as OpWave & { approval?: unknown };
    return {
      ...rest,
      runs,
      gate,
      approval: rule.mode === "sealed" ? "sealed" : rule.mode === "pr-review" ? "pr-review" : "ledger",
      // The composed run's roots plan and apply together (chant#4848).
      ...(together === i + 1 ? { together: true } : {}),
      ...(i === 0 ? { hooks: { before: { plan: [hook("migrations", "migrate-check"), hook("migration gate", "migrate", "approve")] } } } : {}),
    } as OpWave;
  });
  const parallel = terragrunt ? undefined : rootsParallelism(repo, all, settings, env);
  const notify = settings.notify;
  const { point: _point, parallelism: _parallelism, branches: _branches, resume: _resume, notify: _notify, ...top } = shape as OpWavesSpec & { parallelism?: number };
  const spec = {
    ...top,
    name: WAVES_OP,
    op: WAVES_OP,
    gateName: "wave-{k}",
    approvals,
    ...(rule.point ? { point: { name: rule.point, store: "ledger", timeout: "48h" } } : {}),
    ...(parallel && parallel.value > 1 && !waves.some((w) => (w as { together?: boolean }).together) ? { parallelism: parallel.value } : {}),
    // chant reads the default branch by its run-time name (chant issue 5032); apply.branches names more.
    defaultBranch: true,
    ...(routes ? { branches: Object.keys(routes) } : {}),
    standDown: true,
    ...(settings.apply?.resume ? { resume: { schedule: resumeCron(settings.apply.resume) } } : {}),
    ...(notify
      ? {
          notify: {
            // notify's keys name the secrets (GitHub, Forgejo) or CI/CD variables (GitLab) as they are.
            ...(notify.slack ? { slack: notify.slack } : {}),
            ...(notify.teams ? { teams: notify.teams } : {}),
            ...(notify.webhook ? { webhook: notify.webhook, ...(notify.webhook_key ? { key: notify.webhook_key } : {}) } : {}),
            ...(notify.relay_key ? { relay: notify.relay_key } : {}),
            ...(notify.relay ? { relayName: notify.relay } : {}),
          },
        }
      : {}),
    hooks: { after: { gate: [hook("report", "gate")] } },
    waves,
  } as OpWavesSpec;
  return { spec, ...(composition ? { composition } : {}), migrationMembers, nothing };
}

/**
 * `terragucci waves-spec`: print the spec at `CHANT_WAVES_SPEC_AT` (or
 * `--at`, default HEAD), or nothing. With `CHANT_WAVES_SPEC_BASE` the runs
 * are what the change from that commit reaches. stdout
 * carries the spec alone: every line the render logs goes to stderr.
 */
export async function printWavesSpec(repo: string, o: { at?: string; base?: string; specFile?: string; config?: string; env?: NodeJS.ProcessEnv; fetch?: Fetch; out?: (text: string) => void }): Promise<number> {
  const env = o.env ?? process.env;
  const at = o.at ?? env[SPEC_AT_ENV] ?? "HEAD";
  const base = o.base ?? (env[SPEC_BASE_ENV] || undefined);
  const specFile = o.specFile ?? env[SPEC_FILE_ENV] ?? WAVES_SPEC;
  const said = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  let spec: OpWavesSpec | undefined;
  try {
    spec = await wavesSpecAt(repo, { at, specFile, ...(base ? { base } : {}), ...(o.config ? { config: o.config } : {}), env, ...(o.fetch ? { fetch: o.fetch } : {}) });
  } finally {
    console.log = said;
  }
  if (spec) (o.out ?? ((t: string) => process.stdout.write(t)))(wavesSpecText(spec));
  else console.error(`terragucci waves-spec: ${specFile} is not committed at ${at}, so there is no spec there`);
  return 0;
}
