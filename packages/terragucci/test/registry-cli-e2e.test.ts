// Real `terraform init` and `tofu init` against a registry terragucci published (terragucci#1287), served by
// chant's edge function (`serveRegistry(registryEdge({ files: dirFiles(dir), auth }))`) on loopback HTTPS.
//
// Per the ruling on terragucci#1287, the server and the CLI run in one `docker run --network none` container
// from the terragucci-terraform and terragucci-tofu images, so the only address either can reach is the
// container's own loopback, and SSL_CERT_FILE trusts the test's self-signed certificate (Go on darwin ignores
// it). tarball and git-tags install under both CLIs; OCI installs under OpenTofu, and Terraform is asserted
// to fail with `download not supported for scheme 'oci'`, which is what the guide's "OpenTofu only" says.
// With auth on, a credentials block in the CLI config carries the token (a loopback host with a port has no
// TF_TOKEN_ form), and a run without it is refused.
//
// Nothing here reaches a network: the images must already be on the machine (this never pulls), and the
// suite skips when docker, either image, openssl or chant's registry edge function is missing.
// TG_E2E_TERRAFORM_IMAGE and TG_E2E_TOFU_IMAGE name other images.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { publish } from "../src/publish";
import { dirStore } from "../src/publish/registry";
import { fakeRegistry } from "./registry";
import { git, tmp, write } from "./helpers";

const IMAGES = {
  terraform: process.env.TG_E2E_TERRAFORM_IMAGE ?? "ghcr.io/intentius/terragucci-terraform:0.4.45-tf1.14.9",
  tofu: process.env.TG_E2E_TOFU_IMAGE ?? "ghcr.io/intentius/terragucci-tofu:0.4.45-tofu1.13.1",
};
type Cli = keyof typeof IMAGES;
const CLIS: Cli[] = ["terraform", "tofu"];
const PORT = 8443;
const OCI_PORT = 5443;
const HOST = `127.0.0.1:${PORT}`;
const TOKEN = "e2e-registry-token";

const ok = (cmd: string, args: string[]): boolean => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;

async function hasEdge(): Promise<boolean> {
  try {
    // @ts-ignore chant 0.124.54 has no registry/edge subpath (chant#4566)
    const m = (await import("@intentius/chant-lexicon-terraform/registry/edge")) as Record<string, unknown>;
    // @ts-ignore chant 0.124.54 has no registry subpath (chant#4565)
    const r = (await import("@intentius/chant-lexicon-terraform/registry")) as Record<string, unknown>;
    return typeof m.registryEdge === "function" && typeof r.serveRegistry === "function" && typeof r.dirFiles === "function";
  } catch {
    return false;
  }
}

const missing: string[] = [];
if (!ok("docker", ["version"])) missing.push("docker");
else for (const image of Object.values(IMAGES)) if (!ok("docker", ["image", "inspect", image])) missing.push(image);
if (!ok("openssl", ["version"])) missing.push("openssl");
if (!(await hasEdge())) missing.push("chant's registry edge function");
const ready = missing.length === 0;

// The loopback registry, bundled so it runs in the container with no node_modules beside it.
const SERVER = `
import { readFileSync } from "node:fs";
import { dirFiles, serveRegistry } from "@intentius/chant-lexicon-terraform/registry";
import { registryEdge } from "@intentius/chant-lexicon-terraform/registry/edge";
const [dir, port, cert, key, tokens] = process.argv.slice(2);
const auth = tokens ? { tokens: tokens.split(",") } : undefined;
await serveRegistry(registryEdge({ files: dirFiles(dir), ...(auth ? { auth } : {}), log: (line) => console.log(line) }), {
  hostname: "127.0.0.1",
  port: Number(port),
  tls: { cert: readFileSync(cert), key: readFileSync(key) },
});
console.log("listening on " + port);
`;

// A read-only OCI distribution server over a store written from fakeRegistry, for download: oci.
const OCI_SERVER = `
import { createServer } from "node:https";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const [store, port, cert, key] = process.argv.slice(2);
const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, "_");
const digestOf = (b) => "sha256:" + createHash("sha256").update(b).digest("hex");
createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  const path = new URL(req.url, "https://x").pathname;
  const send = (status, headers = {}, body) => { console.log(req.method + " " + path + " -> " + status); res.writeHead(status, headers).end(req.method === "HEAD" ? undefined : body); };
  if (path === "/v2/" || path === "/v2") return send(200, { "content-type": "application/json" }, "{}");
  const p = path.replace(/^\\/v2\\//, "");
  let m;
  if ((m = /\\/blobs\\/(sha256:[0-9a-f]+)$/.exec(p))) {
    const f = join(store, "blobs", safe(m[1]));
    if (!existsSync(f)) return send(404);
    const b = readFileSync(f);
    return send(200, { "content-type": "application/octet-stream", "content-length": String(b.length), "docker-content-digest": m[1] }, b);
  }
  if ((m = /^(.+)\\/manifests\\/(.+)$/.exec(p))) {
    const ref = decodeURIComponent(m[2]);
    const f = join(store, "manifests", safe(ref.startsWith("sha256:") ? m[1] + "@" + ref : m[1] + ":" + ref));
    if (!existsSync(f)) return send(404);
    const b = readFileSync(f);
    const type = JSON.parse(b.toString()).mediaType ?? "application/vnd.oci.image.manifest.v1+json";
    return send(200, { "content-type": type, "content-length": String(b.length), "docker-content-digest": digestOf(b) }, b);
  }
  if ((m = /^(.+)\\/tags\\/list$/.exec(p))) {
    const pre = safe(m[1] + ":");
    const tags = readdirSync(join(store, "manifests")).filter((f) => f.startsWith(pre)).map((f) => f.slice(pre.length));
    return tags.length ? send(200, { "content-type": "application/json" }, JSON.stringify({ name: m[1], tags })) : send(404);
  }
  send(404);
}).listen(Number(port), "127.0.0.1", () => console.log("oci on " + port));
`;

const MODULE = {
  "modules/network/variables.tf": 'variable "name" {\n  type    = string\n  default = "dev"\n}\n',
  "modules/network/outputs.tf": 'output "name" {\n  value = var.name\n}\n',
};

interface Fixture {
  work: string;
  bin: string;
  cert: string;
  key: string;
  sites: { tarball: string; git: string; oci: string };
  ociStore: string;
}

function moduleRepo(work: string, name: string): string {
  const dir = join(work, "repos", name);
  write(dir, MODULE);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "feat: network");
  return dir;
}

async function fixture(): Promise<Fixture> {
  // The same path inside the container as outside, so the stored locations hold there too.
  const work = realpathSync(tmp("terragucci-registry-e2e-"));
  const bin = join(work, "bin");
  mkdirSync(bin, { recursive: true });
  const cert = join(work, "tls/cert.pem");
  const key = join(work, "tls/key.pem");
  mkdirSync(join(work, "tls"), { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  await build({ stdin: { contents: SERVER, resolveDir: join(import.meta.dirname, ".."), loader: "js" }, bundle: true, platform: "node", format: "esm", target: "node20", outfile: join(bin, "registry.mjs"), logLevel: "silent",
    // The lexicon's source reader loads the HCL parser lazily, and the server never parses HCL; its wasm bridge does not bundle for node.
    external: ["@cdktn/hcl2json"] });
  writeFileSync(join(bin, "oci.mjs"), OCI_SERVER);

  const url = `https://${HOST}`;
  const sites = { tarball: join(work, "sites/tarball"), git: join(work, "sites/git"), oci: join(work, "sites/oci") };

  await publish(moduleRepo(work, "tarball"), { modules: { registry: { dir: "public", url, namespace: "acme" } } }, { registryStore: dirStore(sites.tarball) });

  const gitRepo = moduleRepo(work, "git");
  const origin = join(work, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(gitRepo, "remote", "add", "origin", `file://${origin}`);
  await publish(gitRepo, { modules: { publish: "git-tags", registry: { dir: "public", url, namespace: "acme", download: "git-tags" } } }, { registryStore: dirStore(sites.git) });

  const oci = fakeRegistry();
  const ociTarget = `oci://127.0.0.1:${OCI_PORT}/acme`;
  await publish(moduleRepo(work, "oci"), { modules: { publish: ociTarget, registry: { dir: "public", url, namespace: "acme", download: "oci" } } }, { registryStore: dirStore(sites.oci), fetch: oci.fetch as never });
  const ociStore = join(work, "oci-store");
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
  mkdirSync(join(ociStore, "blobs"), { recursive: true });
  mkdirSync(join(ociStore, "manifests"), { recursive: true });
  for (const [digest, body] of oci.blobs) writeFileSync(join(ociStore, "blobs", safe(digest)), body);
  for (const [ref, m] of oci.manifests) {
    writeFileSync(join(ociStore, "manifests", safe(ref)), m.body);
    writeFileSync(join(ociStore, "manifests", safe(`${ref.slice(0, ref.lastIndexOf(":"))}@${m.digest}`)), m.body);
  }
  return { work, bin, cert, key, sites, ociStore };
}

interface Run {
  code: number;
  out: string;
  server: string;
}

let n = 0;
/** One container: the registry (and the OCI server) on loopback, then `<cli> init` in a root that calls the module. */
function init(f: Fixture, cli: Cli, site: string, opts: { tokens?: string[]; token?: string; oci?: boolean } = {}): Run {
  const run = join(f.work, "runs", `${++n}-${cli}`);
  mkdirSync(join(run, "root"), { recursive: true });
  mkdirSync(join(run, "home"), { recursive: true });
  writeFileSync(join(run, "root/main.tf"), `module "network" {\n  source  = "${HOST}/acme/network/generic"\n  version = "0.1.0"\n}\n`);
  writeFileSync(join(run, "cli.tfrc"), opts.token ? `credentials "${HOST}" {\n  token = "${opts.token}"\n}\n` : "");
  const script = [
    "set -u",
    `node ${f.bin}/registry.mjs ${site} ${PORT} ${f.cert} ${f.key} ${(opts.tokens ?? []).join(",")} > ${run}/server.log 2>&1 &`,
    ...(opts.oci ? [`node ${f.bin}/oci.mjs ${f.ociStore} ${OCI_PORT} ${f.cert} ${f.key} >> ${run}/server.log 2>&1 &`] : []),
    `for i in $(seq 1 100); do (echo > /dev/tcp/127.0.0.1/${PORT}) 2>/dev/null && break; sleep 0.1; done`,
    ...(opts.oci ? [`for i in $(seq 1 100); do (echo > /dev/tcp/127.0.0.1/${OCI_PORT}) 2>/dev/null && break; sleep 0.1; done`] : []),
    `cd ${run}/root`,
    [
      "env",
      "HOME=" + join(run, "home"),
      "CHECKPOINT_DISABLE=1",
      "TF_IN_AUTOMATION=1",
      `SSL_CERT_FILE=${f.cert}`,
      `TF_CLI_CONFIG_FILE=${run}/cli.tfrc`,
      `TF_DATA_DIR=${run}/data`,
      // go-getter clones the file:// origin, which the host's user owns.
      "GIT_CONFIG_COUNT=1",
      "GIT_CONFIG_KEY_0=safe.directory",
      "GIT_CONFIG_VALUE_0='*'",
      `${cli} init -no-color -input=false > ${run}/init.out 2>&1`,
    ].join(" "),
    `echo $? > ${run}/exit`,
  ].join("\n");
  writeFileSync(join(run, "run.sh"), `${script}\n`);
  spawnSync("docker", ["run", "--rm", "--network", "none", "-v", `${f.work}:${f.work}`, "--entrypoint", "bash", IMAGES[cli], join(run, "run.sh")], { stdio: "ignore", timeout: 120_000 });
  const read = (name: string) => {
    try {
      return readFileSync(join(run, name), "utf-8");
    } catch {
      return "";
    }
  };
  return { code: Number(read("exit").trim() || "-1"), out: read("init.out"), server: read("server.log") };
}

const installed = (r: Run) => {
  expect(r.code, `${r.out}\n-- server\n${r.server}`).toBe(0);
  expect(r.out).toMatch(/has been successfully initialized/i);
};

describe.skipIf(!ready)(`terraform and tofu init against the edge function on loopback HTTPS${ready ? "" : ` (skipped: no ${missing.join(", ")})`}`, () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  }, 120_000);

  for (const cli of CLIS) {
    it(`${cli} installs a tarball download, with no token`, () => {
      const r = init(f, cli, f.sites.tarball);
      installed(r);
      expect(r.server).toMatch(/download/);
    }, 180_000);

    it(`${cli} installs a git-tags download, with no token`, () => {
      installed(init(f, cli, f.sites.git));
    }, 180_000);

    it(`${cli} installs a tarball with auth on and the token in a credentials block`, () => {
      installed(init(f, cli, f.sites.tarball, { tokens: [TOKEN], token: TOKEN }));
    }, 180_000);

    it(`${cli} is refused with auth on and no token`, () => {
      const r = init(f, cli, f.sites.tarball, { tokens: [TOKEN] });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("401");
    }, 180_000);

    it(`${cli} is refused with auth on and the wrong token`, () => {
      const r = init(f, cli, f.sites.tarball, { tokens: [TOKEN], token: "not-the-token" });
      expect(r.code).not.toBe(0);
    }, 180_000);
  }

  it("tofu installs an OCI download", () => {
    installed(init(f, "tofu", f.sites.oci, { oci: true }));
  }, 180_000);

  it("terraform fails on an OCI download, as the guide's OpenTofu only says", () => {
    const r = init(f, "terraform", f.sites.oci, { oci: true });
    expect(r.code).not.toBe(0);
    expect(r.out.replace(/\s+/g, " ")).toContain("download not supported for scheme 'oci'");
  }, 180_000);
});
