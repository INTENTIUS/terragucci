import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { describeImport, importConfig } from "../src/import";
import { SCALE_TABLE } from "../src/import/guide";
import { convertTerragruntScale, parseHcl, unitGlobs, type ScaleInput } from "../src/import/terragrunt-scale";
import { authProviderOutput, ROLES_ENV, rolesFor } from "../src/terragrunt";
import { tmp, write } from "./helpers";

const GUIDE = join(__dirname, "../../../docs-site/src/content/docs/guides/use-terragrunt.mdx");

function pageTable(header: string): string[][] {
  const lines = readFileSync(GUIDE, "utf-8").split("\n");
  const at = lines.findIndex((l) => l.startsWith(header));
  expect(at, `the guide has a table starting ${header}`).toBeGreaterThan(-1);
  const rows: string[][] = [];
  for (const l of lines.slice(at + 2)) {
    if (!l.startsWith("|")) break;
    rows.push(l.trim().slice(1, -1).split("|").map((c) => c.trim()));
  }
  return rows;
}

const arn = (acct: string, role: string) => `arn:aws:iam::${acct}:role/${role}`;

/** Gruntwork's documented shape: accounts.yml read by the aws block, one environment per account. */
const ENVIRONMENTS = `
# .gruntwork/environments.hcl
environment "dev" {
  filter {
    paths = ["live/dev/*"]
  }
  authentication {
    aws_oidc {
      account_id         = aws.accounts.all.dev.id
      plan_iam_role_arn  = "arn:aws:iam::\${aws.accounts.all.dev.id}:role/pipelines-plan"
      apply_iam_role_arn = "arn:aws:iam::\${aws.accounts.all.dev.id}:role/pipelines-apply"
    }
  }
}

environment "prod" {
  filter {
    paths = ["live/prod/*"]
  }
  authentication {
    aws_oidc {
      account_id         = "222222222222"
      plan_iam_role_arn  = "arn:aws:iam::222222222222:role/pipelines-plan"
      apply_iam_role_arn = "arn:aws:iam::222222222222:role/pipelines-apply"
    }
  }
}
`;
const AWS = `aws {\n  accounts "all" {\n    path = "accounts.yml"\n  }\n}\n`;
const ACCOUNTS = `"dev":\n  "email": "dev@example.com"\n  "id": "111111111111"\n`;

const input = (over: Partial<ScaleInput> = {}): ScaleInput => ({
  global: [
    { path: ".gruntwork/aws.hcl", text: AWS },
    { path: ".gruntwork/environments.hcl", text: ENVIRONMENTS },
  ],
  units: [],
  read: (p) => (p === "accounts.yml" ? ACCOUNTS : undefined),
  ...over,
});

describe("the guide's Terragrunt Scale table", () => {
  it("is guide.ts's, cell for cell", () => {
    expect(pageTable("| Setting | Terragrunt Scale |")).toEqual(SCALE_TABLE.map((r) => [...r]));
  });
});

describe("the HCL reader", () => {
  it("reads blocks, labels, lists, references and interpolations", () => {
    const b = parseHcl(ENVIRONMENTS);
    expect(b.blocks.map((x) => [x.type, x.labels])).toEqual([["environment", ["dev"]], ["environment", ["prod"]]]);
    const oidc = b.blocks[0].blocks[1].blocks[0];
    expect(oidc.type).toBe("aws_oidc");
    expect(oidc.attrs.get("account_id")).toEqual({ t: "ref", path: ["aws", "accounts", "all", "dev", "id"] });
    expect(oidc.attrs.get("plan_iam_role_arn")).toEqual({ t: "str", parts: ["arn:aws:iam::", { t: "ref", path: ["aws", "accounts", "all", "dev", "id"] }, ":role/pipelines-plan"] });
  });

  it("keeps a function call or an operator as raw text, and skips comments", () => {
    const b = parseHcl(`/* c */\na = upper("x") // c\nb = 1 + 2\nc = { k = "v", "q" = [true, null] }\n`);
    expect(b.attrs.get("a")).toEqual({ t: "raw", text: 'upper("x")' });
    expect(b.attrs.get("b")).toEqual({ t: "raw", text: "1 + 2" });
    expect(b.attrs.get("c")).toEqual({ t: "obj", entries: [["k", { t: "str", parts: ["v"] }], ["q", { t: "list", items: [{ t: "lit", v: true }, { t: "lit", v: null }] }]] });
  });

  it("refuses text that is not HCL", () => {
    expect(() => parseHcl(`environment "x" {\n`)).toThrow(/no closing/);
  });
});

describe("filter paths", () => {
  it("cover the units under each directory they match", () => {
    expect(unitGlobs("live/prod/*")).toEqual(["live/prod/**"]);
    expect(unitGlobs("./live/prod")).toEqual(["live/prod", "live/prod/**"]);
    expect(unitGlobs("live/prod-*")).toEqual(["live/prod-*", "live/prod-*/**"]);
    expect(unitGlobs("live/**")).toEqual(["live/**"]);
    expect(unitGlobs("../x")).toBeUndefined();
  });
});

describe("convertTerragruntScale", () => {
  it("keeps each environment's role pair as terragrunt.credentials, reading account ids from accounts.yml", () => {
    const r = convertTerragruntScale(input());
    expect(r.settings).toEqual({
      terragrunt: {
        credentials: {
          "live/dev/**": { plan: arn("111111111111", "pipelines-plan"), apply: arn("111111111111", "pipelines-apply") },
          "live/prod/**": { plan: arn("222222222222", "pipelines-plan"), apply: arn("222222222222", "pipelines-apply") },
        },
      },
    });
    expect(r.notes.find((n) => n.key === ".gruntwork/environments.hcl: environment.dev.authentication.aws_oidc")).toMatchObject({ kind: "mapped", row: "Roles" });
    expect(r.notes.find((n) => n.key === ".gruntwork/aws.hcl: aws.accounts.all")).toMatchObject({ kind: "default", detail: "read accounts.yml" });
  });

  it("lists a unit's own roles first, by its path", () => {
    const unit = `unit {\n  authentication {\n    aws_oidc {\n      account_id = "333333333333"\n      plan_iam_role_arn = "${arn("333333333333", "p")}"\n      apply_iam_role_arn = "${arn("333333333333", "a")}"\n    }\n  }\n}\n`;
    const r = convertTerragruntScale(input({ units: [{ unit: "live/prod/payments", file: { path: "live/prod/payments/gruntwork.hcl", text: unit } }] }));
    expect(Object.keys(r.settings.terragrunt!.credentials!)).toEqual(["live/prod/payments", "live/dev/**", "live/prod/**"]);
    expect(r.settings.terragrunt!.credentials!["live/prod/payments"]).toEqual({ plan: arn("333333333333", "p"), apply: arn("333333333333", "a") });
  });

  it("reads accounts.yml from .gruntwork when the path climbs out of it", () => {
    const r = convertTerragruntScale(input({ global: [{ path: ".gruntwork/aws.hcl", text: AWS.replace('"accounts.yml"', '"../accounts.yml"') }, { path: ".gruntwork/environments.hcl", text: ENVIRONMENTS }] }));
    expect(r.settings.terragrunt!.credentials!["live/dev/**"].plan).toBe(arn("111111111111", "pipelines-plan"));
  });

  it("names a role it cannot evaluate, a missing accounts file, and a shared plan and apply role, and writes none of them", () => {
    const text = `environment "a" {\n  filter {\n    paths = ["a/*"]\n  }\n  authentication {\n    aws_oidc {\n      account_id = "1"\n      plan_iam_role_arn = format("arn:%s", local.x)\n      apply_iam_role_arn = "arn:aws:iam::1:role/apply"\n    }\n  }\n}\nenvironment "b" {\n  filter {\n    paths = ["b/*"]\n  }\n  authentication {\n    aws_oidc {\n      account_id = "1"\n      plan_iam_role_arn = "arn:aws:iam::1:role/same"\n      apply_iam_role_arn = "arn:aws:iam::1:role/same"\n    }\n  }\n}\n`;
    const r = convertTerragruntScale(input({ global: [{ path: ".gruntwork/aws.hcl", text: AWS }, { path: ".gruntwork/e.hcl", text }], read: () => undefined }));
    expect(r.settings).toEqual({});
    const unmapped = r.notes.filter((n) => n.kind === "unmapped").map((n) => `${n.key}: ${n.detail}`);
    expect(unmapped).toContainEqual(expect.stringMatching(/environment\.a\.authentication\.aws_oidc: plan_iam_role_arn = format\("arn:%s", local\.x\): only Pipelines/));
    expect(unmapped).toContainEqual(expect.stringMatching(/environment\.b\.authentication\.aws_oidc: plan and apply are both/));
    expect(unmapped).toContainEqual(expect.stringMatching(/aws\.accounts\.all\.path: accounts\.yml is not in the repo/));
  });

  it("names other clouds, empty authentication and other settings, and maps tf_binary", () => {
    const text = `repository {\n  tf_binary = "terraform"\n  deploy_branch_name = "main"\n  env {\n    A = "1"\n  }\n}\nannotation "core" {\n  filter {\n    paths = ["x/*"]\n  }\n  labels = { team = "p" }\n}\nenvironment "g" {\n  filter {\n    paths = ["g/*"]\n  }\n  authentication {\n    gcp_oidc {\n      workload_identity_provider_id = "x"\n    }\n  }\n}\nenvironment "self" {\n  filter {\n    paths = ["self/*"]\n  }\n  authentication {}\n}\nwidget {}\n`;
    const r = convertTerragruntScale(input({ global: [{ path: ".gruntwork/x.hcl", text }] }));
    expect(r.settings).toEqual({ binary: "terraform" });
    const kinds = Object.fromEntries(r.notes.map((n) => [n.key, `${n.kind} ${n.row}`]));
    expect(kinds).toMatchObject({
      ".gruntwork/x.hcl: repository.tf_binary": "mapped Binary",
      ".gruntwork/x.hcl: repository.deploy_branch_name": "unmapped Other settings",
      ".gruntwork/x.hcl: repository.env": "unmapped Other settings",
      ".gruntwork/x.hcl: annotation.core": "unmapped Other settings",
      ".gruntwork/x.hcl: environment.g.authentication.gcp_oidc": "unmapped Other clouds",
      ".gruntwork/x.hcl: environment.self.authentication": "default No authentication",
      ".gruntwork/x.hcl: widget": "unmapped ",
    });
    expect(r.notes.find((n) => n.key === ".gruntwork/x.hcl: widget")!.text).toMatch(/use-terragrunt\/#terragrunt-scale/);
  });

  it("names a unit's empty authentication, which no glob can say", () => {
    const r = convertTerragruntScale(input({ units: [{ unit: "live/prod/payments", file: { path: "live/prod/payments/gruntwork.hcl", text: "unit {\n  authentication {}\n}\n" } }] }));
    expect(r.notes.find((n) => n.key === "live/prod/payments/gruntwork.hcl: unit.authentication")).toMatchObject({ kind: "unmapped", row: "No authentication" });
  });
});

describe("importConfig terragrunt-scale", () => {
  const repo = (): string => {
    const dir = tmp();
    write(dir, {
      "root.hcl": "",
      "live/dev/orders/terragrunt.hcl": "",
      "live/prod/orders/terragrunt.hcl": "",
      "live/prod/payments/terragrunt.hcl": "",
      "live/prod/payments/gruntwork.hcl": `unit {\n  authentication {\n    aws_oidc {\n      account_id = "222222222222"\n      plan_iam_role_arn = "${arn("222222222222", "payments-plan")}"\n      apply_iam_role_arn = "${arn("222222222222", "payments-apply")}"\n    }\n  }\n}\n`,
      ".gruntwork/aws.hcl": AWS,
      ".gruntwork/environments.hcl": ENVIRONMENTS + `environment "stage" {\n  filter {\n    paths = ["live/stage/*"]\n  }\n  authentication {\n    aws_oidc {\n      account_id = "4"\n      plan_iam_role_arn = "arn:aws:iam::4:role/p"\n      apply_iam_role_arn = "arn:aws:iam::4:role/a"\n    }\n  }\n}\n`,
      "accounts.yml": ACCOUNTS,
    });
    return dir;
  };

  it("writes terragucci.yml that config check takes, and each unit's auth provider gets its environment's role", async () => {
    const dir = repo();
    const r = importConfig(dir, "terragrunt-scale");
    expect(r.wrote).toBe("terragucci.yml");
    expect(r.from).toBe(".gruntwork");
    expect(r.missing).toEqual(["live/stage/**"]);
    const cfg = await loadConfig(join(dir, "terragucci.yml"));
    const creds = cfg.terragrunt!.credentials!;
    const token = join(dir, "token");
    write(dir, { token: "t" });
    for (const [unit, want] of [
      ["live/dev/orders", arn("111111111111", "pipelines-plan")],
      ["live/prod/orders", arn("222222222222", "pipelines-plan")],
      ["live/prod/payments", arn("222222222222", "payments-plan")],
    ] as const) {
      const out = authProviderOutput(join(dir, unit), { TERRAGUCCI_REPO: dir, [ROLES_ENV]: JSON.stringify(rolesFor(creds, "plan")), AWS_WEB_IDENTITY_TOKEN_FILE: token });
      expect((out.awsRole as { roleARN: string }).roleARN, unit).toBe(want);
    }
    const text = describeImport(r);
    expect(text).toContain("No unit matches live/stage/**; check those filter paths.");
    expect(text).toContain("use-terragrunt/#terragrunt-scale");
  });

  it("refuses a legacy config.yml, a repo with no Terragrunt, and --apply-when", () => {
    const legacy = tmp();
    write(legacy, { "root.hcl": "", ".gruntwork/config.yml": "pipelines: {}\n" });
    expect(() => importConfig(legacy, "terragrunt-scale")).toThrow(/legacy config\.yml, which names no roles/);
    const plain = tmp();
    write(plain, { "main.tf": "", ".gruntwork/e.hcl": ENVIRONMENTS });
    expect(() => importConfig(plain, "terragrunt-scale")).toThrow(/for a Terragrunt repo/);
    expect(() => importConfig(repo(), "terragrunt-scale", { applyWhen: "pull-request" })).toThrow(/no --apply-when/);
    expect(() => importConfig(tmp(), "terragrunt-scale")).toThrow(/reads the \.gruntwork directory/);
  });
});
