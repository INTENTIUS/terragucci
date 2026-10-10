// The repo's shape: one detector, one refusal table read by config check and
// init alike, and the per-shape answers the commands take from it.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import { resolveRepo } from "../src/config";
import { init } from "../src/init";
import { ATMOS_DRIFT_PR, ATMOS_GENERATE, ATMOS_ROLLOUTS, OIDC_ROLES_NOT_TERRAGRUNT, SYNTH_DRIFT_PR } from "../src/refusals";
import { detectShape } from "../src/shape";
import { tmp, write } from "./helpers";

type Obj = Record<string, unknown>;

const instance = (stack: string, component: string, extra: Obj = {}): Obj => ({
  backend_type: "s3",
  backend: { bucket: "state", key: "terraform.tfstate", region: "us-east-1", workspace_key_prefix: component },
  component,
  component_info: { component_path: `components/terraform/${component}` },
  metadata: {},
  vars: { stage: stack },
  workspace: stack,
  ...extra,
});

/** dev and prod, each with vpc and app, app after vpc. */
function twoStacks(): Obj {
  const out: Obj = {};
  for (const s of ["dev", "prod"]) out[s] = { components: { terraform: { vpc: instance(s, "vpc"), app: instance(s, "app", { dependencies: { components: [{ component: "vpc" }] } }) } } };
  return out;
}

/** An `atmos` that prints `json` for describe stacks. */
export function stubAtmos(json: Obj = twoStacks()): string {
  const dir = tmp("atmos-stub-");
  writeFileSync(join(dir, "describe.json"), JSON.stringify(json));
  const bin = join(dir, "atmos");
  writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "describe stacks" ] || { echo "unexpected: $*" >&2; exit 2; }\ncat ${JSON.stringify(join(dir, "describe.json"))}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

export const ATMOS_REPO = {
  "atmos.yaml": "base_path: .\ncomponents:\n  terraform:\n    base_path: components/terraform\nstacks:\n  base_path: stacks\n",
  "components/terraform/vpc/main.tf": 'variable "stage" {\n  type = string\n}\n',
  "components/terraform/app/main.tf": 'variable "stage" {\n  type = string\n}\n',
};

const TG_REPO = {
  "root.hcl": "",
  "live/vpc/terragrunt.hcl": 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n',
};

const ROLES = 'oidc:\n  roles:\n    "live/**":\n      plan: arn:aws:iam::111111111111:role/dev-plan\n      apply: arn:aws:iam::111111111111:role/dev-apply\n';

/** `terragucci config check --json` in `dir`: its exit code and problems. */
async function configCheck(dir: string): Promise<{ code: number; problems: string[] }> {
  const cwd = process.cwd();
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  process.chdir(dir);
  try {
    const code = await main(["config", "check", "--json"]);
    return { code, problems: (JSON.parse(lines.join("\n")) as { results?: { problems?: string[] } }).results?.problems ?? [] };
  } finally {
    process.chdir(cwd);
    log.mockRestore();
    err.mockRestore();
  }
}

describe("detectShape", () => {
  it("tells the four shapes apart, with the engine and the command each job runs first", () => {
    const plain = detectShape(write(tmp(), { "a/main.tf": 'terraform {\n  backend "local" {}\n}\n' }), resolveRepo({}));
    expect([plain.kind, plain.engine, plain.prepare]).toEqual(["roots", "per-root", undefined]);
    const synth = detectShape(tmp(), resolveRepo({ synth: "npx cdktn synth" }));
    expect([synth.kind, synth.engine, synth.prepare]).toEqual(["synth", "per-root", "npx cdktn synth"]);
    const atmos = detectShape(write(tmp(), ATMOS_REPO), resolveRepo({}));
    expect([atmos.kind, atmos.engine, atmos.prepare, atmos.reason]).toEqual(["atmos", "per-root", "terragucci atmos write", "atmos.yaml"]);
    const tg = detectShape(write(tmp(), TG_REPO), resolveRepo({}));
    expect([tg.kind, tg.engine, tg.prepare, tg.reason]).toEqual(["terragrunt", "terragrunt", undefined, "root.hcl"]);
  });

  it("names a block for a shape the repo is not as a problem, never by throwing", () => {
    const shape = detectShape(tmp(), resolveRepo({ terragrunt: {} }));
    expect(shape.problems()).toEqual(["terragucci.yml has a terragrunt block, but the repo has no root.hcl, terragrunt.hcl or terragrunt.stack.hcl"]);
  });

  it("puts an Atmos instance's edits in its component, once discovery or the write has named it", async () => {
    const repo = write(tmp(), ATMOS_REPO);
    const shape = detectShape(repo, resolveRepo({}));
    expect(shape.sourceOf("dev/vpc")).toBe("dev/vpc");
    await shape.discover({ atmos: stubAtmos() });
    expect(shape.sourceOf("dev/vpc")).toBe("components/terraform/vpc");
    expect(shape.stateAddress("prod/app")).toEqual({ bucket: "state", key: "app/prod/terraform.tfstate" });
  });
});

describe("refusals: config check and init give the same one", () => {
  it("an Atmos repo with a drift schedule: the drift pull request, the default, is refused in Atmos's words at config check and init", async () => {
    const repo = write(tmp(), { ...ATMOS_REPO, "terragucci.yml": 'forge: forgejo\nbinary: tofu\ndrift: "0 6 * * *"\n' });
    const checked = await configCheck(repo);
    expect(checked.code).toBe(2);
    expect(checked.problems).toEqual([`config.respond.drift: ${ATMOS_DRIFT_PR}`]);
    await expect(init(repo, { atmos: stubAtmos(), dryRun: true })).rejects.toThrow(ATMOS_DRIFT_PR);
    expect(ATMOS_DRIFT_PR).not.toMatch(/synth|app that writes/);
    // With the drift issue's response, the drift job is written.
    const attributed = write(tmp(), { ...ATMOS_REPO, "terragucci.yml": 'forge: forgejo\nbinary: tofu\ndrift: "0 6 * * *"\nrespond:\n  drift: attribute\n' });
    expect((await configCheck(attributed)).code).toBe(0);
    const r = await init(attributed, { atmos: stubAtmos(), dryRun: true });
    expect(r.files[0].content).toContain("tf-drift");
  });

  it("an Atmos repo with rollouts or generate is refused in Atmos's words at config check and init", async () => {
    for (const [yml, why] of [
      ['rollouts: "0 6 * * 1"\n', ATMOS_ROLLOUTS],
      ['generate:\n  required_version: "1.10.6"\n', ATMOS_GENERATE],
    ] as const) {
      const repo = write(tmp(), { ...ATMOS_REPO, "terragucci.yml": `forge: forgejo\nbinary: tofu\n${yml}` });
      const checked = await configCheck(repo);
      expect(checked.code, yml).toBe(2);
      expect(checked.problems.join("\n"), yml).toContain(why);
      await expect(init(repo, { atmos: stubAtmos(), dryRun: true }), yml).rejects.toThrow(why);
    }
  });

  it("a synth repo keeps its own words", async () => {
    const repo = write(tmp(), { "terragucci.yml": 'forge: forgejo\nsynth: "true"\ndrift: "0 6 * * *"\n' });
    expect((await configCheck(repo)).problems).toEqual([`config.respond.drift: ${SYNTH_DRIFT_PR}`]);
  });

  it("oidc.roles in a Terragrunt repo found by its markers, with no terragrunt block, is refused at config check and init", async () => {
    const repo = write(tmp(), { ...TG_REPO, "terragucci.yml": `forge: forgejo\nbinary: tofu\n${ROLES}` });
    const checked = await configCheck(repo);
    expect(checked.code).toBe(2);
    expect(checked.problems).toEqual([`config.oidc.roles: ${OIDC_ROLES_NOT_TERRAGRUNT}`]);
    await expect(init(repo, { terragrunt: "/nonexistent/terragrunt", dryRun: true })).rejects.toThrow(OIDC_ROLES_NOT_TERRAGRUNT);
  });
});

describe("init in an Atmos repo with no binary named", () => {
  it("detects the binary from the components, not the instances, which are not written yet", async () => {
    const repo = write(tmp(), { ...ATMOS_REPO, "components/terraform/vpc/versions.tofu": "", "terragucci.yml": "forge: forgejo\n" });
    const r = await init(repo, { atmos: stubAtmos(), dryRun: true });
    expect(r.roots).toEqual(["dev/app", "dev/vpc", "prod/app", "prod/vpc"]);
    expect(r.binary).toEqual({ value: "tofu", reason: ".tofu files" });
  });
});
