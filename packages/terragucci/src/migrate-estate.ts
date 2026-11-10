/**
 * Migrations into and between choudoufu estates: roots whose `terraform`
 * block holds a `live` block keep no state file, and ownership is a marker
 * on each live resource. A move between two estates is a retag (`live-mv
 * -from-estate`), a backend move into one an adoption (`live-import`).
 *
 * The terraform lexicon plans and writes both (`planEstateMigration`, chant
 * issue 4806): the proof is `live-mv -dry-run` of each retag or
 * `live-import`'s ratification of the old state, and after the write every
 * root plans and must show no change. terragucci initialises each root,
 * resolves its estate (choudoufu's `live-check`, else the live block's own),
 * keeps the record, writes each root's roster from its plan after the write
 * (./report/roster.ts), and sends each `-progress-json` line of the write to
 * the migration's progress (./migrate-progress.ts).
 */
import { hostname } from "node:os";
import { join } from "node:path";
import type { StateMigrationEngine } from "@intentius/chant/state-migration";
import { isEstateBinary, planEstateMigration, takesProgressJson, type EstateMigrationPlan } from "@intentius/chant-lexicon-terraform/estate-migration";
import { lastLines } from "@intentius/chant-lexicon-terraform/state";
import { ConfigError } from "./config";
import { estateOf } from "./detect";
import { readLiveSetup } from "./live-setup";
import { MIGRATE_LOCK, MIGRATION_SCHEMA, migrationDigest, placesOf, planningError, runBinary, type BinaryExec, type MigrateOptions, type Migration, type MigrationRecord, type MigrationRoot, type Place, type PlannedMigration } from "./migrate";
import { MigrationProgress } from "./migrate-progress";
import { rosterOf, type RosterFacts } from "./report/roster";
import type { Shape } from "./shape";

/** An estate migration's plan, each root's estate, and what its write holds while it runs: its progress, and when it began. */
export interface EstateRun {
  plan: EstateMigrationPlan;
  estates: Map<string, string>;
  at: { progress?: MigrationProgress; now?: string };
}

/** A root's estate: the name choudoufu resolves (choudoufu#2293) when its live-check prints one, else the live block's own. */
async function estateName(repo: string, root: string, place: Place, binary: string, exec: BinaryExec): Promise<string> {
  const setup = await readLiveSetup(place.dir, { binary, exec: (file, args, cwd) => exec(file, args, cwd, place.env).then((r) => ({ status: r.code, stdout: r.stdout, stderr: r.out })) });
  const e = setup?.estate ?? estateOf(join(repo, root)).estate;
  if (!e) throw new ConfigError(`${root} has a live block that ${setup ? "resolves no estate (several tofu-estate values, or a name outside the marker grammar)" : "names no estate"}`);
  return e;
}

/** What an estate migration's write names beyond the plans, by root: the live id of each resource it retagged or stamped, and the resource each follower moved with. */
function rosterFacts(plan: EstateMigrationPlan): Map<string, RosterFacts> {
  const byRoot = new Map<string, RosterFacts>();
  const of = (root: string): RosterFacts => byRoot.get(root) ?? byRoot.set(root, new Map()).get(root)!;
  for (const t of plan.retags) {
    of(t.to).set(t.address, { live_id: t.live_id });
    for (const f of t.followers) of(t.to).set(f, { follows: t.address });
  }
  for (const s of plan.stamps) if (s.live_id) of(s.root).set(s.address, { live_id: s.live_id });
  return byRoot;
}

/**
 * Plan a migration whose roots are choudoufu estates (every root it names
 * has a live block): a retag for `moves`, an adoption for `backends`.
 */
export async function planEstate(repo: string, m: Migration, roots: string[], options: MigrateOptions, shape: Shape): Promise<PlannedMigration> {
  const exec = options.exec ?? runBinary;
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  if (!isEstateBinary(options.binary)) throw new ConfigError(`migration ${m.name} cannot run: its roots keep their resources under live markers, which only choudoufu reads, and this job runs ${options.binary}`);
  if (m.kind === "revert") throw new ConfigError(`migration ${m.name} cannot run: an estate keeps no state file to put back; move the resources back with a moves migration the other way`);
  const places = await placesOf(repo, roots, options, env, shape);
  // choudoufu refuses `-reconfigure` under a live block: there is no backend to reconfigure.
  for (const root of roots) {
    const p = places.get(root)!;
    const init = await exec(options.binary, ["init", "-input=false", "-no-color"], p.dir, p.init?.init ?? p.env);
    if (init.code !== 0) throw new ConfigError(`init in ${root} failed: ${lastLines(init.out)}`);
  }
  // After init, as tf-check runs live-check: the estate choudoufu resolves for each root.
  const estates = new Map<string, string>();
  for (const r of roots) estates.set(r, await estateName(repo, r, places.get(r)!, options.binary, exec));
  const at: EstateRun["at"] = {};
  let plan: EstateMigrationPlan | undefined;
  try {
    plan = await planEstateMigration({
      name: m.name,
      ...(m.kind === "moves" ? { moves: m.moves } : { backends: m.backends }),
      roots: roots.map((root) => ({ root, binary: options.binary, dir: places.get(root)!.dir, env: places.get(root)!.env, estate: estates.get(root)!, init: false })),
      work: options.work,
      exec,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      lock: MIGRATE_LOCK,
      who: `terragucci@${hostname()}`,
      log,
      progress: (line) => at.progress?.take(line) ?? false,
      // The plan after the write is the estate as it stands: its roster, with the live ids the write named.
      verified: (root, json) => {
        if (options.roster && plan) options.roster(root, rosterOf(root, estates.get(root), json, at.now ?? new Date().toISOString(), rosterFacts(plan).get(root)));
      },
    });
  } catch (e) {
    throw planningError(e);
  }
  const from = new Map(m.backends.map((b) => [b.root, b.from.backend] as const));
  const out: MigrationRoot[] = plan.roots.map((r) => ({ ...r, backend: "estate", ...(r.source ? { source: { backend: from.get(r.root), ...r.source } } : {}) }));
  const record: MigrationRecord = {
    schema: MIGRATION_SCHEMA,
    name: m.name,
    file: m.file,
    file_digest: m.digest,
    change: plan.change,
    moves: m.moves,
    ...(plan.change === "retag" ? { retags: plan.retags } : { stamps: plan.stamps, backends: m.backends.map((b) => ({ root: b.root, from: out.find((r) => r.root === b.root)?.source?.location ?? b.from.backend })) }),
    roots: out,
    digest: migrationDigest(m, out),
    status: out.some((r) => r.proof.changes.length > 0) ? "proof-failed" : "planned",
  };
  for (const r of out) log(`${r.root}: ${r.proof.changes.length === 0 ? r.proof.summary : `${r.proof.changes.length} change${r.proof.changes.length === 1 ? "" : "s"} the ${plan.change === "retag" ? "retag" : "stamp"} does not account for: ${r.proof.changes.join(", ")}`}`);
  const run: EstateRun = { plan, estates, at };
  return { record, places, roots: plan.roots, engine: withProgress(repo, record, run, places, exec, options), estate: run };
}

/**
 * The lexicon's engine, with the migration's progress around its write: when
 * the binary takes `-progress-json`, each resource's line goes to
 * `terragucci-report/migrations/<name>/progress.jsonl` as its write lands,
 * and the last copy is made as the locks are released.
 */
function withProgress(repo: string, record: MigrationRecord, run: EstateRun, places: Map<string, Place>, exec: BinaryExec, options: MigrateOptions): StateMigrationEngine {
  const inner = run.plan.engine;
  const log = options.log ?? (() => {});
  return {
    current: (root) => inner.current(root),
    ...(inner.source ? { source: (root: string) => inner.source!(root) } : {}),
    verify: (root) => inner.verify(root),
    async lock() {
      const release = await inner.lock();
      return async () => {
        try {
          await run.at.progress?.stop();
        } finally {
          await release();
        }
      };
    },
    async write() {
      run.at.now = options.now ?? new Date().toISOString();
      const first = run.plan.change === "retag" ? run.plan.retags[0]?.to : record.roots[0]?.root;
      const p = first ? places.get(first) : undefined;
      if (first && p && (await takesProgressJson(exec, { root: first, binary: options.binary, dir: p.dir, env: p.env, estate: run.estates.get(first) ?? "" }))) {
        const progress: MigrationProgress = new MigrationProgress({
          repo,
          name: record.name,
          change: run.plan.change,
          total: run.plan.resources,
          record: () => ({ ...record, progress: progress.progress }),
          ...(options.env ? { env: options.env } : {}),
          ...(options.progress?.publish ? { publish: options.progress.publish } : {}),
          ...(options.progress?.event ? { event: options.progress.event } : {}),
          log,
        });
        run.at.progress = progress;
        log(`migration ${record.name}: each resource's write goes to terragucci-report/migrations/${record.name}/progress.jsonl as it lands`);
      }
      await inner.write();
    },
  };
}
