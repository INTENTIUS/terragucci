import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, validateConfig } from "../src/config";
import { publish } from "../src/publish";
import { bumpFor } from "../src/publish/semver";
import { git, tmp, write } from "./helpers";

/** A registry in a function: blobs, manifests and tags kept in maps. */
function fakeRegistry() {
  const blobs = new Map<string, Buffer>();
  const manifests = new Map<string, { body: Buffer; digest: string }>();
  const log: string[] = [];
  const fetchFn = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    log.push(`${method} ${u.pathname}`);
    const path = u.pathname.replace(/^\/v2\//, "");
    let m: RegExpExecArray | null;
    if ((m = /^(.+)\/blobs\/uploads\/$/.exec(path)) && method === "POST") {
      return new Response(null, { status: 202, headers: { location: `/v2/${m[1]}/blobs/uploads/abc` } });
    }
    if (/\/blobs\/uploads\/abc$/.test(path) && method === "PUT") {
      blobs.set(u.searchParams.get("digest")!, Buffer.from(init.body as Uint8Array));
      return new Response(null, { status: 201 });
    }
    if ((m = /\/blobs\/(sha256:.+)$/.exec(path))) return new Response(null, { status: blobs.has(m[1]) ? 200 : 404 });
    if ((m = /^(.+)\/manifests\/(.+)$/.exec(path))) {
      const key = `${m[1]}:${m[2]}`;
      if (method === "PUT") {
        const body = Buffer.from(init.body as Uint8Array);
        manifests.set(key, { body, digest: `sha256:${execFileSync("shasum", ["-a", "256"], { input: body }).toString().split(" ")[0]}` });
        return new Response(null, { status: 201 });
      }
      const found = manifests.get(key);
      return found ? new Response(new Uint8Array(found.body), { status: 200, headers: { "docker-content-digest": found.digest } }) : new Response(null, { status: 404 });
    }
    if ((m = /^(.+)\/tags\/list$/.exec(path))) {
      const tags = [...manifests.keys()].filter((k) => k.startsWith(`${m![1]}:`)).map((k) => k.slice(m![1].length + 1));
      return tags.length ? Response.json({ name: m[1], tags }) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 400 });
  };
  return { fetch: fetchFn, blobs, manifests, log, puts: () => log.filter((l) => l.startsWith("PUT")).length };
}

function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

function repoWithModules(): string {
  const dir = tmp("terragucci-publish-");
  write(dir, {
    "modules/net/main.tf": 'resource "null_resource" "a" {}\n',
    "modules/db/main.tf": 'resource "null_resource" "b" {}\n',
    "envs/dev/main.tf": "# root\n",
  });
  git(dir, "init", "-q", "-b", "main");
  commit(dir, "feat: modules");
  return dir;
}

const oci = { modules: { publish: "oci://registry.test/acme/modules" } };

describe("bumpFor", () => {
  it("reads conventional commits", () => {
    expect(bumpFor(["fix: a"])).toBe("patch");
    expect(bumpFor(["fix: a", "feat(net): b"])).toBe("minor");
    expect(bumpFor(["feat: b", "refactor!: c"])).toBe("major");
    expect(bumpFor(["fix: a\n\nBREAKING CHANGE: gone"])).toBe("major");
    expect(bumpFor(["chore: tidy"])).toBe("patch");
  });
});

describe("publish to an OCI registry", () => {
  it("publishes every module once, then nothing on the same commit", async () => {
    const repo = repoWithModules();
    const reg = fakeRegistry();
    const first = await publish(repo, oci, { fetch: reg.fetch });
    expect(first.map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["db@0.1.0:published", "net@0.1.0:published"]);
    expect(first[0].digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const manifest = JSON.parse(reg.manifests.get("acme/modules/net:0.1.0")!.body.toString());
    expect(manifest.artifactType).toBe("application/vnd.opentofu.modulepkg");
    expect(manifest.layers).toHaveLength(1);
    const puts = reg.puts();
    const again = await publish(repo, oci, { fetch: reg.fetch });
    expect(again.every((r) => r.status === "unchanged")).toBe(true);
    expect(reg.puts()).toBe(puts);
  });

  it("publishes only the module that changed, at the bump its commits call for", async () => {
    const repo = repoWithModules();
    const reg = fakeRegistry();
    await publish(repo, oci, { fetch: reg.fetch });
    write(repo, { "modules/net/outputs.tf": 'output "id" { value = 1 }\n' });
    commit(repo, "feat(net): an id output");
    const next = await publish(repo, oci, { fetch: reg.fetch });
    expect(next.map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["db@0.1.0:unchanged", "net@0.2.0:published"]);
    expect([...reg.manifests.keys()].sort()).toEqual(["acme/modules/db:0.1.0", "acme/modules/net:0.1.0", "acme/modules/net:0.2.0"]);
    write(repo, { "modules/net/main.tf": 'resource "null_resource" "a" { triggers = {} }\n' });
    commit(repo, "fix!: drop the old trigger");
    const major = await publish(repo, oci, { fetch: reg.fetch });
    expect(major.find((r) => r.module === "net")?.version).toBe("1.0.0");
  });

  it("does not republish when a change was reverted", async () => {
    const repo = repoWithModules();
    const reg = fakeRegistry();
    await publish(repo, oci, { fetch: reg.fetch });
    write(repo, { "modules/net/main.tf": "# other\n" });
    commit(repo, "fix: other");
    write(repo, { "modules/net/main.tf": 'resource "null_resource" "a" {}\n' });
    commit(repo, "fix: back");
    const r = await publish(repo, oci, { fetch: reg.fetch });
    expect(r.find((x) => x.module === "net")?.status).toBe("unchanged");
  });

  it("lets a version file override the bump, and refuses to rewrite a published version", async () => {
    const repo = repoWithModules();
    const reg = fakeRegistry();
    await publish(repo, oci, { fetch: reg.fetch });
    write(repo, { "modules/net/main.tf": "# changed\n", "modules/net/version": "3.0.0\n" });
    commit(repo, "fix: small");
    const r = await publish(repo, oci, { fetch: reg.fetch });
    expect(r.find((x) => x.module === "net")).toMatchObject({ version: "3.0.0", status: "published" });
    write(repo, { "modules/net/main.tf": "# changed again\n" });
    commit(repo, "fix: smaller");
    const stuck = await publish(repo, oci, { fetch: reg.fetch });
    expect(stuck.find((x) => x.module === "net")?.status).toBe("skipped");
    expect(reg.manifests.has("acme/modules/net:3.0.1")).toBe(false);
  });

  it("writes nothing on a dry run", async () => {
    const repo = repoWithModules();
    const reg = fakeRegistry();
    const r = await publish(repo, oci, { fetch: reg.fetch, dryRun: true });
    expect(r.every((x) => x.status === "published" && x.detail?.includes("dry run"))).toBe(true);
    expect(reg.puts()).toBe(0);
  });
});

describe("publish to git tags", () => {
  it("tags a module, pushes the tag, and leaves an unchanged module alone", async () => {
    const repo = repoWithModules();
    const remote = tmp("terragucci-remote-");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git(repo, "remote", "add", "origin", remote);
    const cfg = { modules: { publish: "git-tags" } };
    const first = await publish(repo, cfg);
    expect(first.map((r) => r.status)).toEqual(["published", "published"]);
    expect(git(repo, "tag", "--list").trim().split("\n")).toEqual(["modules/db/v0.1.0", "modules/net/v0.1.0"]);
    expect(git(remote, "tag", "--list").trim().split("\n")).toEqual(["modules/db/v0.1.0", "modules/net/v0.1.0"]);
    expect((await publish(repo, cfg)).every((r) => r.status === "unchanged")).toBe(true);
    write(repo, { "modules/db/main.tf": "# more\n" });
    commit(repo, "fix: db");
    const next = await publish(repo, cfg);
    expect(next.map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["db@0.1.1:published", "net@0.1.0:unchanged"]);
    expect(git(repo, "tag", "--list", "modules/db/*")).toContain("modules/db/v0.1.1");
  });

  it("reports a version the remote already has, when the clone lost its tags", async () => {
    const repo = repoWithModules();
    const remote = tmp("terragucci-remote-");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git(repo, "remote", "add", "origin", remote);
    const cfg = { modules: { publish: "git-tags" } };
    await publish(repo, cfg);
    for (const t of git(repo, "tag", "--list").trim().split("\n")) git(repo, "tag", "-d", t);
    const again = await publish(repo, cfg);
    expect(again.map((r) => r.status)).toEqual(["unchanged", "unchanged"]);
    expect(git(remote, "tag", "--list").trim().split("\n")).toEqual(["modules/db/v0.1.0", "modules/net/v0.1.0"]);
  });

  it("moves on from the remote's newest tag when the clone lost its tags and the module changed", async () => {
    const repo = repoWithModules();
    const remote = tmp("terragucci-remote-");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git(repo, "remote", "add", "origin", remote);
    const cfg = { modules: { publish: "git-tags" } };
    await publish(repo, cfg);
    for (const t of git(repo, "tag", "--list").trim().split("\n")) git(repo, "tag", "-d", t);
    write(repo, { "modules/db/main.tf": "# more\n" });
    commit(repo, "fix: db");
    const next = await publish(repo, cfg);
    expect(next.map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["db@0.1.1:published", "net@0.1.0:unchanged"]);
  });

  it("publishes to both targets with the same content digest", async () => {
    const repo = repoWithModules();
    const reg = fakeRegistry();
    const r = await publish(repo, { modules: { publish: ["git-tags", "oci://registry.test/acme/modules"] } }, { fetch: reg.fetch, push: false });
    expect(r.filter((x) => x.status === "published")).toHaveLength(4);
    const tagged = git(repo, "tag", "--list", "--format=%(contents)", "modules/net/v0.1.0");
    const manifest = JSON.parse(reg.manifests.get("acme/modules/net:0.1.0")!.body.toString());
    expect(tagged).toContain(`content: ${manifest.annotations["io.intentius.terragucci.content"]}`);
  });
});

describe("modules.publish validation", () => {
  it("rejects a target that is neither oci:// nor git-tags", () => {
    expect(() => validateConfig({ modules: { publish: "s3://bucket" } }, "t")).toThrow(ConfigError);
    expect(validateConfig({ modules: { publish: ["git-tags", "oci://r.example/a"] } }, "t")).toBeTruthy();
  });
  it("needs a target to publish", async () => {
    await expect(publish(repoWithModules(), {})).rejects.toThrow(/modules.publish/);
  });
});
void writeFileSync;
void join;
