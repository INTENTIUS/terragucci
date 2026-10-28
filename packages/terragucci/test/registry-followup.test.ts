// The registry follow-ups to chant#4563 and chant#4564: the TFE token through chant's credentials reader,
// the image recipe on the lexicon's mirror code, and modules.registry.providers: mirror. Each runs with
// chant's module stood in for and with it missing, so these hold on any chant. Nothing downloads a provider.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { overrideChantNext } from "../src/chant-next";
import { validateConfig } from "../src/config";
import { mirrorCode, OWN_MIRROR_CODE, planRecipe, type MirrorCode } from "../src/image-recipe";
import { publish } from "../src/publish";
import { MIRROR_RECORD, publishProviderMirror } from "../src/publish/provider-mirror";
import { dirStore } from "../src/publish/registry";
import { tokenFor } from "../src/state-source";
import { git, tmp, write } from "./helpers";

const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

const AWS = "registry.opentofu.org/hashicorp/aws";
const lock = (address: string, version: string) => `provider "${address}" {\n  version = "${version}"\n  hashes = ["h1:abc="]\n}\n`;

describe("tokenFor", () => {
  it("asks chant's credentials reader when the installed chant has it, and names where the token came from", async () => {
    const asked: string[] = [];
    restores.push(
      overrideChantNext("credentials", {
        terraformCredential: (host: string) => (asked.push(host), { token: "from-chant", from: "/cli.tfrc" }),
        tokenVariable: () => undefined,
      }),
    );
    expect(await tokenFor("tfe.test", { TF_TOKEN_tfe_test: "from-env" })).toEqual({ token: "from-chant", from: "/cli.tfrc" });
    expect(asked).toEqual(["tfe.test"]);
  });

  it("falls back to TF_TOKEN_<host>, then credentials.tfrc.json, on a chant without the reader", async () => {
    restores.push(overrideChantNext("credentials", null));
    expect(await tokenFor("tfe.test", { TF_TOKEN_tfe_test: "tok" })).toEqual({ token: "tok", from: "TF_TOKEN_tfe_test" });
    const home = tmp("terragucci-home-");
    mkdirSync(join(home, ".terraform.d"), { recursive: true });
    writeFileSync(join(home, ".terraform.d/credentials.tfrc.json"), JSON.stringify({ credentials: { "tfe.test": { token: "file-tok" } } }));
    expect(await tokenFor("tfe.test", { HOME: home })).toEqual({ token: "file-tok", from: join(home, ".terraform.d/credentials.tfrc.json") });
    expect(await tokenFor("tfe.test", { HOME: "/nonexistent" })).toBeUndefined();
  });
});

describe("the image recipe on the lexicon's mirror code", () => {
  it("uses chant's grouping and modules when /registry has them, and its own copies otherwise", async () => {
    const repo = write(tmp(), { "a/.terraform.lock.hcl": lock(AWS, "5.80.0") });
    restores.push(overrideChantNext("registry", null));
    expect(await mirrorCode()).toBe(OWN_MIRROR_CODE);
    restores.pop()!();
    const calls: string[] = [];
    const chant: MirrorCode = {
      ...OWN_MIRROR_CODE,
      mirrorGroups: (r, l) => (calls.push("groups"), OWN_MIRROR_CODE.mirrorGroups(r, l)),
      mirrorModules: (g, o) => (calls.push("modules"), OWN_MIRROR_CODE.mirrorModules(g, o)),
      mirrorHas: (_m, address) => (calls.push(`has ${address}`), false),
    };
    restores.push(overrideChantNext("registry", chant));
    const code = await mirrorCode();
    const recipe = planRecipe(repo, { code });
    expect(recipe.files.map((f) => f.path)).toContain("mirror/01/versions.tf");
    expect(calls).toEqual(["groups", "modules"]);
    // terragucci's check compares lower case, as providers mirror writes its directories.
    code.mirrorHas("/m", "Registry.OpenTofu.org/HashiCorp/AWS", "5.80.0", "linux_amd64");
    expect(calls).toContain("has registry.opentofu.org/hashicorp/aws");
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

  /** chant's mirror builder stood in for: it writes one version file and its archive. */
  function fakeMirror() {
    const built: string[] = [];
    restores.push(
      overrideChantNext("registry", {
        buildMirror: (_repo: string, out: string) => {
          built.push(out);
          write(out, { "registry.opentofu.org/hashicorp/aws/5.80.0.json": "{}\n", "registry.opentofu.org/hashicorp/aws/terraform-provider-aws_5.80.0_linux_amd64.zip": "zip" });
          return { providers: [`${AWS} 5.80.0`], locks: ["envs/dev/.terraform.lock.hcl"], platforms: ["linux_amd64"] };
        },
        uploadMirror: async (store: { put: (k: string, b: string) => Promise<unknown> }) => {
          await store.put("providers/registry.opentofu.org/hashicorp/aws/5.80.0.json", "{}\n");
          return { put: ["providers/registry.opentofu.org/hashicorp/aws/5.80.0.json"], kept: [] };
        },
        mirrorUrl: (url: string) => `${url}/providers/`,
        mirrorCliConfig: (url: string) => `provider_installation {\n  network_mirror {\n    url = "${url}"\n  }\n}`,
      }),
    );
    return built;
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
    const built = fakeMirror();
    const r = repo();
    const site = tmp("terragucci-mirror-site-");
    const rows = await publish(r, { modules: { registry: REG } }, { registryStore: dirStore(site) });
    const row = rows.at(-1)!;
    expect(row).toMatchObject({ module: "providers", status: "published" });
    expect(row.detail).toContain("network_mirror");
    expect(built).toHaveLength(1);
    const again = await publish(r, { modules: { registry: REG } }, { registryStore: dirStore(site) });
    expect(again.at(-1)).toMatchObject({ module: "providers", status: "unchanged" });
    expect(built).toHaveLength(1);
  });

  it("says so, and writes nothing, on a chant without the builder or with no lock file", async () => {
    restores.push(overrideChantNext("registry", null));
    const site = tmp("terragucci-mirror-site-");
    const row = await publishProviderMirror(repo(), REG, dirStore(site));
    expect(row).toMatchObject({ status: "skipped" });
    expect(row.detail).toContain("no provider mirror builder");
    expect((await dirStore(site).read(MIRROR_RECORD)).body).toBeUndefined();
    expect((await publishProviderMirror(tmp(), REG, dirStore(site))).detail).toContain("no lock file");
  });

  it("writes nothing on a dry run", async () => {
    const built = fakeMirror();
    const row = await publishProviderMirror(repo(), REG, dirStore(tmp("terragucci-mirror-site-")), { dryRun: true });
    expect(row.detail).toMatch(/^dry run: would mirror/);
    expect(built).toEqual([]);
  });
});
