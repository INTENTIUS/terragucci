import { describe, expect, it } from "vitest";
import { chantNextParts, overrideChantNext } from "../src/chant-next";
import { consumersOf } from "../src/publish/consumers";
import { moduleForms, providerForms, sourceAllowed } from "../src/sources";

const parts = await chantNextParts();

describe("consumers.json entries (chant#4600)", () => {
  it("groups pinned registry calls by module address and version, leaving unpinned calls out", () => {
    const call = (root: string, module: string, pin: string | null) => ({ root, file: `${root}/main.tf`, address: "module.net", kind: "terraform" as const, source: module, module, pin });
    expect(
      consumersOf([call("live/dev", "modules.test/acme/net/generic", "v1.2.0"), call("live/prod", "modules.test/acme/net/generic", "1.2.0"), call("live/qa", "modules.test/acme/net/generic", null), call("live/dev", "modules.test/acme/db/generic", "0.3.0")]),
    ).toEqual([
      { component: "modules.test/acme/net/generic", version: "1.2.0", consumers: [{ root: "live/dev", file: "live/dev/main.tf", address: "module.net" }, { root: "live/prod", file: "live/prod/main.tf", address: "module.net" }] },
      { component: "modules.test/acme/db/generic", version: "0.3.0", consumers: [{ root: "live/dev", file: "live/dev/main.tf", address: "module.net" }] },
    ]);
  });
});

describe("sources on chant#3924's forms", () => {
  const cases: [string, string[]][] = [
    ["terraform-aws-modules/vpc/aws", ["registry.terraform.io/terraform-aws-modules/*/*"]],
    ["registry.opentofu.org/terraform-aws-modules/vpc/aws?ref=1", ["terraform-aws-modules/*/*"]],
    ["tfr:///terraform-aws-modules/vpc/aws?version=5.0.0", ["registry.terraform.io/terraform-aws-modules/vpc/aws"]],
  ];

  it.skipIf(!parts.sourceForms)("matches as terragucci's own forms did", () => {
    for (const [source, list] of cases) expect(sourceAllowed("module", source, list), source).toBe(true);
    expect(sourceAllowed("provider", "HashiCorp/AWS", ["registry.terraform.io/hashicorp/*"])).toBe(true);
    expect(sourceAllowed("module", "git::https://example.com/x.git", ["registry.terraform.io/**"])).toBe(false);
  });

  it("keeps its own forms on a chant without them", () => {
    const restore = overrideChantNext("sourceForms", null);
    try {
      for (const [source, list] of cases) expect(sourceAllowed("module", source, list), source).toBe(true);
      expect(moduleForms("terraform-aws-modules/vpc/aws")).toContain("registry.opentofu.org/terraform-aws-modules/vpc/aws");
      expect(providerForms("hashicorp/aws")).toContain("registry.terraform.io/hashicorp/aws");
    } finally {
      restore();
    }
  });
});
