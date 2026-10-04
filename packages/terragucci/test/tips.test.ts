import { describe, expect, it } from "vitest";
import { validateConfig, BUILT_IN, type ResolvedSettings } from "../src/config";
import { reconcile, describeReconcile } from "../src/reconcile";
import { buildReport } from "../src/report/build";
import { renderHtml } from "../src/report/html";
import { renderNote } from "../src/report/views";
import { loadHclParser } from "../src/rollout/parser";
import { FEW_ROOTS, HUNDREDS_OF_ROOTS, SHARED_MODULE_ROOTS, repoTips, type TipOptions } from "../src/tips";
import { RUN, smallFixture } from "./report-fixtures";
import { backend, bareFrom, tmp, write } from "./helpers";

const parser = await loadHclParser();
const settings = (over: Partial<ResolvedSettings> & { waves?: { canary: string[] } } = {}): TipOptions["settings"] => ({ ...BUILT_IN, ...over });
const rules = async (repo: string, roots: string[], over: Partial<TipOptions> = {}) =>
  (await repoTips(repo, roots, { settings: settings(), parser, ...over })).map((t) => [t.rule, t.root]);

const PINNED = `terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }
}

resource "aws_s3_bucket" "b" {
  bucket = "b"
}
`;

const BARE = 'terraform {\n  backend "local" {}\n}\n\nresource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n';

describe("code tips come from chant's lint", () => {
  const repo = write(tmp(), {
    "bare/main.tf": BARE,
    "clean/main.tf": PINNED,
    "clean/.terraform.lock.hcl": "# lock\n",
    "modules/main.tf": PINNED + `module "reg" {\n  source = "terraform-aws-modules/vpc/aws"\n}\nmodule "git" {\n  source = "git::https://example.com/x.git"\n}\nmodule "oci" {\n  source = "oci://registry.example.com/acme/net?tag=latest"\n}\n`,
    "modules/.terraform.lock.hcl": "# lock\n",
  });

  it("a bare root gets the provider, version and lock file tips, each naming its rule", async () => {
    expect(await rules(repo, ["bare"])).toEqual([["TF002", "bare"], ["TF003", "bare"], ["TF040", "bare"]]);
    const tips = await repoTips(repo, ["bare"], { settings: settings(), parser });
    expect(tips[0]!.url).toBe("https://intentius.io/chant/lexicons/terraform/lint-rules/#tf002");
    expect(tips[0]!.message).toContain('Provider "aws"');
  });

  it("a root that is set up properly gets none", async () => {
    expect(await rules(repo, ["clean"])).toEqual([]);
  });

  it("unpinned registry, git and oci modules are named by TF004, TF005 and TF038", async () => {
    expect((await rules(repo, ["modules"])).map(([r]) => r)).toEqual(["TF004", "TF005", "TF038"]);
  });

  it("a check left out of the rules takes its tip with it", async () => {
    expect(await rules(repo, ["bare"], { rules: ["TF003", "TF040"] })).toEqual([["TF003", "bare"], ["TF040", "bare"]]);
    expect(await rules(repo, ["bare"], { rules: [] })).toEqual([]);
  });

  it("without the parser the code tips are left out", async () => {
    expect(await rules(repo, ["bare"], { parser: undefined })).toEqual([]);
  });
});

describe("terragucci-shared-module", () => {
  const roots = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`envs/r${i}/main.tf`, PINNED + `module "m" {\n  source = "../../modules/shared"\n}\n`]));
  const lock = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`envs/r${i}/.terraform.lock.hcl`, "#\n"]));
  const names = (n: number) => Array.from({ length: n }, (_, i) => `envs/r${i}`);

  it("fires when many roots include one local module", async () => {
    const repo = write(tmp(), { ...roots(SHARED_MODULE_ROOTS), ...lock(SHARED_MODULE_ROOTS), "modules/shared/main.tf": "variable \"x\" {}\n" });
    expect(await rules(repo, names(SHARED_MODULE_ROOTS))).toEqual([["terragucci-shared-module", "modules/shared"], ["terragucci-no-canary", undefined]]);
  });

  it("stays quiet one root short", async () => {
    const repo = write(tmp(), { ...roots(SHARED_MODULE_ROOTS - 1), ...lock(SHARED_MODULE_ROOTS - 1), "modules/shared/main.tf": "variable \"x\" {}\n" });
    expect((await rules(repo, names(SHARED_MODULE_ROOTS - 1))).map(([r]) => r)).not.toContain("terragucci-shared-module");
  });

  it("counts a module reached through another local module", async () => {
    const repo = write(tmp(), {
      ...Object.fromEntries(names(SHARED_MODULE_ROOTS).map((r) => [`${r}/main.tf`, PINNED + `module "m" {\n  source = "../../modules/wrap"\n}\n`])),
      ...lock(SHARED_MODULE_ROOTS),
      "modules/wrap/main.tf": `module "inner" {\n  source = "../shared"\n}\n`,
      "modules/shared/main.tf": "variable \"x\" {}\n",
    });
    const found = (await rules(repo, names(SHARED_MODULE_ROOTS))).filter(([r]) => r === "terragucci-shared-module").map(([, m]) => m);
    expect(found).toEqual(["modules/shared", "modules/wrap"]);
  });
});

describe("terragucci-floating-range", () => {
  const call = (version: string) => PINNED + `module "vpc" {\n  source  = "terraform-aws-modules/vpc/aws"\n  version = "${version}"\n}\n`;
  const repo = write(tmp(), {
    "range/main.tf": call("~> 5.0"), "range/.terraform.lock.hcl": "#\n",
    "exact/main.tf": call("5.1.0"), "exact/.terraform.lock.hcl": "#\n",
  });

  it("fires on a range chant's rules do not cover, and says what it costs a rollout", async () => {
    const tips = await repoTips(repo, ["range"], { settings: settings(), parser, rules: ["TF004"] });
    expect(tips.map((t) => t.rule)).toEqual(["terragucci-floating-range"]);
    expect(tips[0]!.message).toContain("tf-rollout cannot move it");
  });

  it("gives chant's TF039 alone when it names the same call", async () => {
    expect((await rules(repo, ["range"])).map(([r]) => r)).toEqual(["TF039"]);
  });

  it("stays quiet for an exact version", async () => {
    expect(await rules(repo, ["exact"], { rules: [] })).toEqual([]);
  });

  it("fires on a provider constrained to a range, and not on an exact one", async () => {
    const floating = write(tmp(), {
      "dev/main.tf": PINNED.replace('"6.67.0"', '"~> 6.0"'), "dev/.terraform.lock.hcl": "#\n",
      "prod/main.tf": PINNED, "prod/.terraform.lock.hcl": "#\n",
    });
    const tips = await repoTips(floating, ["dev", "prod"], { settings: settings(), parser });
    expect(tips.map((t) => [t.rule, t.root])).toEqual([["terragucci-floating-range", "dev"]]);
    expect(tips[0]!.message).toContain('Provider aws is constrained to the range "~> 6.0"');
  });
});

describe("terragucci-no-canary", () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);
  const repo = write(tmp(), Object.fromEntries(names(FEW_ROOTS + 1).flatMap((r) => [[`${r}/main.tf`, PINNED], [`${r}/.terraform.lock.hcl`, "#\n"]])));

  it("fires above a few roots with no canary", async () => {
    expect(await rules(repo, names(FEW_ROOTS + 1))).toEqual([["terragucci-no-canary", undefined]]);
  });
  it("stays quiet with a canary, or with few roots", async () => {
    expect(await rules(repo, names(FEW_ROOTS + 1), { settings: settings({ waves: { canary: ["r0"] } }) })).toEqual([]);
    expect(await rules(repo, names(FEW_ROOTS))).toEqual([]);
  });
});

describe("terragucci-ungated-destroy", () => {
  const repo = write(tmp(), { "a/main.tf": PINNED, "a/.terraform.lock.hcl": "#\n", "b/main.tf": PINNED, "b/.terraform.lock.hcl": "#\n" });

  it("fires on the roots that destroy when the gate is never", async () => {
    expect(await rules(repo, ["a", "b"], { settings: settings({ gate: "never" }), destroying: ["b"] })).toEqual([["terragucci-ungated-destroy", "b"]]);
  });
  it("stays quiet with a gate, or with nothing destroyed", async () => {
    expect(await rules(repo, ["a", "b"], { settings: settings({ gate: "on-destroy" }), destroying: ["b"] })).toEqual([]);
    expect(await rules(repo, ["a", "b"], { settings: settings({ gate: "never" }), destroying: [] })).toEqual([]);
  });
});

describe("terragucci-many-roots", () => {
  const repo = write(tmp(), { "a/main.tf": PINNED, "a/.terraform.lock.hcl": "#\n" });
  const base = (planned: number) => rules(repo, ["a"], { planned, settings: settings({ waves: { canary: ["a"] } }) });

  it("fires at a hundred planned roots and not at ninety-nine", async () => {
    expect(await base(HUNDREDS_OF_ROOTS)).toEqual([["terragucci-many-roots", undefined]]);
    expect(await base(HUNDREDS_OF_ROOTS - 1)).toEqual([]);
  });
});

describe("tips: false", () => {
  const repo = write(tmp(), { "bare/main.tf": BARE });

  it("gives no tips at all", async () => {
    expect(await repoTips(repo, ["bare"], { settings: settings({ tips: false }), parser })).toEqual([]);
  });

  it("removes the report section and the note line, and tips never move a digest", async () => {
    const tips = await repoTips(repo, ["bare"], { settings: settings(), parser });
    const base = { run: RUN, roots: smallFixture(), waves: [{ number: 1, roots: ["envs/dev/orders"] }, { number: 2, roots: ["envs/dev/search", "envs/prod/orders"] }] };
    const on = buildReport({ ...base, tips });
    const off = buildReport(base);
    expect(off.tips).toBeUndefined();
    expect(renderHtml(off)).not.toContain('id="tips"');
    expect(renderNote(off)).not.toContain("tip");
    expect(on.tips).toHaveLength(3);
    expect(renderHtml(on)).toContain('id="tips"');
    expect(renderNote(on)).toContain("3 tips on how the roots are set up");
    expect(on.change_set).toBe(off.change_set);
    expect(on.roots.map((r) => r.plan_digest)).toEqual(off.roots.map((r) => r.plan_digest));
    expect(on.waves.map((w) => w.set_digest)).toEqual(off.waves.map((w) => w.set_digest));
  });

  it("the dry run prints tips by default and nothing with tips: false", async () => {
    const control = (tips?: boolean) => {
      const bare = bareFrom(write(tmp(), { "bare/main.tf": backend("bare.tfstate") }));
      return validateConfig({ defaults: { binary: "tofu", ...(tips === undefined ? {} : { tips }) }, projects: { "github.com/acme/infra": { url: bare } } }, "t");
    };
    const on = await reconcile(control(), { mode: "dry-run", env: {} });
    expect(on[0]!.tips!.map((t) => t.rule)).toContain("TF040");
    expect(describeReconcile(on, "dry-run")).toContain("tip (TF040): bare:");
    const off = await reconcile(control(false), { mode: "dry-run", env: {} });
    expect(off[0]!.tips).toBeUndefined();
    expect(describeReconcile(off, "dry-run")).not.toContain("tip (");
  });
});
