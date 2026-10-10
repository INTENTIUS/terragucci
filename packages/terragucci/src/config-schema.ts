/**
 * The JSON Schema of terragucci.yml, built from the same constants config.ts
 * checks with, so the two cannot name different keys or values. The schema
 * holds what JSON Schema can say: every key, its type, its values and its
 * patterns, and the rules between keys of one map that it can state. Rules
 * that read the repo or span maps (the shape refusals, a role used twice)
 * stay in config.ts alone, so the schema accepts a little more than
 * `config check` and never less (test/config-schema.test.ts).
 *
 * `config check` validates a config that passed config.ts against it too,
 * with the small validator below: the bundle carries no JSON Schema library.
 * The schema ships as dist/terragucci.schema.json and on the docs site.
 */
import {
  AGENT_COMMENT_KEYS,
  AGENT_KEYS,
  AGENT_VIA,
  APPLY_BRANCH,
  APPLY_KEYS,
  APPLY_MERGE,
  APPLY_REQUIRES,
  APPLY_WHEN,
  APPROVALS,
  ATMOS_KEYS,
  BINARIES,
  COST_KEYS,
  DASHBOARD_DURATION_KEYS,
  DASHBOARD_KEYS,
  DECIDE_BACKENDS,
  DECIDE_KEYS,
  DEPENDENTS,
  DURATION,
  EPHEMERAL_KEYS,
  FORGES,
  GATES,
  TOKEN_PROTECTION_KEYS,
  JOB_LABEL,
  JOB_STAGE_KEYS,
  LOCKS,
  MODULES_KEYS,
  NOTIFY_KEYS,
  OIDC_KEYS,
  OWN_JOB_NAME,
  PASS_KEYS,
  PASS_RESERVED,
  PASS_RESERVED_PREFIXES,
  POLICY_ENGINES,
  POLICY_INPUTS,
  POLICY_KEYS,
  QUESTION_TYPES,
  REGISTRY_KEYS,
  REGISTRY_NAME,
  REGISTRY_SYSTEM,
  RELEASE_VERSION,
  RESPONSES,
  REVIEW_KEYS,
  RUNTIMES,
  SECRET_NAME,
  STEP_FAILURES,
  STEP_KEYS,
  STEP_STAGES,
  TELEMETRY_KEYS,
  TERRAGRUNT_KEYS,
  TOKEN_PROTECTIONS,
  WIF_PROVIDER,
  type ApplySettings,
  type EphemeralSettings,
  type ModulesSettings,
  type PolicySettings,
  type ProjectSettings,
  type RegistrySettings,
  type StepSettings,
  type TerragruntSettings,
} from "./config";
import { IDENT, LEVEL_KEYS, PROVIDER_KEY, TOP_KEYS } from "./generate-config";

export type JsonSchema = { [k: string]: unknown };

/** Where the schema is published; editors read it from here. */
export const CONFIG_SCHEMA_URL = "https://intentius.io/terragucci/terragucci.schema.json";

const str: JsonSchema = { type: "string" };
const bool: JsonSchema = { type: "boolean" };
const nonBlank: JsonSchema = { type: "string", pattern: "\\S" };
const oneLine: JsonSchema = { type: "string", pattern: "^[^\\r\\n]*\\S[^\\r\\n]*$" };
const pat = (re: RegExp): JsonSchema => ({ type: "string", pattern: re.source });
const secret = pat(SECRET_NAME);
const strings: JsonSchema = { type: "array", items: str };
const cron: JsonSchema = { anyOf: [str, { const: false }] };
const enumOf = (values: readonly string[]): JsonSchema => ({ enum: [...values] });
const whole = (minimum: number, maximum?: number): JsonSchema => ({ type: "integer", minimum, ...(maximum === undefined ? {} : { maximum }) });
const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });
const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [{ type: "null" }, s] });
/** A root glob as ephemeral and apply.branches take it. */
const glob: JsonSchema = { type: "string", pattern: "^[^\\s,;=']+$" };
/** A path inside the repo: not absolute, no `..`. */
const repoPath: JsonSchema = { type: "string", minLength: 1, pattern: "^(?!/)(?!(?:.*/)?\\.\\.(?:/|$))" };

/** A map with these keys and no others; `props` names the type of each. */
function map<K extends string>(keys: readonly K[], props: Record<K, JsonSchema>, extra: JsonSchema = {}): JsonSchema {
  const missing = keys.filter((k) => !(k in props));
  const unknown = Object.keys(props).filter((k) => !keys.includes(k as K));
  if (missing.length || unknown.length) throw new Error(`config schema: keys ${[...missing, ...unknown].join(", ")} disagree with config.ts`);
  return { type: "object", properties: props, additionalProperties: false, ...extra };
}

/** One schema per key, from the key. */
const each = <K extends string>(keys: readonly K[], f: (k: K) => JsonSchema): Record<K, JsonSchema> => Object.fromEntries(keys.map((k) => [k, f(k)])) as Record<K, JsonSchema>;

/** `[Gg][Ii]...`: JSON Schema patterns take no flags, and `pass` refuses its reserved prefixes in any case. */
const anyCase = (s: string): string => [...s].map((c) => (/[a-z]/i.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : c)).join("");

const passName: JsonSchema = {
  type: "string",
  pattern: `^(?!(?:${PASS_RESERVED_PREFIXES.map(anyCase).join("|")}))(?!(?:${PASS_RESERVED.join("|")})$)[A-Za-z_][A-Za-z0-9_]*$`,
};

const rolePair: JsonSchema = map(["plan", "apply"], { plan: { type: "string", minLength: 1 }, apply: { type: "string", minLength: 1 } }, { required: ["plan", "apply"] });

const runnerSpec: JsonSchema = {
  anyOf: [
    pat(JOB_LABEL),
    { type: "array", minItems: 1, uniqueItems: true, items: pat(JOB_LABEL) },
    map(["group", "labels"], { group: nonBlank, labels: { type: "array", minItems: 1, uniqueItems: true, items: pat(JOB_LABEL) } }, { required: ["group"] }),
  ],
};

const agentRun: JsonSchema = {
  anyOf: [
    bool,
    map(AGENT_COMMENT_KEYS, { command: oneLine, key_secret: secret, max_turns: whole(1), timeout: whole(1) }),
  ],
};

const hclArgs: JsonSchema = { type: "object", propertyNames: pat(IDENT), additionalProperties: nullable(ref("hcl_value")) };

function generateLevel(top: boolean): JsonSchema {
  const level = {
    backend: nullable({ type: "object", minProperties: 1, maxProperties: 1, propertyNames: pat(IDENT), additionalProperties: hclArgs }),
    providers: {
      type: "object",
      propertyNames: pat(PROVIDER_KEY),
      additionalProperties: nullable({
        type: "object",
        properties: { source: { type: ["string", "null"] }, version: { type: ["string", "null"] } },
        propertyNames: pat(IDENT),
        additionalProperties: nullable(ref("hcl_value")),
        not: { required: ["alias"] },
      }),
    },
    required_version: nullable(nonBlank),
    disable_init: { type: ["boolean", "null"] },
  };
  if (!top) return map(LEVEL_KEYS, level);
  const levels: JsonSchema = { type: "object", additionalProperties: nullable(ref("generate_level")) };
  return map(TOP_KEYS, { ...level, dirs: levels, roots: levels });
}

const apply = map(APPLY_KEYS as (keyof ApplySettings)[], {
  when: enumOf(APPLY_WHEN),
  merge: enumOf(APPLY_MERGE),
  merge_token_env: secret,
  requires: { type: "array", uniqueItems: true, items: enumOf(APPLY_REQUIRES) },
  resume: whole(5, 60),
  branches: { type: "object", minProperties: 1, propertyNames: pat(APPLY_BRANCH), additionalProperties: { type: "array", minItems: 1, items: glob } },
} satisfies Record<keyof ApplySettings, JsonSchema>);

const step = map(STEP_KEYS as readonly (keyof StepSettings)[], {
  name: nonBlank,
  run: nonBlank,
  before: enumOf(STEP_STAGES),
  after: enumOf(STEP_STAGES),
  roots: strings,
  on_failure: enumOf(STEP_FAILURES),
} satisfies Record<keyof StepSettings, JsonSchema>, {
  required: ["run"],
  oneOf: [{ required: ["before"] }, { required: ["after"] }],
  // A hold is decided at the gate, before any apply.
  if: { properties: { on_failure: { const: "approve" } }, required: ["on_failure"] },
  then: { properties: { before: enumOf(["init", "plan"]), after: enumOf(["init", "plan"]) } },
});

const registry = map(REGISTRY_KEYS as (keyof RegistrySettings)[], {
  bucket: str,
  dir: repoPath,
  endpoint: str,
  prefix: str,
  url: { type: "string", pattern: "^https://[^/\\s?#]+/?$" },
  namespace: pat(REGISTRY_NAME),
  namespaces: { type: "object", propertyNames: { pattern: "^[^/]" }, additionalProperties: pat(REGISTRY_NAME) },
  system: pat(REGISTRY_SYSTEM),
  download: enumOf(["tarball", "git-tags", "oci"]),
} satisfies Record<keyof RegistrySettings, JsonSchema>, {
  required: ["url", "namespace"],
  oneOf: [{ required: ["bucket"] }, { required: ["dir"] }],
  dependentRequired: { endpoint: ["bucket"] },
});

const publishTarget: JsonSchema = { type: "string", pattern: "^(?:git-tags$|oci://[^/]+/.)" };

const modules = map([...MODULES_KEYS] as (keyof ModulesSettings)[], {
  path: str,
  publish: { anyOf: [publishTarget, { type: "array", items: publishTarget }] },
  attest: { anyOf: [bool, map(["key"], { key: { type: "string", minLength: 1 } })] },
  require: { const: "attested" },
  trusted: {
    type: "array",
    items: map(["source", "key", "ledger"], {
      source: { type: "string", pattern: "^(oci://[^/]+/.+|(git::)?(https?|ssh)://.+)$" },
      key: { type: "string", minLength: 1 },
      ledger: { type: "string", pattern: "^(https?|ssh|file)://." },
    }, { required: ["source", "key", "ledger"] }),
  },
  test: bool,
  registry,
} satisfies Record<keyof ModulesSettings, JsonSchema>);

const terragrunt = map(TERRAGRUNT_KEYS as (keyof TerragruntSettings)[], {
  version: pat(RELEASE_VERSION),
  exclude: strings,
  parallelism: whole(1),
  dependents: enumOf(DEPENDENTS),
  credentials: { type: "object", additionalProperties: rolePair },
} satisfies Record<keyof TerragruntSettings, JsonSchema>);

const policy = map(POLICY_KEYS as (keyof PolicySettings)[], {
  engine: enumOf(POLICY_ENGINES),
  path: repoPath,
  source: { type: "string", pattern: "^git\\+(https?|file)://.*@" },
  namespace: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_.]*$" },
  input: enumOf(POLICY_INPUTS),
  override: { type: "array", minItems: 1, items: oneLine },
} satisfies Record<keyof PolicySettings, JsonSchema>);

const oidc = map(OIDC_KEYS, {
  plan_role: { type: "string", minLength: 1 },
  apply_role: { type: "string", minLength: 1 },
  audience: str,
  roles: { type: "object", minProperties: 1, additionalProperties: rolePair },
  gcp: map(["workload_identity_provider", "plan_service_account", "apply_service_account", "token_url"], {
    workload_identity_provider: pat(WIF_PROVIDER),
    plan_service_account: { type: "string", pattern: "^[^@\\s]+@[^@\\s]+$" },
    apply_service_account: { type: "string", pattern: "^[^@\\s]+@[^@\\s]+$" },
    token_url: { type: "string", pattern: "^https://[^\\s/]+/\\S*$" },
  }, { required: ["workload_identity_provider", "plan_service_account", "apply_service_account"] }),
  azure: map(["tenant_id", "subscription_id", "plan_client_id", "apply_client_id", "audience"], {
    tenant_id: { type: "string", minLength: 1 },
    subscription_id: { type: "string", minLength: 1 },
    plan_client_id: { type: "string", minLength: 1 },
    apply_client_id: { type: "string", minLength: 1 },
    audience: { type: "string", minLength: 1 },
  }, { required: ["tenant_id", "subscription_id", "plan_client_id", "apply_client_id"] }),
}, {
  minProperties: 1,
  // AWS takes both roles, or a role per glob.
  dependentRequired: { plan_role: ["apply_role"], apply_role: ["plan_role"] },
  if: { required: ["audience"], not: { required: ["roles"] } },
  then: { required: ["plan_role", "apply_role"] },
});

const decide = map(DECIDE_KEYS, {
  backend: enumOf(DECIDE_BACKENDS),
  url: { type: "string", pattern: "^https?://[^/\\s]+" },
  // A pinned version, never an alias that moves.
  model: { type: "string", minLength: 1, pattern: "^(?![\\s\\S]*(?:^|[-_.])(?:latest|preview)$)" },
  token_env: secret,
  thresholds: map(QUESTION_TYPES, each(QUESTION_TYPES, () => ({ type: "number", exclusiveMinimum: 0, maximum: 1 }))),
}, {
  required: ["backend"],
  allOf: [
    { if: { properties: { backend: { const: "jev" } } }, then: { required: ["token_env"] }, else: { required: ["url"] } },
    { if: { properties: { backend: { const: "laya" } } }, else: { required: ["model"] } },
  ],
});

const dashboards: JsonSchema = {
  anyOf: [
    bool,
    map(DASHBOARD_KEYS, each(DASHBOARD_KEYS, (k) =>
      (DASHBOARD_DURATION_KEYS as readonly string[]).includes(k) ? pat(DURATION)
        : k === "dir" ? { type: "string", pattern: "^(?!/)(?!(?:.*/)?\\.\\.(?:/|$))[^\\r\\n]+$" }
        : { type: "string", pattern: "^[^\\r\\n]+$" })),
  ],
};

const ephemeral = map(EPHEMERAL_KEYS as (keyof EphemeralSettings)[], {
  roots: { type: "array", minItems: 1, items: glob },
  ttl: { type: "string", pattern: "^[1-9]\\d*[mhd]$" },
  sweep: whole(5, 60),
} satisfies Record<keyof EphemeralSettings, JsonSchema>, { required: ["roots"] });

/** Every setting, with a line for an editor to show. `top` is a repo's own file, where `version` may map root globs. */
function settings(top: boolean): Record<keyof ProjectSettings, JsonSchema> {
  return {
    roots: { ...strings, description: "Globs of root directories. Detected when absent." },
    binary: { ...enumOf(BINARIES), description: "The binary the pipeline runs. Detected when absent." },
    version: top
      ? { anyOf: [str, { type: "object", additionalProperties: pat(RELEASE_VERSION) }], description: "The binary's release, or a map of root glob to release." }
      : { ...str, description: "The binary's release." },
    generate: { ...ref("generate"), description: "Backend, provider and version files terragucci generate writes for each plain root." },
    forge: { ...enumOf(FORGES), description: "The forge, for a host terragucci cannot name." },
    url: { ...str, description: "Where the project lives, for a forge not on https or the default port." },
    gate: { ...enumOf(GATES), description: "When a wave waits for an approval." },
    approval: { ...enumOf(APPROVALS), description: "What counts as a waiting wave's approval." },
    apply: { ...apply, description: "When a change applies." },
    locks: { ...enumOf(LOCKS), description: "When a pull request takes its root locks." },
    waves: {
      type: "object",
      properties: {
        canary: strings,
        jobs: whole(1),
        after: { type: "object", additionalProperties: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } } },
      },
      description: "The canary wave, the jobs one wave spreads across, and extra apply order.",
    },
    drift: { ...cron, description: "A cron schedule for tf-drift, or false." },
    synth: { ...nonBlank, description: "The command that writes the roots before any job reads them." },
    steps: { type: "array", items: step, description: "Commands run before or after a root's init, plan, apply and drift." },
    image: { type: "string", pattern: "^[^\\s]+$", description: "The image every job runs in, built FROM terragucci's." },
    notify: {
      ...map(NOTIFY_KEYS, {
        slack: secret,
        teams: secret,
        webhook: secret,
        webhook_key: secret,
        relay: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$" },
      }, {
        minProperties: 1,
        dependentRequired: { webhook: ["webhook_key"], webhook_key: ["webhook"] },
        if: { required: ["relay"] },
        then: { anyOf: [{ required: ["slack"] }, { required: ["teams"] }] },
      }),
      description: "The secrets holding Slack, Teams or webhook addresses, and the relay's name.",
    },
    cost: {
      anyOf: [{ const: true }, map(COST_KEYS, { key_secret: secret, command: nonBlank, approve_above: { type: "number", minimum: 0 } })],
      description: "Cost estimates per root in the plan note.",
    },
    comments: { ...cron, description: "GitLab only: the cron of the comments schedule, or false." },
    rollouts: top
      ? { anyOf: [nonBlank, { const: false }], description: "A cron schedule for the job that opens each rollout's next wave, or false." }
      : { const: false, description: "A single repo's key; a control repo runs terragucci respond rollout itself." },
    gitlab: { ...map(TOKEN_PROTECTION_KEYS, { token: enumOf(TOKEN_PROTECTIONS) }), description: "GitLab only: how the project keeps its forge token." },
    runtime: { ...enumOf(RUNTIMES), description: "Where the stages run." },
    reports: {
      type: "object",
      properties: { bucket: str, endpoint: {}, prefix: {}, url: { type: "string", pattern: "^https?://[^\\s?#]+$" }, role: { type: "string", pattern: "^arn:aws[\\w-]*:iam::\\d{12}:role/\\S+$" } },
      required: ["bucket"],
      description: "A bucket for plan reports: s3://, gs:// or az://.",
    },
    token_env: { ...str, description: "The environment variable holding the forge token." },
    env: { type: "object", additionalProperties: str, description: "Environment variables every job gets. Values only, never secrets." },
    runner: {
      anyOf: [
        runnerSpec,
        { type: "object", minProperties: 1, not: { required: ["group"] }, propertyNames: enumOf(JOB_STAGE_KEYS), additionalProperties: runnerSpec },
      ],
      description: "The runner each job runs on: a label, a list of labels, a GitHub runner group, or one per stage.",
    },
    pass: {
      ...map(PASS_KEYS, {
        secrets: { type: "array", minItems: 1, uniqueItems: true, items: passName },
        vars: { type: "array", minItems: 1, uniqueItems: true, items: passName },
      }, { minProperties: 1 }),
      description: "Names of CI secrets and variables the plan, apply and drift jobs get.",
    },
    telemetry: {
      ...map(TELEMETRY_KEYS, {
        headers_secret: secret,
        trace_url: { type: "string", pattern: "^https?://\\S*\\{trace_id\\}\\S*$" },
      }, { minProperties: 1 }),
      description: "The secret holding OTLP headers, and a trace link with {trace_id}.",
    },
    tips: { ...bool, description: "Tips in the plan note." },
    modules: { ...modules, description: "Module publishing, attestation and the module registry." },
    oidc: { ...oidc, description: "Cloud identities the jobs take over OIDC: a read-only one for plan, a write one for apply." },
    parallelism: { ...whole(1), description: "How many roots of one dependency layer plan at once." },
    terragrunt: { ...terragrunt, description: "Terragrunt settings." },
    atmos: { ...map(ATMOS_KEYS, { version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.]+)?$" } }), description: "Atmos settings." },
    policy: { ...policy, description: "Policy checks over each plan." },
    atlantis_comments: { ...bool, description: "Read atlantis plan and atlantis apply comments as terragucci's." },
    respond: {
      ...map(Object.keys(RESPONSES), each(Object.keys(RESPONSES), (event) => enumOf(RESPONSES[event as keyof typeof RESPONSES]))),
      description: "The response to each pipeline event.",
    },
    agent: {
      ...map(AGENT_KEYS, {
        via: enumOf(AGENT_VIA),
        token_env: { type: "string", minLength: 1 },
        comment: agentRun,
        drift: agentRun,
      }, { required: ["via", "token_env"] }),
      description: "The coding agent behind /terragucci agent and the drift agent.",
    },
    review: {
      ...map(REVIEW_KEYS, {
        agent: bool,
        command: oneLine,
        key_secret: secret,
        instructions: { type: "string", pattern: "^(?:\\./)?(?!/)[A-Za-z0-9_./-]+$" },
        timeout: whole(1),
      }, { anyOf: [{ maxProperties: 0 }, { required: ["agent"] }] }),
      description: "A model's review of each pull request's intent against its plan.",
    },
    decide: { ...decide, description: "The typed-decision service." },
    audit_region: { type: "string", pattern: "^[a-z]{2}(-[a-z]+)+-\\d+$", description: "The AWS region whose CloudTrail drift attribution reads." },
    dashboards: { ...dashboards, description: "Dashboards and alert rules written next to the pipeline." },
    own_jobs: {
      anyOf: [
        { type: "string", pattern: "^(?!/)(?!(?:.*/)?\\.\\.(?:/|$)).*\\.ya?ml$" },
        { type: "object", minProperties: 1, propertyNames: pat(OWN_JOB_NAME), additionalProperties: { type: "object", minProperties: 1 } },
      ],
      description: "Jobs of your own, in the forge's syntax, or the path of a YAML file holding them.",
    },
    ephemeral: { ...ephemeral, description: "Roots each pull request gets a copy of." },
  };
}

/** The settings of a control repo's `defaults` or one of its `projects`. */
function projectEntry(): JsonSchema {
  return { type: "object", properties: settings(false), additionalProperties: false };
}

/** The JSON Schema of terragucci.yml. */
export function configSchema(): JsonSchema {
  const own = settings(true);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: CONFIG_SCHEMA_URL,
    title: "terragucci.yml",
    description: "One repo's settings, or a control repo's defaults and projects. https://intentius.io/terragucci/reference/config/",
    type: ["object", "null"],
    properties: {
      ...own,
      defaults: { ...ref("project"), not: { required: ["url"] }, description: "Settings every project takes, under its own." },
      projects: {
        type: "object",
        propertyNames: { pattern: "^(?:https?://)?[^/]+(?:/[^/]+){2,}/*$" },
        additionalProperties: nullable(ref("project")),
        description: "<host>/<owner>/<name> to that project's settings.",
      },
    },
    additionalProperties: false,
    dependentRequired: { defaults: ["projects"] },
    // A control repo keeps shared settings under defaults.
    if: { required: ["projects"] },
    then: { propertyNames: enumOf(["defaults", "projects"]) },
    $defs: {
      project: projectEntry(),
      generate: generateLevel(true),
      generate_level: generateLevel(false),
      hcl_value: {
        anyOf: [{ type: ["string", "number", "boolean"] }, { type: "array", items: ref("hcl_value") }, { type: "object", additionalProperties: ref("hcl_value") }],
      },
    },
  };
}

// ── validation ───────────────────────────────────────────────────────────────

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function hasType(v: unknown, t: string): boolean {
  if (t === "integer") return Number.isInteger(v);
  return typeOf(v) === t;
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (isMap(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/**
 * The places `value` does not match `schema`: the subset of JSON Schema 2020-12
 * configSchema uses. Each problem is `<path>: <why>`.
 */
export function schemaProblems(schema: JsonSchema, value: unknown, root: JsonSchema = schema, path = "config"): string[] {
  const out: string[] = [];
  const s = schema;
  if (typeof s.$ref === "string") {
    const target = (root.$defs as Record<string, JsonSchema>)[s.$ref.replace("#/$defs/", "")];
    if (!target) throw new Error(`config schema: no ${s.$ref}`);
    out.push(...schemaProblems(target, value, root, path));
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => hasType(value, t))) return [...out, `${path}: must be ${types.join(" or ")}`];
  }
  if ("const" in s && canonical(value) !== canonical(s.const)) out.push(`${path}: must be ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((e) => canonical(e) === canonical(value))) out.push(`${path}: must be one of ${s.enum.join(", ")}`);
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && [...value].length < s.minLength) out.push(`${path}: must not be empty`);
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(value)) out.push(`${path}: does not match ${s.pattern}`);
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) out.push(`${path}: must be ${s.minimum} or more`);
    if (typeof s.maximum === "number" && value > s.maximum) out.push(`${path}: must be ${s.maximum} or less`);
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) out.push(`${path}: must be more than ${s.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) out.push(`${path}: must list at least ${s.minItems}`);
    if (s.uniqueItems === true && new Set(value.map(canonical)).size !== value.length) out.push(`${path}: lists an item twice`);
    if (isMap(s.items)) value.forEach((x, i) => out.push(...schemaProblems(s.items as JsonSchema, x, root, `${path}[${i}]`)));
  }
  if (isMap(value)) {
    const keys = Object.keys(value);
    const props = (s.properties ?? {}) as Record<string, JsonSchema>;
    if (typeof s.minProperties === "number" && keys.length < s.minProperties) out.push(`${path}: must set at least ${s.minProperties} key(s)`);
    if (typeof s.maxProperties === "number" && keys.length > s.maxProperties) out.push(`${path}: must set at most ${s.maxProperties} key(s)`);
    for (const k of (s.required ?? []) as string[]) if (!(k in value)) out.push(`${path}.${k}: is required`);
    for (const [k, needs] of Object.entries((s.dependentRequired ?? {}) as Record<string, string[]>)) {
      if (k in value) for (const n of needs) if (!(n in value)) out.push(`${path}.${n}: is required with ${k}`);
    }
    for (const k of keys) {
      const at = `${path}.${k}`;
      if (isMap(s.propertyNames)) for (const p of schemaProblems(s.propertyNames, k, root, at)) out.push(`${at}: is not a key here (${p.slice(at.length + 2)})`);
      if (k in props) out.push(...schemaProblems(props[k], value[k], root, at));
      else if (s.additionalProperties === false) out.push(`${at}: is not a setting`);
      else if (isMap(s.additionalProperties)) out.push(...schemaProblems(s.additionalProperties, value[k], root, at));
    }
  }
  const sub = (x: JsonSchema): string[] => schemaProblems(x, value, root, path);
  for (const x of (s.allOf ?? []) as JsonSchema[]) out.push(...sub(x));
  if (Array.isArray(s.anyOf)) {
    const each = (s.anyOf as JsonSchema[]).map(sub);
    if (!each.some((p) => p.length === 0)) out.push(...each.reduce((a, b) => (b.length < a.length ? b : a)));
  }
  if (Array.isArray(s.oneOf)) {
    const passing = (s.oneOf as JsonSchema[]).filter((x) => sub(x).length === 0).length;
    if (passing !== 1) out.push(`${path}: must match exactly one of ${(s.oneOf as JsonSchema[]).map((x) => JSON.stringify(x)).join(", ")}`);
  }
  if (isMap(s.not) && sub(s.not).length === 0) out.push(`${path}: must not match ${JSON.stringify(s.not)}`);
  if (isMap(s.if)) {
    const branch = sub(s.if).length === 0 ? s.then : s.else;
    if (isMap(branch)) out.push(...sub(branch));
  }
  return out;
}

/** The problems configSchema finds in a parsed config. */
export function configSchemaProblems(config: unknown): string[] {
  return schemaProblems(configSchema(), config);
}
