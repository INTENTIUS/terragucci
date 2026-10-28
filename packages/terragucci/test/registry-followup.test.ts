// The registry follow-ups to chant#4563 and chant#4564: the TFE token through chant's credentials reader,
// the image recipe on the lexicon's mirror code, and modules.registry.providers: mirror. `providers mirror`
// is stood in for, so nothing downloads a provider.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import { MIRROR_CODE, planRecipe, type MirrorCode } from "../src/image-recipe";
import { publish } from "../src/publish";
import { MIRROR_RECORD, publishProviderMirror, type ProviderMirrorRun } from "../src/publish/provider-mirror";
import { dirStore } from "../src/publish/registry";
import { tokenFor } from "../src/state-source";
import { git, tmp, write } from "./helpers";

const AWS = "registry.opentofu.org/hashicorp/aws";
const lock = (address: string, version: string) => `provider "${address}" {\n  version = "${version}"\n  hashes = ["h1:abc="]\n}\n`;

describe("tokenFor", () => {
  it("finds TF_TOKEN_<host>, then credentials.tfrc.json, through chant's reader, and names where the token came from", async () => {
    expect(await tokenFor("tfe.test", { TF_TOKEN_tfe_test: "tok" })).toEqual({ token: "tok", from: "TF_TOKEN_tfe_test" });
    const home = tmp("terragucci-home-");
    mkdirSync(join(home, ".terraform.d"), { recursive: true });
    writeFileSync(join(home, ".terraform.d/credentials.tfrc.json"), JSON.stringify({ credentials: { "tfe.test": { token: "file-tok" } } }));
    expect(await tokenFor("tfe.test", { HOME: home })).toEqual({ token: "file-tok", from: join(home, ".terraform.d/credentials.tfrc.json") });
    expect(await tokenFor("tfe.test", { HOME: "/nonexistent" })).toBeUndefined();
  });
});

describe("the image recipe on the lexicon's mirror code", () => {
  it("groups and writes the mirror modules with the code it is handed, and checks lower case", () => {
    const repo = write(tmp(), { "a/.terraform.lock.hcl": lock(AWS, "5.80.0") });
    const calls: string[] = [];
    const code: MirrorCode = {
      ...MIRROR_CODE,
      mirrorGroups: (r, l) => (calls.push("groups"), MIRROR_CODE.mirrorGroups(r, l)),
      mirrorModules: (g, o) => (calls.push("modules"), MIRROR_CODE.mirrorModules(g, o)),
    };
    const recipe = planRecipe(repo, { code });
    expect(recipe.files.map((f) => f.path)).toContain("mirror/01/versions.tf");
    expect(calls).toEqual(["groups", "modules"]);
    // terragucci's check compares lower case, as providers mirror writes its directories.
    const mirror = tmp("terragucci-mirror-dir-");
    mkdirSync(join(mirror, "registry.opentofu.org/hashicorp/aws/5.80.0/linux_amd64"), { recursive: true });
    expect(MIRROR_CODE.mirrorHas(mirror, "Registry.OpenTofu.org/HashiCorp/AWS", "5.80.0", "linux_amd64")).toBe(true);
  });
});

describe("modules.registry.providers: mirror", () => {
  const REG = { dir: "public", url: "https://modules.test", namespace: "acme", providers: "mirror" as const };

  function repo(): string {
    const dir = tmp("terragucci-mirror-");
    write(dir, { "modules/net/main.tf": 'resource "terraform_data" "a" {}\n', "envs/dev/.terraform.lock.hcl": lock(AWS, "5.80.0") });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "feat: net");
    return dir;
  }

  /** `providers mirror` stood in for: it writes one version file and its archive into the mirror directory. */
  function fakeMirror(): { built: string[]; run: ProviderMirrorRun } {
    const built: string[] = [];
    const run: ProviderMirrorRun = (_bin, args) => {
      const out = args.at(-1)!;
      built.push(out);
      write(out, { "registry.opentofu.org/hashicorp/aws/5.80.0.json": "{}\n", "registry.opentofu.org/hashicorp/aws/terraform-provider-aws_5.80.0_linux_amd64.zip": "zip" });
      return { status: 0, output: "" };
    };
    return { built, run };
  }

  it("is a setting with one value", () => {
    const problems = (registry: unknown) => {
      try {
        validateConfig({ modules: { registry } }, "t");
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(problems(REG)).toBe("");
    expect(problems({ ...REG, providers: "all" })).toContain("the one setting is mirror");
  });

  it("mirrors once after the modules publish, records what it covers, and prints the CLI config block", async () => {
    const { built, run } = fakeMirror();
    const r = repo();
    const site = tmp("terragucci-mirror-site-");
    const rows = await publish(r, { modules: { registry: REG } }, { registryStore: dirStore(site), mirrorRun: run });
    const row = rows.at(-1)!;
    expect(row).toMatchObject({ module: "providers", status: "published" });
    expect(row.detail).toContain("network_mirror");
    expect(built).toHaveLength(1);
    const again = await publish(r, { modules: { registry: REG } }, { registryStore: dirStore(site), mirrorRun: run });
    expect(again.at(-1)).toMatchObject({ module: "providers", status: "unchanged" });
    expect(built).toHaveLength(1);
  });

  it("says so, and writes nothing, with no lock file", async () => {
    const site = tmp("terragucci-mirror-site-");
    expect((await publishProviderMirror(tmp(), REG, dirStore(site))).detail).toContain("no lock file");
    expect((await dirStore(site).read(MIRROR_RECORD)).body).toBeUndefined();
  });

  it("writes nothing on a dry run", async () => {
    const { built, run } = fakeMirror();
    const row = await publishProviderMirror(repo(), REG, dirStore(tmp("terragucci-mirror-site-")), { dryRun: true, run });
    expect(row.detail).toMatch(/^dry run: would mirror/);
    expect(built).toEqual([]);
  });
});
