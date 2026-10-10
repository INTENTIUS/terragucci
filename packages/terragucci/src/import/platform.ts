/**
 * What `import spacelift` and `import env0` share once each has read its
 * files: a unit (a stack, an environment) per root, and the settings the
 * units carry gathered into terragucci.yml by the guide's concepts table
 * (./spacelift-env0-guide.ts). The readers (./spacelift.ts, ./env0.ts) say what
 * each unit has; `finish` decides what one repo-wide key can hold.
 */
import { PASS_RESERVED, PASS_RESERVED_PREFIXES, PR_APPLY_NEEDS_ON_GITLAB, RELEASE_VERSION, type ApplyWhen, type Binary, type ForgeName, type ProjectSettings, type StepSettings } from "../config";
import { Notes, wavesAfterOf, type ImportNote } from "./notes";
import { noteConcept, type SpaceliftEnv0Row } from "./spacelift-env0-guide";
import type { RepoShape } from "./terrateam";

export interface PlatformOptions {
  forge?: ForgeName;
  applyWhen?: ApplyWhen;
  repo?: RepoShape;
}

export interface PlatformConverted {
  settings: ProjectSettings;
  notes: ImportNote[];
  /** Roots written that match no directory with Terraform files; undefined lets the caller look. */
  missing?: string[];
  /** The files read, relative to the repo. */
  read: string[];
}

/** A stack or an environment. */
export interface Unit {
  /** Its name on the platform. */
  id: string;
  /** Where it is set, as a note's key. */
  key: string;
  /** Its root; undefined when the files do not say. */
  root?: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class Build {
  readonly notes = new Notes();
  readonly s: ProjectSettings = {};
  readonly units: Unit[] = [];
  readonly steps: StepSettings[] = [];
  /** A version per root, with the key that set it. */
  readonly versions = new Map<string, { version: string; key: string }>();
  readonly binaries = new Map<Binary, string[]>();
  readonly env = new Map<string, { value: string; key: string }>();
  readonly envConflicts = new Set<string>();
  readonly secrets = new Map<string, string[]>();
  /** Each unit's approval setting: whether a change waits for a person. */
  readonly approvals: { key: string; waits: boolean }[] = [];
  readonly drift: { cron: string; key: string; unit: string }[] = [];
  /** dependent root, upstream root, the key that named it. */
  readonly edges: { d: string; u: string; key: string }[] = [];
  readonly ephemeral: { root: string; key: string }[] = [];
  ttl?: { value: string; key: string };
  constructor(readonly platform: string) {}

  note(kind: "mapped" | "default" | "unmapped", key: string, row: SpaceliftEnv0Row, detail?: string): void {
    noteConcept(this.notes, kind, key, row, detail);
  }

  /** A release for one root; anything else leaves the root's own pin to decide. */
  version(root: string | undefined, v: unknown, key: string): void {
    if (v === undefined) return;
    const clean = String(v).trim().replace(/^v/, "");
    if (!RELEASE_VERSION.test(clean)) return this.note("default", key, "Version", `${JSON.stringify(v)} is not one release, so the root's required_version pin decides`);
    if (root === undefined) return this.note("unmapped", key, "Version", "the import cannot tell which root it is for");
    const had = this.versions.get(root);
    if (had && had.version !== clean) return this.note("unmapped", key, "Version", `${root} runs ${had.version} by ${had.key}`);
    if (!had) this.versions.set(root, { version: clean, key });
  }

  binary(b: Binary, key: string): void {
    this.binaries.set(b, [...(this.binaries.get(b) ?? []), key]);
  }

  /** A fixed value every root gets. */
  takeEnv(key: string, name: string, value: string): void {
    if (!NAME.test(name)) return this.note("unmapped", key, "Variables", `${JSON.stringify(name)} is not a variable name`);
    const had = this.env.get(name);
    if (had && had.value !== value) {
      this.envConflicts.add(name);
      return this.note("unmapped", key, "Variables", `${name} is set to two values (in ${had.key} too), and \`env\` holds one`);
    }
    if (!had) this.env.set(name, { value, key });
  }

  /** A secret's name, for the CI secret to create. */
  takeSecret(key: string, name: string): void {
    if (!NAME.test(name)) return this.note("unmapped", key, "Variables", `${JSON.stringify(name)} is not a variable name`);
    if (PASS_RESERVED_PREFIXES.some((p) => name.toUpperCase().startsWith(p)) || PASS_RESERVED.includes(name)) {
      return this.note("unmapped", key, "Variables", `${name} is a name the forge refuses for a secret or terragucci sets itself; pass it under another name`);
    }
    this.secrets.set(name, [...(this.secrets.get(name) ?? []), key]);
  }

  /** A hook's commands as one step's script: one command as it is, several stopping at the first that fails. */
  static script(lines: string[]): string {
    return lines.length === 1 ? lines[0] : ["set -e", ...lines].join("\n");
  }
}

/** The roots, binary, version, order, approval, drift, ephemeral, env, secrets and steps, once every file is read. */
export function finish(b: Build, o: PlatformOptions, units: string): void {
  const { notes, s } = b;

  // Roots: one per unit, written when every unit has one.
  const byRoot = new Map<string, Unit[]>();
  for (const u of b.units) if (u.root !== undefined) byRoot.set(u.root, [...(byRoot.get(u.root) ?? []), u]);
  const unplaced = b.units.filter((u) => u.root === undefined);
  if (byRoot.size && !unplaced.length) {
    s.roots = [...byRoot.keys()].sort();
    b.note("mapped", units, "Root", `roots: ${s.roots.join(", ")}`);
  } else if (byRoot.size) {
    b.note("unmapped", units, "Root", `no roots written, so terragucci detects them: ${unplaced.map((u) => u.id).join(", ")} ${unplaced.length === 1 ? "has" : "have"} no directory the files name`);
  }
  for (const [root, us] of byRoot) {
    if (us.length > 1) b.note("unmapped", us.map((u) => u.key).join(", "), "Shared code", `${us.map((u) => u.id).join(", ")} all run ${root}, which is one root with one state; give each a directory`);
  }

  // Binary and version.
  const bins = [...b.binaries.keys()];
  if (bins.length === 1) {
    s.binary = bins[0];
    b.note("mapped", b.binaries.get(bins[0])![0], "Version", `binary: ${bins[0]}`);
  } else if (bins.length > 1) {
    b.note("unmapped", [...b.binaries.values()].flat().join(", "), "Version", `the ${b.platform} config runs ${bins.join(" and ")}, and the pipeline runs one binary`);
  }
  const releases = new Set([...b.versions.values()].map((v) => v.version));
  if (releases.size === 1) {
    const [v] = releases;
    s.version = v;
    for (const x of b.versions.values()) b.note("mapped", x.key, "Version", `version: ${v}`);
  } else if (releases.size > 1) {
    s.version = Object.fromEntries([...b.versions].sort(([a], [c]) => a.localeCompare(c)).map(([root, x]) => [root, x.version]));
    for (const [root, x] of b.versions) b.note("mapped", x.key, "Version", `version: ${root}: ${x.version}`);
  }

  // Order.
  if (b.edges.length) {
    const { after, fromReads, cycle } = wavesAfterOf(b.edges.map((e) => [e.d, e.u] as const), o.repo?.reads);
    if (Object.keys(after).length && !cycle) s.waves = { ...s.waves, after };
    for (const e of b.edges) {
      const what = `${e.d} after ${e.u}`;
      if (e.d === e.u) b.note("unmapped", e.key, "Order", `both stacks run ${e.d}`);
      else if (fromReads.has(`${e.d}\0${e.u}`)) b.note("default", e.key, "Order", `the terraform_remote_state reads already order ${what}`);
      else if (cycle) b.note("unmapped", e.key, "Order", `${what} is not kept: with the terraform_remote_state reads it makes a cycle, ${cycle.join(" after ")}`);
      else b.note("mapped", e.key, "Order", `waves.after: ${what}`);
    }
  }

  // When it applies: both platforms apply the tracked branch after a push, as merge does.
  const timing = `${b.platform} applies the branch a ${units === "stacks" ? "stack" : "environment"} tracks after a push, terragucci the default branch after a merge`;
  if (o.applyWhen === "pull-request" && o.forge === "gitlab") {
    notes.own("when it applies", "unmapped", timing, `left at apply.when: merge: ${PR_APPLY_NEEDS_ON_GITLAB.comments}; and ${PR_APPLY_NEEDS_ON_GITLAB.token}`);
  } else if (o.applyWhen === "pull-request") {
    s.apply = { when: "pull-request" };
    notes.own("when it applies", "mapped", timing, "apply.when: pull-request, from --apply-when");
  } else {
    notes.own("when it applies", "default", timing, "apply.when: merge, terragucci's default");
  }

  // Approval: gate is one setting for every wave.
  if (b.approvals.length) {
    const waits = b.approvals.filter((a) => a.waits);
    if (waits.length === b.approvals.length) {
      s.gate = "always";
      for (const a of waits) b.note("mapped", a.key, "Approval", "gate: always");
    } else if (waits.length) {
      for (const a of waits) b.note("unmapped", a.key, "Approval", `gate is one setting for every wave, and ${b.approvals.length - waits.length} of ${b.approvals.length} ${units} apply without an approval; gate: always holds them all`);
    } else for (const a of b.approvals) b.note("default", a.key, "Approval", "applies without an approval, as gate's default does for a change that destroys nothing");
  }

  // Drift: one schedule over every root.
  const crons = [...new Set(b.drift.map((d) => d.cron))];
  if (crons.length === 1) {
    s.drift = crons[0];
    const all = new Set(b.drift.map((d) => d.unit)).size >= b.units.length;
    for (const d of b.drift) b.note("mapped", d.key, "Drift", `drift: "${crons[0]}"${all ? "" : `, over every root, not only ${[...new Set(b.drift.map((x) => x.unit))].join(", ")}`}`);
  } else if (crons.length > 1) {
    for (const d of b.drift) b.note("unmapped", d.key, "Drift", `drift is one schedule, and the ${units} give ${crons.join(", ")}`);
  }

  // Ephemeral: the roots of the units that expire.
  if (b.ephemeral.length) {
    const roots = [...new Set(b.ephemeral.map((e) => e.root))].sort();
    s.ephemeral = { roots, ...(b.ttl ? { ttl: b.ttl.value } : {}) };
    for (const e of b.ephemeral) b.note("mapped", e.key, "TTL", `ephemeral.roots: ${e.root}${b.ttl ? `, ttl: ${b.ttl.value}` : ", ttl: 24h, terragucci's default"}`);
    if (b.ttl) b.note("mapped", b.ttl.key, "TTL", `ephemeral.ttl: ${b.ttl.value}`);
  }

  // Variables: values every root gets, and secrets by name.
  const env = [...b.env].filter(([name]) => !b.envConflicts.has(name) && !b.secrets.has(name));
  for (const [name, v] of b.env) if (b.secrets.has(name)) b.note("unmapped", v.key, "Variables", `${name} is a secret elsewhere, so it goes under pass`);
  if (env.length) {
    s.env = Object.fromEntries(env.map(([name, v]) => [name, v.value]));
    for (const [name, v] of env) b.note("mapped", v.key, "Variables", `env: ${name}`);
  }
  if (b.secrets.size) {
    s.pass = { secrets: [...b.secrets.keys()].sort() };
    for (const [name, keys] of b.secrets) {
      const many = keys.length > 1 ? `; set in ${keys.length} places, and a CI secret holds one value, so give a root's own value a name of its own` : "";
      b.note("mapped", keys.join(", "), "Variables", `pass.secrets: ${name}; create the CI secret ${name}, whose value ${b.platform} does not give back${many}`);
    }
  }
  if (b.steps.length) s.steps = b.steps;
}
