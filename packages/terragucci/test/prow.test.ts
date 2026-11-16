import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig, type ProwSettings } from "../src/config";
import { configIdentities } from "../src/identities";
import { init } from "../src/init";
import { labelApprovers, labelWave } from "../src/prow-labels";
import { noteMarker } from "../src/report/marker";
import { DRIFT_TOKEN, FORK_GUARD, ORIGIN_CREDENTIAL, ORIGIN_LINES, PROW_JOBS, renderProwJobs, type ProwJobsInput } from "../src/render-prow";
import { git, tmp, twoRootRepo, write } from "./helpers";

const FIXTURES = join(__dirname, "fixtures/prow");
const PROW_CONFIG = join(FIXTURES, "config.yaml");

const PROW: ProwSettings = {
  cluster: "untrusted",
  trusted_cluster: "trusted",
  service_accounts: { plan: "tf-plan", apply: "tf-apply" },
  token_secret: { name: "terragucci-github-token" },
};

const input = (over: Partial<ProwJobsInput> = {}): ProwJobsInput => ({
  repo: "acme/infra",
  defaultBranch: "main",
  prow: PROW,
  binary: "tofu",
  image: "ghcr.io/intentius/terragucci-tofu:1",
  layers: [["network"], ["app", "cache"]],
  env: {},
  check: {},
  report: {},
  ...over,
});

type Job = { name: string; cluster: string; spec: { serviceAccountName?: string; automountServiceAccountToken?: boolean; containers: { args: string[]; env?: { name: string; valueFrom?: unknown }[] }[] } } & Record<string, unknown>;
interface JobConfig {
  presubmits: Record<string, Job[]>;
  postsubmits: Record<string, Job[]>;
  periodics?: Job[];
}
const jobsOf = (text: string): JobConfig => parseYAML(text) as unknown as JobConfig;
const script = (j: Job): string => j.spec.containers[0]!.args[0]!;
const problems = (raw: unknown): string[] => {
  try {
    validateConfig(raw, "terragucci.yml");
    return [];
  } catch (e) {
    return (e as { problems?: string[] }).problems ?? [(e as Error).message];
  }
};

describe("runtime: prow in terragucci.yml", () => {
  const ok = { runtime: "prow", prow: PROW };

  it("takes runtime: prow with the prow key", () => {
    expect(problems(ok)).toEqual([]);
    expect(problems({ ...ok, prow: { ...PROW, plan_before_merge: true, deck: "https://prow.example.com", config_repo: "acme/test-infra", namespace: "test-pods", path: "ci/prow/terragucci.yaml" }, approval: "prow-labels" })).toEqual([]);
  });

  it("needs the trusted cluster, both service accounts and the token's Secret", () => {
    const p = problems({ runtime: "prow", prow: {} }).join("\n");
    expect(p).toContain("prow.trusted_cluster is required");
    expect(p).toContain("prow.service_accounts must be a map of plan and apply");
    expect(p).toContain("prow.token_secret must be a map");
    expect(problems({ runtime: "prow" }).join("\n")).toContain("prow must be a map with trusted_cluster");
  });

  it("refuses one service account for plan and apply, and the checks on the trusted cluster", () => {
    expect(problems({ runtime: "prow", prow: { ...PROW, service_accounts: { plan: "tf", apply: "tf" } } }).join("\n")).toContain("plan and drift take a read-only identity, apply a write one");
    expect(problems({ runtime: "prow", prow: { ...PROW, cluster: "trusted" } }).join("\n")).toContain("so it runs where no credential is");
    expect(problems({ runtime: "prow", prow: { ...PROW, service_accounts: { plan: "TF_Plan", apply: "tf-apply" } } }).join("\n")).toContain("must be a Kubernetes name");
  });

  it("refuses prow without runtime: prow, another forge, and pr-review", () => {
    expect(problems({ prow: PROW }).join("\n")).toContain("prow goes with runtime: prow");
    expect(problems({ ...ok, forge: "gitlab" }).join("\n")).toContain("runtime: prow serves GitHub repositories");
    expect(problems({ ...ok, approval: "pr-review" }).join("\n")).toContain("approval: pr-review reads GitHub reviews");
    expect(problems({ approval: "prow-labels" }).join("\n")).toContain("which only runtime: prow has");
  });

  it("refuses prow-labels without the plan presubmit, whose note binds the labels to a plan", () => {
    expect(problems({ ...ok, approval: "prow-labels" }).join("\n")).toContain("prow.plan_before_merge is off");
    expect(problems({ ...ok, approval: { mode: "prow-labels" }, prow: { ...PROW, plan_before_merge: true } })).toEqual([]);
  });

  it("refuses the keys whose jobs or credentials a Prow job config does not carry", () => {
    const p = problems({ ...ok, oidc: { plan_role: "arn:aws:iam::111111111111:role/p", apply_role: "arn:aws:iam::111111111111:role/a" }, rollouts: "0 * * * *", runner: "big", apply: { resume: 10 }, locks: "plan" }).join("\n");
    expect(p).toContain("oidc does not go with runtime: prow: the jobs take their cloud identity from the pod's service account");
    expect(p).toContain("rollouts does not go with runtime: prow");
    expect(p).toContain("runner does not go with runtime: prow");
    expect(p).toContain("apply.resume does not go with runtime: prow");
    expect(p).toContain("locks: plan does not go with runtime: prow");
  });
});

describe("the Prow jobs", () => {
  it("checks before merge on the untrusted cluster with no credential, no token and no service account token", () => {
    const c = jobsOf(renderProwJobs(input()).content).presubmits["acme/infra"]!;
    expect(c.map((j) => j.name)).toEqual([PROW_JOBS.check]);
    const check = c[0]!;
    expect(check.cluster).toBe("untrusted");
    expect(check.always_run).toBe(true);
    expect(check.branches).toEqual(["^main$"]);
    expect(check.spec.automountServiceAccountToken).toBe(false);
    expect(check.spec.serviceAccountName).toBeUndefined();
    expect(check.spec.containers[0]!.env).toBeUndefined();
    expect(script(check)).toContain("tofu fmt -check -recursive -diff .");
    expect(script(check)).toContain('export TG_PR="$PULL_NUMBER" TG_SHA="$PULL_PULL_SHA" TG_BASE="$PULL_BASE_SHA"');
  });

  it("plans and applies after merge on the trusted cluster, plan with the plan account and apply with the apply account", () => {
    const post = jobsOf(renderProwJobs(input()).content).postsubmits["acme/infra"]!;
    expect(post.map((j) => [j.name, j.cluster, j.spec.serviceAccountName])).toEqual([
      [PROW_JOBS.plan, "trusted", "tf-plan"],
      [PROW_JOBS.apply, "trusted", "tf-apply"],
    ]);
    for (const j of post) expect(j.spec.containers[0]!.env).toEqual([{ name: "GITHUB_TOKEN", valueFrom: { secretKeyRef: { name: "terragucci-github-token", key: "token" } } }]);
    expect(post[1]!.max_concurrency).toBe(1);
  });

  it("runs every wave in order in the apply job, each reading the outcomes of the ones before, with terragucci/apply after each", () => {
    const apply = script(jobsOf(renderProwJobs(input()).content).postsubmits["acme/infra"]![1]!);
    const w1 = apply.indexOf("--wave 1 --render-spec");
    const s1 = apply.indexOf("--wave 1 --of 2 --apply-status terragucci/apply");
    const w2 = apply.indexOf("--wave 2 --render-spec");
    expect(w1).toBeGreaterThan(0);
    expect(s1).toBeGreaterThan(w1);
    expect(w2).toBeGreaterThan(s1);
    expect(apply).toContain("CHANT_WAVES_SPEC_RUNS=head");
  });

  it("drops the token before the plan runs the change's code, and skips a fork's pull request before any of its code runs", () => {
    const pre = jobsOf(renderProwJobs(input({ prow: { ...PROW, plan_before_merge: true } })).content).presubmits["acme/infra"]!;
    const plan = pre.find((j) => j.name === PROW_JOBS.plan)!;
    expect(plan.cluster).toBe("trusted");
    expect(plan.spec.serviceAccountName).toBe("tf-plan");
    expect(plan.rerun_command).toBe("/terragucci plan");
    // Prow's trigger is Go's regexp, whose (?m) is JavaScript's m flag.
    const trigger = new RegExp((plan.trigger as string).replace(/^\(\?m\)/, ""), "m");
    expect(trigger.test("/terragucci plan")).toBe(true);
    expect(trigger.test("/test terragucci-plan")).toBe(true);
    expect(trigger.test("/terragucci apply")).toBe(false);
    const s = script(plan);
    const guard = s.indexOf(FORK_GUARD[0]!);
    const unset = s.indexOf("unset GITHUB_TOKEN TG_TOKEN");
    const stage = s.indexOf("terragucci stage tf-plan");
    expect(guard).toBeGreaterThan(0);
    expect(unset).toBeGreaterThan(guard);
    expect(stage).toBeGreaterThan(unset);
    expect(s.indexOf("terragucci components pr-post --pr")).toBeGreaterThan(stage);
    expect(s).toContain("CHANT_PLAN_NOTE_WORDS=");
    expect(s).not.toContain("GITHUB_RUN_ID");
  });

  it("runs drift as a periodic on the default branch with the plan account", () => {
    const d = jobsOf(renderProwJobs(input({ drift: "0 6 * * *" })).content).periodics![0]!;
    expect(d.name).toBe(PROW_JOBS.drift);
    expect(d.cron).toBe("0 6 * * *");
    expect(d.spec.serviceAccountName).toBe("tf-plan");
    expect(d.extra_refs).toEqual([{ org: "acme", repo: "infra", base_ref: "main", workdir: true }]);
    expect(script(d)).toContain("terragucci stage tf-drift");
    expect(script(d)).not.toContain("GITHUB_RUN_ID");
    expect(jobsOf(renderProwJobs(input()).content).periodics).toBeUndefined();
  });

  it("gives the drift stage the periodic's token as TG_TOKEN, which it keeps the drift issue with", () => {
    const s = script(jobsOf(renderProwJobs(input({ drift: "0 6 * * *" })).content).periodics![0]!);
    expect(s).toContain(DRIFT_TOKEN);
    expect(s.indexOf(DRIFT_TOKEN)).toBeLessThan(s.indexOf("terragucci stage tf-drift"));
  });

  it("names origin in clonerefs' checkout, and lets git use the token with it only in the jobs that hold one", () => {
    const doc = jobsOf(renderProwJobs(input({ drift: "0 6 * * *", prow: { ...PROW, plan_before_merge: true } })).content);
    const jobs = [...doc.presubmits["acme/infra"]!, ...doc.postsubmits["acme/infra"]!, ...doc.periodics!];
    for (const j of jobs) {
      const s = script(j);
      expect(s).toContain(ORIGIN_LINES[0]!);
      // Before any stage runs, so the gate's read of chant/lifecycle and the waves' record push find origin.
      expect(s.indexOf(ORIGIN_LINES[0]!)).toBeLessThan(s.indexOf("terragucci "));
      const holdsToken = (j.spec.containers[0]!.env ?? []).some((e) => e.name === "GITHUB_TOKEN");
      expect(s.includes(ORIGIN_CREDENTIAL)).toBe(holdsToken);
    }
    expect(script(doc.presubmits["acme/infra"]!.find((j) => j.name === PROW_JOBS.check)!)).not.toContain("credential.");
  });

  it("adds origin in a checkout with no remote, keeps one that is there, and answers git with the token only while the shell holds it", () => {
    const home = tmp("terragucci-prow-home-");
    const { GITHUB_TOKEN: _token, ...parent } = process.env;
    const env = { ...parent, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GITHUB_SERVER_URL: "https://github.example", GITHUB_REPOSITORY: "acme/infra" };
    const run = (dir: string, extra: Record<string, string> = {}, then = "") =>
      execFileSync("bash", ["-c", [...ORIGIN_LINES, ORIGIN_CREDENTIAL, then].join("\n")], { cwd: dir, env: { ...env, ...extra }, encoding: "utf-8" });
    const bare = tmp("terragucci-prow-clone-");
    git(bare, "init", "-q");
    run(bare);
    expect(git(bare, "remote", "get-url", "origin").trim()).toBe("https://github.example/acme/infra.git");
    const fill = "printf 'protocol=https\\nhost=github.example\\npath=acme/infra.git\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null || true";
    expect(run(bare, { GITHUB_TOKEN: "t0ken" }, fill)).toContain("password=t0ken");
    expect(run(bare, {}, fill)).not.toContain("password=");
    const cloned = tmp("terragucci-prow-clone-");
    git(cloned, "init", "-q");
    git(cloned, "remote", "add", "origin", "https://elsewhere.example/acme/infra.git");
    run(cloned);
    expect(git(cloned, "remote", "get-url", "origin").trim()).toBe("https://elsewhere.example/acme/infra.git");
  });

  it("names where the file goes when Prow reads its job config from another repository", () => {
    const r = renderProwJobs(input({ prow: { ...PROW, config_repo: "acme/test-infra" } }));
    expect(r.content).toContain("Prow reads its job config from acme/test-infra");
    expect(r.notes[0]).toContain("Prow reads job config from acme/test-infra, so copy it there");
  });

  it("links Deck's page of the job when prow.deck is set", () => {
    expect(renderProwJobs(input({ prow: { ...PROW, deck: "https://prow.example.com/" } })).content).toContain("export TG_JOB_URL='https://prow.example.com/prowjob?prowjob='\"${PROW_JOB_ID:-}\"");
  });

  it("is ProwJob data Prow's ProwJob schema takes: every job, as Prow turns it into a ProwJob spec (vendored schema)", async () => {
    const Ajv = (await import("ajv")).default;
    const ajv = new Ajv({ strict: false, allErrors: true });
    const check = ajv.compile(JSON.parse(readFileSync(join(FIXTURES, "prowjob-spec.schema.json"), "utf-8")));
    const doc = jobsOf(renderProwJobs(input({ drift: "0 6 * * *", prow: { ...PROW, plan_before_merge: true, namespace: "test-pods", deck: "https://prow.example.com" } })).content);
    // What Prow's pjutil.specFromJobBase copies from a job into the ProwJob it creates.
    const spec = (j: Job, type: string): Record<string, unknown> => ({
      type,
      agent: "kubernetes",
      job: j.name,
      cluster: j.cluster,
      ...(j.namespace ? { namespace: j.namespace } : {}),
      ...(j.max_concurrency ? { max_concurrency: j.max_concurrency } : {}),
      ...(j.decoration_config ? { decoration_config: j.decoration_config } : {}),
      ...(j.rerun_command ? { rerun_command: j.rerun_command } : {}),
      ...(j.extra_refs ? { extra_refs: j.extra_refs } : {}),
      ...(type !== "periodic" ? { refs: { org: "acme", repo: "infra", base_ref: "main", base_sha: "0".repeat(40) } } : {}),
      report: true,
      pod_spec: j.spec,
    });
    const all = [
      ...doc.presubmits["acme/infra"]!.map((j) => spec(j, "presubmit")),
      ...doc.postsubmits["acme/infra"]!.map((j) => spec(j, "postsubmit")),
      ...(doc.periodics ?? []).map((j) => spec(j, "periodic")),
    ];
    expect(all).toHaveLength(5);
    for (const s of all) expect({ job: s.job, ok: check(s), errors: check.errors }).toEqual({ job: s.job, ok: true, errors: null });
    // The copy refuses a field the CRD does not name.
    expect(check({ ...all[0], pod_spec: { containers: [{ name: "x", image: "i", bogus: 1 }] } })).toBe(false);
  });
});

describe("init with runtime: prow", () => {
  const repoWith = (config: string, remote = "https://github.com/acme/infra.git"): string => {
    const dir = twoRootRepo();
    write(dir, { "terragucci.yml": config });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "remote", "add", "origin", remote);
    return dir;
  };
  const config = "runtime: prow\nprow:\n  config_repo: acme/test-infra\n  cluster: untrusted\n  trusted_cluster: trusted\n  service_accounts: { plan: tf-plan, apply: tf-apply }\n  token_secret: { name: terragucci-github-token }\n";

  it("writes the Prow job config in place of a workflow, with the waves' spec, and says where the file goes", async () => {
    const dir = repoWith(config);
    const r = await init(dir, { binary: "tofu" });
    const text = readFileSync(join(dir, "prow/terragucci.yaml"), "utf-8");
    expect(Object.keys(jobsOf(text).presubmits)).toEqual(["acme/infra"]);
    expect(existsSync(join(dir, ".github/workflows/terragucci.yml"))).toBe(false);
    expect(existsSync(join(dir, ".chant/op-waves/tf-apply.spec.json"))).toBe(true);
    expect(r.notes.join("\n")).toContain("Prow reads job config from acme/test-infra");
    // A second init rewrites the file it wrote.
    await expect(init(dir, { binary: "tofu" })).resolves.toBeDefined();
  });

  it("takes away the workflow an earlier init wrote", async () => {
    const dir = twoRootRepo();
    git(dir, "init", "-q", "-b", "main");
    git(dir, "remote", "add", "origin", "https://github.com/acme/infra.git");
    await init(dir, { binary: "tofu" });
    expect(existsSync(join(dir, ".github/workflows/terragucci.yml"))).toBe(true);
    writeFileSync(join(dir, "terragucci.yml"), config);
    await init(dir, { binary: "tofu" });
    expect(existsSync(join(dir, ".github/workflows/terragucci.yml"))).toBe(false);
    expect(existsSync(join(dir, "prow/terragucci.yaml"))).toBe(true);
  });

  it("refuses a repository it cannot name, and a GitLab one", async () => {
    const dir = twoRootRepo();
    write(dir, { "terragucci.yml": config });
    await expect(init(dir, { binary: "tofu", forge: "github", dryRun: true })).rejects.toThrow("neither url in terragucci.yml nor the origin remote names it");
    await expect(init(repoWith(config, "git@gitlab.com:acme/infra.git"), { binary: "tofu", dryRun: true })).rejects.toThrow("runtime: prow serves GitHub repositories");
  });

  it("gives config identities each stage's pod service account", async () => {
    const dir = repoWith(config.replace("trusted_cluster: trusted", "trusted_cluster: trusted\n  namespace: test-pods") + 'drift: "0 6 * * *"\n');
    const c = await configIdentities(join(dir, "terragucci.yml"), "terragucci.yml", {});
    const stages = c.environments[0]!.stages;
    expect(stages.plan!.pod).toEqual({ cluster: "trusted", namespace: "test-pods", service_account: "tf-plan", subject: "system:serviceaccount:test-pods:tf-plan", gke_member: "serviceAccount:<project>.svc.id.goog[test-pods/tf-plan]", trusts: ["plan", "drift"] });
    expect(stages.apply!.pod?.service_account).toBe("tf-apply");
    expect(stages.apply!.aws).toBeNull();
  });
});

describe("approval: prow-labels", () => {
  it("reads who stands behind the labels from /lgtm and /approve, the latest of each person's", () => {
    expect(labelApprovers([
      { author: "ann", body: "/lgtm" },
      { author: "bob", body: "looks fine\n/approve" },
      { author: "cat", body: "/lgtm\n/approve" },
      { author: "cat", body: "/lgtm cancel\n/approve cancel" },
      { author: "dan", body: "please /lgtm this" },
    ])).toEqual(["ann", "bob"]);
  });

  const github = (labels: string[], notes: { body: string; user: string }[], head = "h".repeat(40)) => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      const body = /\/commits\/[^/]+\/pulls(\?|$)/.test(url)
        ? [{ number: 7, merged_at: "2026-01-01T00:00:00Z", base: { ref: "main" } }]
        : url.includes("/labels")
          ? labels.map((name) => ({ name }))
          : url.includes("/issues/7/comments")
            ? notes.map((n, i) => ({ id: i + 1, body: n.body, user: { login: n.user, id: i + 10 } }))
            : /\/pulls\/7(\?|$)/.test(url)
              ? { number: 7, state: "closed", merged_at: "2026-01-01T00:00:00Z", title: "t", body: "", head: { ref: "change", sha: head, repo: { full_name: "acme/infra" } }, base: { ref: "main", repo: { full_name: "acme/infra" } }, user: { login: "author" }, merge_commit_sha: "m".repeat(40) }
              : [];
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } };
    };
    return { fetch, calls };
  };
  const env = { GITHUB_REPOSITORY: "acme/infra", GITHUB_API_URL: "https://api.github.com", GITHUB_TOKEN: "t" };
  const note = (digest: string) => `plan\n${noteMarker({ head: "h".repeat(40), waves: [{ number: 1, digest, waits: true }] })}`;

  it("approves a wave the note showed with the same plans, from people with no hand in the change", async () => {
    const { fetch } = github(["lgtm", "approved"], [{ user: "bot", body: note("sha256:abc") }, { user: "rev", body: "/lgtm" }, { user: "author", body: "/approve" }]);
    const r = await labelWave({ env, fetch: fetch as never, sha: "m".repeat(40), wave: 1, digest: "sha256:abc", involved: { people: [{ who: "author", why: "author opened the pull request" }], notes: [] } });
    expect(r).toMatchObject({ kind: "approved", pr: 7, by: ["rev"], excluded: [{ login: "author" }] });
  });

  it("leaves the wave waiting when a label is missing, when nobody counts, and when the plans moved", async () => {
    const env2 = env;
    const missing = await labelWave({ env: env2, fetch: github(["lgtm"], [{ user: "rev", body: "/lgtm" }]).fetch as never, sha: "m".repeat(40), wave: 1, digest: "sha256:abc" });
    expect(missing).toMatchObject({ kind: "none", why: "pull request 7 has no approved label" });
    const nobody = await labelWave({ env: env2, fetch: github(["lgtm", "approved"], [{ user: "author", body: "/lgtm" }]).fetch as never, sha: "m".repeat(40), wave: 1, digest: "sha256:abc", involved: { people: [{ who: "author", why: "author opened the pull request" }], notes: [] } });
    expect(nobody.kind).toBe("none");
    const moved = await labelWave({ env: env2, fetch: github(["lgtm", "approved"], [{ user: "bot", body: note("sha256:old") }, { user: "rev", body: "/approve" }]).fetch as never, sha: "m".repeat(40), wave: 1, digest: "sha256:new" });
    expect(moved).toMatchObject({ kind: "moved", reviewed: "sha256:old" });
  });
});

// Prow's own loader and its ProwJob conversion, from sigs.k8s.io/prow at the version fixtures/prow/check/go.mod pins.
// It runs where that module is already in Go's module cache, so a test run never downloads it.
const CHECK = join(FIXTURES, "check");
const offline = { ...process.env, GOFLAGS: "-mod=mod", GOPROXY: "off", GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? "auto" };
const prowCached = ((): boolean => {
  if (spawnSync("go", ["version"], { encoding: "utf-8" }).status !== 0) return false;
  return spawnSync("go", ["list", "-m", "-f", "{{.Dir}}", "sigs.k8s.io/prow"], { cwd: CHECK, env: offline, encoding: "utf-8" }).status === 0;
})();

describe.skipIf(!prowCached)("Prow's own config loader", () => {
  const load = (jobs: string): { status: number | null; out: string; err: string } => {
    const dir = tmp("terragucci-prow-");
    const file = join(dir, "jobs.yaml");
    writeFileSync(file, jobs);
    const r = spawnSync("go", ["run", ".", PROW_CONFIG, file], { cwd: CHECK, env: offline, encoding: "utf-8", timeout: 600_000 });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };

  it("loads every job strictly and makes the ProwJobs Prow would create", () => {
    const r = load(renderProwJobs(input({ drift: "0 6 * * *", prow: { ...PROW, plan_before_merge: true, namespace: "test-pods", deck: "https://prow.example.com" } })).content);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    const jobs = r.out.trim().split("\n").map((l) => JSON.parse(l) as { spec: { job: string; type: string; cluster: string } });
    expect(jobs.map((j) => `${j.spec.type} ${j.spec.job} ${j.spec.cluster}`).sort()).toEqual([
      "periodic terragucci-drift trusted",
      "postsubmit terragucci-apply trusted",
      "postsubmit terragucci-plan trusted",
      "presubmit terragucci-check untrusted",
      "presubmit terragucci-plan trusted",
    ]);
  }, 600_000);

  it("refuses a field Prow does not know", () => {
    const r = load(renderProwJobs(input()).content.replace("always_run: true", "always_run: true\n      run_always: true"));
    expect(r.status).toBe(1);
    expect(r.err).toContain("unknown field");
  }, 600_000);
});

// The ProwJobs against Prow's CRD on a scratch k3d cluster this test makes and deletes: TG_PROW_K3D=1, k3d and Docker.
const k3d = process.env.TG_PROW_K3D === "1" && prowCached && spawnSync("k3d", ["version"]).status === 0 && spawnSync("docker", ["info"]).status === 0;

describe.skipIf(!k3d)("the ProwJobs on a scratch k3d cluster", () => {
  it("are ProwJobs the API server takes under Prow's CRD", () => {
    const name = `tg-prow-${process.pid}`;
    const kubeconfig = join(tmp("terragucci-k3d-"), "kubeconfig");
    const kube = { ...process.env, KUBECONFIG: kubeconfig };
    const crd = join(execFileSync("go", ["list", "-m", "-f", "{{.Dir}}", "sigs.k8s.io/prow"], { cwd: CHECK, env: offline, encoding: "utf-8" }).trim(), "config/prow/cluster/prowjob-crd/prowjob_customresourcedefinition.yaml");
    const dir = tmp("terragucci-prow-");
    writeFileSync(join(dir, "jobs.yaml"), renderProwJobs(input({ drift: "0 6 * * *", prow: { ...PROW, plan_before_merge: true } })).content);
    const made = execFileSync("go", ["run", ".", PROW_CONFIG, join(dir, "jobs.yaml")], { cwd: CHECK, env: offline, encoding: "utf-8" });
    try {
      execFileSync("k3d", ["cluster", "create", name, "--no-lb", "--wait", "--kubeconfig-update-default=false", "--kubeconfig-switch-context=false"], { stdio: "ignore", timeout: 300_000 });
      writeFileSync(kubeconfig, execFileSync("k3d", ["kubeconfig", "get", name], { encoding: "utf-8" }));
      execFileSync("kubectl", ["apply", "--server-side", "-f", crd], { env: kube, stdio: "ignore" });
      execFileSync("kubectl", ["wait", "--for=condition=Established", "crd/prowjobs.prow.k8s.io", "--timeout=60s"], { env: kube, stdio: "ignore" });
      execFileSync("kubectl", ["create", "namespace", "prow"], { env: kube, stdio: "ignore" });
      for (const line of made.trim().split("\n")) {
        const r = spawnSync("kubectl", ["create", "--dry-run=server", "--validate=strict", "-f", "-"], { env: kube, input: line, encoding: "utf-8" });
        expect({ out: r.stdout.trim(), err: r.stderr.trim(), status: r.status }).toMatchObject({ err: "", status: 0 });
      }
      // The server refuses a ProwJob with a field the CRD does not name.
      const bad = JSON.parse(made.trim().split("\n")[0]!) as { spec: Record<string, unknown> };
      bad.spec.bogus = true;
      expect(spawnSync("kubectl", ["create", "--dry-run=server", "--validate=strict", "-f", "-"], { env: kube, input: JSON.stringify(bad), encoding: "utf-8" }).status).not.toBe(0);
    } finally {
      spawnSync("k3d", ["cluster", "delete", name], { stdio: "ignore" });
    }
  }, 900_000);
});
