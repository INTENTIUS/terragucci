import { describe, expect, it, vi } from "vitest";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { binaryEnv, FORGE_TOKEN_ENV, terragruntExec } from "../src/binary-env";
import { spawnAsync, stateIsEmpty } from "../src/report/stage";
import { defaultPolicyExec } from "../src/report/policy";
import { tmp } from "./helpers";

const TOKENS = { TG_TOKEN: "job-token-1234", TG_MERGE_TOKEN: "merge-token-5678", GITHUB_TOKEN: "gh", GH_TOKEN: "gh2", GITLAB_TOKEN: "job-token-1234", CI_JOB_TOKEN: "ci", FORGEJO_TOKEN: "fj", GITEA_TOKEN: "gt", ACTIONS_RUNTIME_TOKEN: "rt", MY_BOT_TOKEN: "merge-token-5678" };
const forgeFree = (out: string): void => {
  for (const k of Object.keys(TOKENS)) expect(out, k).not.toMatch(new RegExp(`^${k}=`, "m"));
  expect(out).not.toContain("job-token-1234");
  expect(out).not.toContain("merge-token-5678");
};

describe("the binary's environment", () => {
  it("leaves out every forge token, by name and by the value of TG_TOKEN or TG_MERGE_TOKEN, and keeps the rest", () => {
    const env = binaryEnv({ ...TOKENS, PATH: "/bin", AWS_ROLE_ARN: "arn", TF_HTTP_PASSWORD: "job-token-1234", TF_VAR_token: "merge-token-5678" });
    expect(env).toEqual({ PATH: "/bin", AWS_ROLE_ARN: "arn", TF_HTTP_PASSWORD: "job-token-1234", TF_VAR_token: "merge-token-5678" });
    for (const k of FORGE_TOKEN_ENV) expect(env[k]).toBeUndefined();
    // An empty TG_TOKEN takes nothing else with it.
    expect(binaryEnv({ TG_TOKEN: "", HOME: "" })).toEqual({ HOME: "" });
  });

  it("the plan stage's runner, its state check and Terragrunt's runner give the binary none", async () => {
    for (const [k, v] of Object.entries(TOKENS)) vi.stubEnv(k, v);
    try {
      const dir = tmp("tg-binary-env-");
      const bin = join(dir, "tofu");
      writeFileSync(bin, `#!/usr/bin/env bash\nenv >> ${JSON.stringify(join(dir, "seen"))}\nenv\n`);
      chmodSync(bin, 0o755);
      const plan = await spawnAsync(bin, ["plan"], { ...process.env });
      forgeFree(plan.stdout);
      expect(plan.stdout).toMatch(/^PATH=/m);
      stateIsEmpty(bin, dir, { ...process.env });
      const tg = await terragruntExec(bin, ["run", "--all", "--", "plan"], { cwd: dir, env: { TG_TF_PATH: "tofu", TG_TOKEN: "job-token-1234" } });
      forgeFree(tg.stdout);
      expect(tg.stdout).toMatch(/^TG_TF_PATH=tofu$/m);
      const { readFileSync } = await import("node:fs");
      forgeFree(readFileSync(join(dir, "seen"), "utf-8"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("check-root's validate and the policy engine start without the forge tokens", async () => {
    for (const [k, v] of Object.entries(TOKENS)) vi.stubEnv(k, v);
    try {
      const r = await defaultPolicyExec("env", [], tmp());
      expect(r.status).toBe(0);
      forgeFree(r.stdout);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
