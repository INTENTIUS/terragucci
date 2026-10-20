import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRoot } from "../src/check";
import { buildEstate, renderEstateHtml } from "../src/report/estate";
import { runStage } from "../src/report/stage";
import { indexEntry, type IndexEntry } from "../src/report/store";
import { repoTips } from "../src/tips";
import { choudoufuSecretsMessage, liveEstate, liveSecrets, outOfState, secretCounts, storedSecrets, withCounterparts } from "../src/tips/secrets";
import { tmp, write } from "./helpers";

const P = "registry.opentofu.org/hashicorp/aws";

/** A plan whose state holds a database password, an access key's secret, a secret read by a data source, and a null sensitive value. */
const secretPlan = () => ({
  format_version: "1.2",
  planned_values: {
    root_module: {
      resources: [
        { address: "aws_db_instance.main", mode: "managed", type: "aws_db_instance", name: "main", provider_name: P, values: { identifier: "db", password: "hunter22", master_user_secret: [] }, sensitive_values: { password: true, master_user_secret: [] } },
        { address: "aws_iam_access_key.ci", mode: "managed", type: "aws_iam_access_key", name: "ci", provider_name: P, values: { user: "ci", secret: "s3cr3t", ses_smtp_password_v4: null }, sensitive_values: { secret: true, ses_smtp_password_v4: true } },
      ],
      child_modules: [
        {
          address: "module.app",
          resources: [0, 1].map((i) => ({ address: `module.app.aws_db_instance.replica[${i}]`, mode: "managed", type: "aws_db_instance", name: "replica", index: i, provider_name: P, values: { password: "hunter22" }, sensitive_values: { password: true } })),
        },
      ],
    },
  },
  prior_state: {
    values: {
      root_module: {
        resources: [{ address: "data.aws_secretsmanager_secret_version.db", mode: "data", type: "aws_secretsmanager_secret_version", name: "db", provider_name: P, values: { secret_id: "db", secret_string: "{\"p\":\"x\"}" }, sensitive_values: { secret_string: true } }],
      },
    },
  },
  resource_changes: [],
});

/** The provider schema: aws_db_instance has password_wo, and the secret version is an ephemeral resource too. */
const schema = (withWriteOnly = true) => ({
  format_version: "1.0",
  provider_schemas: {
    [P]: {
      resource_schemas: {
        aws_db_instance: { block: { attributes: { password: { type: "string", sensitive: true, optional: true }, ...(withWriteOnly ? { password_wo: { type: "string", sensitive: true, optional: true, write_only: true }, password_wo_version: { type: "number", optional: true } } : {}) } } },
        aws_iam_access_key: { block: { attributes: { secret: { type: "string", sensitive: true, computed: true } } } },
      },
      ...(withWriteOnly ? { ephemeral_resource_schemas: { aws_secretsmanager_secret_version: { block: { attributes: {} } } } } : {}),
    },
  },
});

describe("storedSecrets: the sensitive attributes a plan leaves in state", () => {
  it("names each set sensitive attribute once per resource, counting its instances, and reads data sources from the prior state", () => {
    expect(storedSecrets(secretPlan()).map((s) => [s.address, s.attribute, s.instances])).toEqual([
      ["aws_db_instance.main", "password", 1],
      ["aws_iam_access_key.ci", "secret", 1],
      ["data.aws_secretsmanager_secret_version.db", "secret_string", 1],
      ["module.app.aws_db_instance.replica", "password", 2],
    ]);
  });

  it("reads no value into what it returns", () => {
    expect(JSON.stringify(storedSecrets(secretPlan()))).not.toMatch(/hunter22|s3cr3t/);
  });

  it("finds nothing in a plan with no sensitive values", () => {
    expect(storedSecrets({ planned_values: { root_module: { resources: [{ address: "a.b", mode: "managed", type: "a", values: { x: "1" }, sensitive_values: {} }] } } })).toEqual([]);
    expect(storedSecrets(undefined)).toEqual([]);
  });
});

describe("outOfState: what the binary has", () => {
  it("has write-only arguments from tofu and terraform 1.11, and ephemeral resources from tofu 1.11 and terraform 1.10", () => {
    expect(outOfState({ name: "tofu", version: "1.11.0" })).toEqual({ writeOnly: true, ephemeral: true });
    expect(outOfState({ name: "tofu", version: "1.10.6" })).toEqual({ writeOnly: false, ephemeral: false });
    expect(outOfState({ name: "terraform", version: "1.10.5" })).toEqual({ writeOnly: false, ephemeral: true });
    expect(outOfState({ name: "terraform", version: "1.14.9" })).toEqual({ writeOnly: true, ephemeral: true });
    expect(outOfState({ name: "choudoufu", version: "0.28.0" })).toEqual({ writeOnly: true, ephemeral: true });
    expect(outOfState({ name: "tofu" })).toEqual({ writeOnly: false, ephemeral: false });
  });
});

describe("withCounterparts: what the provider schema offers", () => {
  const all = { writeOnly: true, ephemeral: true };
  it("names the write-only argument and its version, and the ephemeral resource", () => {
    const s = withCounterparts(storedSecrets(secretPlan()), schema(), all);
    expect(s.map((x) => x.counterpart)).toEqual([{ kind: "write-only", argument: "password_wo", version: "password_wo_version" }, undefined, { kind: "ephemeral", type: "aws_secretsmanager_secret_version" }, { kind: "write-only", argument: "password_wo", version: "password_wo_version" }]);
    expect(secretCounts(s)).toEqual({ in_state: 5, movable: 4 });
  });

  it("names none on a provider version without them, or a binary without them", () => {
    expect(withCounterparts(storedSecrets(secretPlan()), schema(false), all).filter((x) => x.counterpart)).toEqual([]);
    expect(withCounterparts(storedSecrets(secretPlan()), schema(), { writeOnly: false, ephemeral: false }).filter((x) => x.counterpart)).toEqual([]);
    expect(withCounterparts(storedSecrets(secretPlan()), schema(), { writeOnly: false, ephemeral: true }).map((x) => x.counterpart?.kind)).toEqual([undefined, undefined, "ephemeral", undefined]);
  });
});

/** A tofu of `version` that shows each root's plan.json and prints `schema.json` for providers schema, logging each call. */
function fakeTofu(dir: string, version: string): string {
  const path = join(dir, "tofu");
  writeFileSync(path, `#!/bin/sh
case "$1" in version) echo '{"terraform_version":"${version}"}'; exit 0 ;; esac
chdir="\${1#-chdir=}"; shift
echo "$*" >> "${join(dir, "calls")}"
case "$1" in
  init) exit 0 ;;
  plan) for a in "$@"; do case "$a" in -out=*) : > "\${a#-out=}" ;; esac; done; exit 0 ;;
  show) if [ "$2" = "-json" ]; then cat "$chdir/plan.json"; else echo "plan text"; fi ;;
  providers) cat "$chdir/schema.json" ;;
esac
`);
  chmodSync(path, 0o755);
  return path;
}

describe("stage tf-plan: the secret-in-state tip", () => {
  const plan = async (version: string, providerSchema: unknown, tips = true) => {
    const repo = write(tmp(), { "terragucci.yml": `roots: ["app"]\ntips: ${tips}\n`, "app/main.tf": "", "app/plan.json": JSON.stringify(secretPlan()), "app/schema.json": JSON.stringify(providerSchema) });
    const bin = tmp();
    const { report } = await runStage("tf-plan", repo, { binary: fakeTofu(bin, version), env: { PATH: process.env.PATH } }, () => {});
    let calls = "";
    try {
      calls = readFileSync(join(bin, "calls"), "utf-8");
    } catch {
      // No call was logged.
    }
    return { report, calls, tips: (report.tips ?? []).filter((t) => t.rule === "terragucci-secret-in-state") };
  };

  it("names the address, the attribute and the write-only argument or ephemeral resource, and counts them on the root", { timeout: 60_000 }, async () => {
    const { report, tips } = await plan("1.11.0", schema());
    expect(tips.map((t) => t.root)).toEqual(["app", "app", "app"]);
    expect(tips[0]!.url).toBe("https://intentius.io/terragucci/reference/tips/#terragucci-secret-in-state");
    expect(tips[0]!.message).toContain("aws_db_instance.main keeps its sensitive password in state");
    expect(tips[0]!.message).toContain("tofu 1.11.0, hashicorp/aws's aws_db_instance has the write-only argument password_wo: set it in place of password, with password_wo_version");
    expect(tips[1]!.message).toContain(`read it as ephemeral "aws_secretsmanager_secret_version"`);
    expect(tips[2]!.message).toContain("module.app.aws_db_instance.replica keeps its sensitive password in state (2 instances)");
    expect(tips.map((t) => t.message).join("\n")).not.toMatch(/hunter22|s3cr3t|aws_iam_access_key/);
    expect(report.roots[0]!.secrets).toEqual({ in_state: 5, movable: 4 });
    expect(indexEntry(report, "run").secrets).toEqual([{ root: "app", in_state: 5, movable: 4 }]);
  });

  it("gives no tip on a binary or a provider version without the counterpart, and still counts what is in state", { timeout: 60_000 }, async () => {
    const old = await plan("1.10.6", schema());
    expect(old.tips).toEqual([]);
    expect(old.calls).not.toContain("providers schema");
    expect(old.report.roots[0]!.secrets).toEqual({ in_state: 5, movable: 0 });
    const plain = await plan("1.11.0", schema(false));
    expect(plain.tips).toEqual([]);
    expect(plain.calls).toContain("providers schema -json");
    expect(plain.report.roots[0]!.secrets).toEqual({ in_state: 5, movable: 0 });
  });

  it("leaves the tip out with tips: false", { timeout: 60_000 }, async () => {
    expect((await plan("1.11.0", schema(), false)).tips).toEqual([]);
  });

  it("records a choudoufu root's estate, and leaves an estate under secrets = \"refuse\" to choudoufu", { timeout: 60_000 }, async () => {
    for (const strict of ["", `    strict {\n      secrets = "refuse"\n    }\n`]) {
      const repo = write(tmp(), { "terragucci.yml": `roots: ["app"]\n`, "app/main.tf": LIVE(strict), "app/plan.json": JSON.stringify(secretPlan()), "app/schema.json": JSON.stringify(schema()) });
      const { report } = await runStage("tf-plan", repo, { binary: fakeTofu(tmp(), "1.11.0"), env: { PATH: process.env.PATH } }, () => {});
      const setting = strict ? "refuse" : "store";
      expect(report.roots[0]!.live).toEqual({ estate: "prod", record_store: "s3://acme-records/tofu-records/prod/", secrets: setting });
      expect(indexEntry(report, "run").estates).toEqual([{ root: "app", estate: "prod", record_store: "s3://acme-records/tofu-records/prod/", secrets: setting }]);
      const rules = (report.tips ?? []).map((t) => t.rule);
      expect(rules.includes("terragucci-choudoufu-secrets")).toBe(!strict);
      expect(rules.includes("terragucci-secret-in-state")).toBe(!strict);
      expect(report.roots[0]!.secrets).toEqual(strict ? undefined : { in_state: 5, movable: 4 });
    }
  });
});

const LIVE = (strict = "") => `terraform {
  live {
    estate = "prod"
    record_store "s3" {
      bucket = "acme-records"
    }
${strict}  }
}
`;

describe("the choudoufu-secrets tip", () => {
  it("is given for a live block that does not set secrets = \"refuse\", and not for one that does", () => {
    const repo = write(tmp(), {
      "none/main.tf": LIVE(),
      "store/main.tf": LIVE(`    strict {\n      secrets = "store"\n    }\n`),
      "refuse/main.tf": LIVE(`    strict {\n      marker_repair = "repair"\n      secrets       = "refuse" # no secret values in the records\n    }\n`),
      "sidecar/estate.chdf.hcl": `estate = "side"\nstrict {\n  secrets = "refuse"\n}\n`,
      "plain/main.tf": `terraform {\n  backend "s3" {}\n}\n`,
    });
    expect(choudoufuSecretsMessage(repo, "none")).toContain(`does not set strict { secrets }, whose default is "store"`);
    expect(choudoufuSecretsMessage(repo, "none")).toContain(`Add strict { secrets = "refuse" } to the live block`);
    expect(choudoufuSecretsMessage(repo, "store")).toContain(`sets secrets = "store"`);
    expect(choudoufuSecretsMessage(repo, "refuse")).toBeUndefined();
    expect(choudoufuSecretsMessage(repo, "sidecar")).toBeUndefined();
    expect(choudoufuSecretsMessage(repo, "plain")).toBeUndefined();
    // CHOUDOUFU_STRICT_PIN=1 refuses for an estate that sets nothing.
    expect(choudoufuSecretsMessage(repo, "none", { CHOUDOUFU_STRICT_PIN: "1" })).toBeUndefined();
    expect(choudoufuSecretsMessage(repo, "store", { CHOUDOUFU_STRICT_PIN: "1" })).toBeDefined();
    expect(liveSecrets(join(repo, "refuse"))).toEqual({ setting: "refuse", written: true });
    expect(liveEstate(join(repo, "none"))).toEqual({ estate: "prod", record_store: "s3://acme-records/tofu-records/prod/", secrets: "store" });
  });

  it("is a tip of the plan for each such root, unless tips are off", async () => {
    const repo = write(tmp(), { "a/main.tf": LIVE(), "b/main.tf": LIVE(`    strict {\n      secrets = "refuse"\n    }\n`) });
    const tips = await repoTips(repo, ["a", "b"], { settings: { gate: "on-destructive", tips: true } });
    expect(tips.filter((t) => t.rule === "terragucci-choudoufu-secrets").map((t) => [t.root, t.url])).toEqual([["a", "https://intentius.io/terragucci/reference/tips/#terragucci-choudoufu-secrets"]]);
    expect(await repoTips(repo, ["a"], { settings: { gate: "on-destructive", tips: false } })).toEqual([]);
  });

  it("is in the tf-check log and check report, with the block to add, and fails nothing", async () => {
    const repo = write(tmp(), { "a/main.tf": LIVE(), "b/main.tf": LIVE(`    strict {\n      secrets = "refuse"\n    }\n`) });
    const exec = async (_b: string, args: string[]) => (args.includes("validate") ? { status: 0, stdout: JSON.stringify({ valid: true, diagnostics: [] }), stderr: "" } : { status: 0, stdout: JSON.stringify({ blocked: false, refusals: [] }), stderr: "" });
    const a = await checkRoot("choudoufu", "a", repo, { exec, env: {} });
    expect(a.ok).toBe(true);
    expect(a.log.find((l) => l.startsWith("tip (terragucci-choudoufu-secrets): a: "))).toBeDefined();
    expect(a.report.join("\n")).toContain(`      secrets = "refuse"`);
    const b = await checkRoot("choudoufu", "b", repo, { exec, env: {} });
    expect(b.log.join("\n")).not.toContain("terragucci-choudoufu-secrets");
    const off = await checkRoot("choudoufu", "a", repo, { exec, env: {}, tips: false });
    expect(off.log.join("\n")).not.toContain("terragucci-choudoufu-secrets");
  });
});

describe("the estate page: secrets in state", () => {
  const row = (o: Partial<IndexEntry> & Pick<IndexEntry, "stage" | "finished">): IndexEntry => ({ project: "p", commit: "c".repeat(40), path: `runs/${o.finished}`, roots: 2, groups: 1, totals: { create: 0, update: 0, replace: 0, delete: 0 }, refused: 0, destroys: [], ...o });

  it("lists each root's secrets in state and each estate's setting beside its record store, from the newest drift check", () => {
    const rows = [
      row({ stage: "tf-plan", finished: "2026-10-07T11:00:00.000Z", pull_request: "7", secrets: [{ root: "db", in_state: 9, movable: 9 }] }),
      row({ stage: "tf-drift", finished: "2026-10-07T04:00:00.000Z", secrets: [{ root: "db", in_state: 3, movable: 1 }], estates: [{ root: "live", estate: "prod", record_store: "s3://acme-records/tofu-records/prod/", secrets: "store" }] }),
    ];
    const page = buildEstate([{ project: "p", base: "p/", reports: rows }], new Date("2026-10-07T12:00:00.000Z"));
    expect(page.projects[0]!.secrets?.run.stage).toBe("tf-drift");
    expect(page.projects[0]!.secrets?.roots).toEqual([
      { root: "db", in_state: 3, movable: 1 },
      { root: "live", estate: "prod", record_store: "s3://acme-records/tofu-records/prod/", secrets: "store" },
    ]);
    const html = renderEstateHtml(page);
    expect(html).toContain(`<h2 id="secrets">Secrets in state</h2>`);
    expect(html).toContain(`<tr data-root="db"><td><code>db</code></td><td>3</td><td><span class="warn">1</span></td>`);
    expect(html).toContain(`<code>s3://acme-records/tofu-records/prod/</code></td><td><span class="warn"><code>store</code></span>`);
  });

  it("says when no run has recorded any", () => {
    const html = renderEstateHtml(buildEstate([{ project: "p", reports: [row({ stage: "tf-plan", finished: "2026-10-07T11:00:00.000Z" })] }]));
    expect(html).toContain("No plan or drift check has recorded a secret in state or a choudoufu estate yet.");
  });
});
