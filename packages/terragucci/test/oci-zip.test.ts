// The module zip an OCI release carries, the manifest that names it, and the
// republish of versions an earlier terragucci pushed as a gzipped tar.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { describePublish, publish, verifyPublished } from "../src/publish";
import { gzip, moduleTar, moduleZip, sha256 } from "../src/publish/archive";
import { CONTENT, MODULE_TYPE, REVISION, installable, moduleManifest } from "../src/publish/oci";
import { pinChecker } from "../src/publish/require";
import { git, tmp, write } from "./helpers";
import { fakeRegistry } from "./registry";
import { keyPair, testSigner } from "./signer";

const parser = async () => (await import("@cdktn/hcl2json")) as never;

function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

/** A zip's entries, read from its central directory: name, mode, DOS date and time, and the inflated bytes. */
function unzip(zip: Buffer): { name: string; mode: number; date: number; time: number; data: Buffer }[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const time = zip.readUInt16LE(at + 12);
    const date = zip.readUInt16LE(at + 14);
    const csize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const mode = zip.readUInt32LE(at + 38) >>> 16;
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf-8");
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(data.length).toBe(size);
    out.push({ name, mode, date, time, data });
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

function moduleDir(): string {
  const dir = write(tmp("terragucci-zip-"), {
    "main.tf": 'variable "name" {\n  type = string\n}\n\noutput "greeting" {\n  value = "hello ${var.name}"\n}\n',
    "README.md": "# net\n",
    "scripts/run.sh": "#!/bin/sh\necho hi\n",
    "nested/inner/main.tf": 'output "inner" {\n  value = 1\n}\n',
    "version": "0.1.0\n",
  });
  chmodSync(join(dir, "scripts/run.sh"), 0o755);
  return dir;
}

describe("moduleZip", () => {
  it("holds the module's files at its root, sorted, dated 1980-01-01, with fixed modes", () => {
    const dir = moduleDir();
    const entries = unzip(moduleZip(moduleTar(dir)));
    expect(entries.map((e) => e.name)).toEqual(["README.md", "main.tf", "nested/inner/main.tf", "scripts/run.sh"]);
    expect(entries.find((e) => e.name === "main.tf")!.data.toString()).toBe(readFileSync(join(dir, "main.tf"), "utf-8"));
    expect(entries.map((e) => e.mode.toString(8))).toEqual(["100644", "100644", "100644", "100755"]);
    expect(new Set(entries.map((e) => `${e.date}/${e.time}`))).toEqual(new Set([`${(1 << 5) | 1}/0`]));
  });

  it("is the same bytes for the same files, whatever their mtimes", () => {
    const a = moduleDir();
    const b = moduleDir();
    execFileSync("touch", ["-t", "202001020304", join(b, "main.tf")]);
    expect(statSync(join(a, "main.tf")).mtimeMs).not.toBe(statSync(join(b, "main.tf")).mtimeMs);
    const zip = moduleZip(moduleTar(a));
    expect(moduleZip(moduleTar(b)).equals(zip)).toBe(true);
    expect(sha256(moduleZip(moduleTar(a)))).toBe(sha256(zip));
    writeFileSync(join(b, "main.tf"), "# other\n");
    expect(moduleZip(moduleTar(b)).equals(zip)).toBe(false);
  });

  it.skipIf(spawnSync("python3", ["--version"]).status !== 0)("is a zip another reader opens", () => {
    const file = join(tmp(), "m.zip");
    writeFileSync(file, moduleZip(moduleTar(moduleDir())));
    const out = execFileSync("python3", ["-I", "-c", "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print('\\n'.join(z.namelist()))", file], { encoding: "utf-8" });
    expect(out.trim().split("\n")).toEqual(["README.md", "main.tf", "nested/inner/main.tf", "scripts/run.sh"]);
  });
});

describe("moduleManifest", () => {
  it("names one archive/zip layer and an empty config, under OpenTofu's artifact type", () => {
    const zip = moduleZip(moduleTar(moduleDir()));
    const manifest = JSON.parse(moduleManifest(zip, { a: "b" }).toString());
    expect(manifest).toEqual({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      artifactType: "application/vnd.opentofu.modulepkg",
      config: { mediaType: "application/vnd.oci.empty.v1+json", digest: sha256("{}"), size: 2 },
      layers: [{ mediaType: "archive/zip", digest: sha256(zip), size: zip.length }],
      annotations: { a: "b" },
    });
    expect(installable(manifest)).toBe(true);
    expect(installable({ layers: [{ mediaType: MODULE_TYPE, digest: "sha256:0", size: 1 }] })).toBe(false);
  });
});

/** A repo with modules/net, its commit, and the tar an earlier terragucci pushed for it. */
function repoWithNet() {
  const repo = tmp("terragucci-oci-zip-");
  write(repo, { "modules/net/main.tf": 'output "id" {\n  value = "net"\n}\n' });
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "feat: net");
  return { repo, head: git(repo, "rev-parse", "HEAD").trim(), tar: moduleTar(join(repo, "modules/net")) };
}

/** Push a version the way terragucci 0.4.40 did: a gzipped tar as the one layer, typed as the module package. */
async function pushLegacy(reg: ReturnType<typeof fakeRegistry>, path: string, tag: string, tar: Buffer, revision: string): Promise<string> {
  const layer = gzip(tar);
  const put = async (data: Buffer) => {
    const start = await reg.fetch(`https://registry.test/v2/${path}/blobs/uploads/`, { method: "POST" });
    await reg.fetch(`https://registry.test${start.headers.get("location")}?digest=${encodeURIComponent(sha256(data))}`, { method: "PUT", body: data as BodyInit });
  };
  await put(layer);
  await put(Buffer.from("{}"));
  const body = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      artifactType: MODULE_TYPE,
      config: { mediaType: "application/vnd.oci.empty.v1+json", digest: sha256("{}"), size: 2 },
      layers: [{ mediaType: MODULE_TYPE, digest: sha256(layer), size: layer.length }],
      annotations: { [REVISION]: revision, [CONTENT]: sha256(tar), "org.opencontainers.image.version": tag },
    }),
  );
  await reg.fetch(`https://registry.test/v2/${path}/manifests/${tag}`, { method: "PUT", body: body as BodyInit });
  return sha256(body);
}

const oci = { modules: { publish: "oci://registry.test/acme/modules" } };

describe("a version an earlier terragucci pushed as a tar", () => {
  it("is republished under its tag as archive/zip, with one line naming it, and then left alone", async () => {
    const { repo, head, tar } = repoWithNet();
    const reg = fakeRegistry();
    await pushLegacy(reg, "acme/modules/net", "0.1.0", tar, head);
    const dry = await publish(repo, oci, { fetch: reg.fetch, dryRun: true });
    expect(dry).toEqual([expect.objectContaining({ module: "net", status: "republished", version: "0.1.0", detail: "dry run: would republish it" }), expect.objectContaining({ status: "unchanged" })]);
    const r = await publish(repo, oci, { fetch: reg.fetch });
    // The content annotation matches the checkout, so the version is unchanged, and it is republished all the same.
    expect(r.map((x) => `${x.module}@${x.version}:${x.status}`)).toEqual(["net@0.1.0:republished", "net@0.1.0:unchanged"]);
    expect(describePublish(r).split("\n")[0]).toBe(
      `net 0.1.0: republished as archive/zip to oci://registry.test/acme/modules ${r[0].digest}; the earlier artifact was a tar OpenTofu cannot install`,
    );
    const manifest = JSON.parse(reg.manifests.get("acme/modules/net:0.1.0")!.body.toString());
    expect(manifest.layers).toEqual([{ mediaType: "archive/zip", digest: sha256(moduleZip(tar)), size: moduleZip(tar).length }]);
    expect(manifest.annotations).toEqual({ [REVISION]: head, [CONTENT]: sha256(tar), "org.opencontainers.image.version": "0.1.0" });
    expect(sha256(reg.manifests.get("acme/modules/net:0.1.0")!.body)).toBe(r[0].digest);
    const puts = reg.puts();
    expect((await publish(repo, oci, { fetch: reg.fetch })).map((x) => x.status)).toEqual(["unchanged"]);
    expect(reg.puts()).toBe(puts);
  });

  it("republishes an older version from its own tar, not the checkout's", async () => {
    const { repo, head, tar } = repoWithNet();
    const reg = fakeRegistry();
    await pushLegacy(reg, "acme/modules/net", "0.1.0", tar, head);
    write(repo, { "modules/net/main.tf": 'output "id" {\n  value = "net2"\n}\n' });
    commit(repo, "feat: net2");
    const r = await publish(repo, oci, { fetch: reg.fetch });
    expect(r.map((x) => `${x.module}@${x.version}:${x.status}`)).toEqual(["net@0.1.0:republished", "net@0.2.0:published"]);
    const layer = JSON.parse(reg.manifests.get("acme/modules/net:0.1.0")!.body.toString()).layers[0];
    expect(unzip(reg.blobs.get(layer.digest)!).map((e) => e.data.toString())).toEqual(['output "id" {\n  value = "net"\n}\n']);
  });

  it("refuses one whose layer is not the content its annotation names", async () => {
    const { repo, head, tar } = repoWithNet();
    const reg = fakeRegistry();
    await pushLegacy(reg, "acme/modules/net", "0.1.0", tar, head);
    const body = JSON.parse(reg.manifests.get("acme/modules/net:0.1.0")!.body.toString());
    body.annotations[CONTENT] = sha256("other");
    await reg.fetch("https://registry.test/v2/acme/modules/net/manifests/0.1.0", { method: "PUT", body: Buffer.from(JSON.stringify(body)) as BodyInit });
    const r = await publish(repo, oci, { fetch: reg.fetch });
    expect(r[0]).toMatchObject({ status: "refused", version: "0.1.0" });
    expect(r[0].detail).toMatch(/is a tar OpenTofu cannot install, and it cannot be republished as archive\/zip: its layer holds other content/);
  });

  it("is signed and recorded again when attested, and a digest pin to the tar is refused by modules.require", async () => {
    const pair = keyPair();
    const { repo, head, tar } = repoWithNet();
    const origin = tmp("terragucci-oci-zip-origin-");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    git(repo, "remote", "add", "origin", `file://${origin}`);
    write(repo, { "cosign.pub": pair.pem });
    commit(repo, "chore: key");
    const reg = fakeRegistry();
    const old = await pushLegacy(reg, "acme/modules/net", "0.1.0", tar, head);
    const modules = { publish: "oci://registry.test/acme/modules", attest: true, require: "attested" as const };
    const r = await publish(repo, { modules }, { signer: testSigner(pair.privateKey), parser: await parser(), fetch: reg.fetch });
    expect(r[0]).toMatchObject({ status: "republished", version: "0.1.0" });
    expect(r[0].detail).toMatch(/^signed and recorded in the release ledger as sha256:/);
    const checks = await verifyPublished(repo, { modules }, "net", "0.1.0", { fetch: reg.fetch, env: {} });
    expect(checks[0].verified).toMatchObject({ digest: r[0].digest, commit: head });
    write(repo, {
      "envs/dev/main.tf": `module "a" {\n  source = "oci://registry.test/acme/modules/net?tag=0.1.0"\n}\n\nmodule "b" {\n  source = "oci://registry.test/acme/modules/net?digest=${old}"\n}\n`,
    });
    const pins = await pinChecker(repo, modules, undefined, {}, { parser: await parser(), fetch: reg.fetch, env: {} });
    const p = await pins!("envs/dev");
    expect(p.verified).toEqual(["module.a oci://registry.test/acme/modules/net 0.1.0"]);
    expect(p.refused).toEqual([
      expect.stringContaining(`registry.test/acme/modules/net@${old} holds a layer of application/vnd.opentofu.modulepkg and no archive/zip layer, so OpenTofu cannot install it`),
    ]);
  });
});

const TOFU = spawnSync("tofu", ["version"]).status === 0;
const OPENSSL = spawnSync("openssl", ["version"]).status === 0;

/** The fake registry served over HTTPS on 127.0.0.1, with a certificate made for the test. */
async function serve(reg: ReturnType<typeof fakeRegistry>, dir: string): Promise<{ server: Server; host: string; ca: string }> {
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      // The version check a client makes before it reads anything.
      if (req.url === "/v2/") return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      const body = Buffer.concat(chunks);
      const answer = await reg.fetch(`https://127.0.0.1${req.url}`, { method: req.method, ...(body.length ? { body: body as BodyInit } : {}) });
      const data = Buffer.from(await answer.arrayBuffer());
      const headers: Record<string, string> = {};
      answer.headers.forEach((v, k) => (headers[k] = v));
      res.writeHead(answer.status, headers);
      res.end(req.method === "HEAD" ? undefined : data);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, host: `127.0.0.1:${(server.address() as AddressInfo).port}`, ca: cert };
}

function run(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (status) => resolve({ status, out }));
  });
}

// Go reads SSL_CERT_FILE on Linux; on macOS tofu trusts the system keychain alone, so the test certificate is not trusted there.
describe.skipIf(!TOFU || !OPENSSL || process.platform !== "linux")("tofu init on a module publish pushed", () => {
  it("installs it by tag and by digest, including its subdirectories", { timeout: 120_000 }, async () => {
    const work = tmp("terragucci-oci-tofu-");
    const reg = fakeRegistry();
    const { server, host, ca } = await serve(reg, work);
    try {
      const repo = moduleRepo();
      const r = await publish(repo, { modules: { publish: `oci://${host}/acme/modules` } }, { fetch: reg.fetch });
      expect(r).toEqual([expect.objectContaining({ module: "net", status: "published", version: "0.1.0" })]);
      const root = write(join(work, "root"), {
        "main.tf": `module "by_tag" {\n  source = "oci://${host}/acme/modules/net?tag=0.1.0"\n  name   = "tag"\n}\n\nmodule "by_digest" {\n  source = "oci://${host}/acme/modules/net?digest=${r[0].digest}"\n  name   = "digest"\n}\n\nmodule "inner" {\n  source = "oci://${host}/acme/modules/net//nested/inner?tag=0.1.0"\n}\n\noutput "greetings" {\n  value = [module.by_tag.greeting, module.by_digest.greeting, module.inner.inner]\n}\n`,
      });
      writeFileSync(join(work, "tofurc"), "oci_default_credentials {\n  discover_ambient_credentials = false\n}\n");
      const env = { ...process.env, SSL_CERT_FILE: ca, TF_CLI_CONFIG_FILE: join(work, "tofurc"), TF_IN_AUTOMATION: "1", HOME: work };
      const init = await run("tofu", ["init", "-input=false", "-no-color"], { cwd: root, env });
      expect(init.out).toContain("OpenTofu has been successfully initialized");
      expect(init.status).toBe(0);
      expect(existsSync(join(root, ".terraform/modules/by_tag/main.tf"))).toBe(true);
      expect(statSync(join(root, ".terraform/modules/by_tag/scripts/run.sh")).mode & 0o111).not.toBe(0);
      const apply = await run("tofu", ["apply", "-auto-approve", "-input=false", "-no-color"], { cwd: root, env });
      expect(apply.status).toBe(0);
      const out = JSON.parse((await run("tofu", ["output", "-json", "greetings"], { cwd: root, env })).out);
      expect(out).toEqual(["hello tag", "hello digest", 1]);
    } finally {
      server.close();
    }
  });
});

function moduleRepo(): string {
  const repo = tmp("terragucci-oci-tofu-repo-");
  write(repo, {
    "modules/net/main.tf": 'variable "name" {\n  type = string\n}\n\noutput "greeting" {\n  value = "hello ${var.name}"\n}\n',
    "modules/net/scripts/run.sh": "#!/bin/sh\necho hi\n",
    "modules/net/nested/inner/main.tf": 'output "inner" {\n  value = 1\n}\n',
  });
  chmodSync(join(repo, "modules/net/scripts/run.sh"), 0o755);
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "feat: net");
  return repo;
}
