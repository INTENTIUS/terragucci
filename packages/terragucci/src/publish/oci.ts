/**
 * A small OCI distribution client: enough to push a module as an artifact,
 * ask whether a tag exists, and read a manifest back. OpenTofu's `oci://`
 * module sources read this shape: an image manifest whose artifact type and
 * one layer are `application/vnd.opentofu.modulepkg`.
 */
import { ConfigError } from "../config";
import { sha256 } from "./archive";

export const MODULE_TYPE = "application/vnd.opentofu.modulepkg";
const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
const EMPTY_TYPE = "application/vnd.oci.empty.v1+json";
export const REVISION = "org.opencontainers.image.revision";
export const CONTENT = "io.intentius.terragucci.content";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface Manifest {
  schemaVersion: 2;
  mediaType: string;
  artifactType: string;
  config: { mediaType: string; digest: string; size: number };
  layers: { mediaType: string; digest: string; size: number }[];
  annotations?: Record<string, string>;
}

export class OciError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = "OciError";
  }
}

/** `oci://host[:port]/path` to its parts. */
export function parseOci(url: string): { host: string; repo: string } {
  const m = /^oci:\/\/([^/]+)\/(.+?)\/*$/.exec(url);
  if (!m) throw new OciError(`${url} is not an oci:// registry address such as oci://registry.example.com/acme/modules`);
  return { host: m[1], repo: m[2] };
}

export interface RegistryOptions {
  fetch?: Fetch;
  /** `http` for a registry without TLS. */
  scheme?: "https" | "http";
  user?: string;
  password?: string;
}

export class Registry {
  private readonly fetchFn: Fetch;
  private readonly base: string;
  private token?: string;

  constructor(readonly host: string, private readonly opts: RegistryOptions = {}) {
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.base = `${opts.scheme ?? "https"}://${host}/v2`;
  }

  private basic(): string | undefined {
    return this.opts.user ? `Basic ${Buffer.from(`${this.opts.user}:${this.opts.password ?? ""}`).toString("base64")}` : undefined;
  }

  private async send(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const headers = new Headers(init.headers);
    const auth = this.token ? `Bearer ${this.token}` : this.basic();
    if (auth) headers.set("authorization", auth);
    const res = await this.fetchFn(url, { ...init, headers });
    const challenge = res.headers.get("www-authenticate") ?? "";
    if (res.status === 401 && !retried && /^Bearer /i.test(challenge)) {
      const attrs = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
      if (attrs.realm) {
        const q = new URLSearchParams();
        if (attrs.service) q.set("service", attrs.service);
        if (attrs.scope) q.set("scope", attrs.scope);
        const basic = this.basic();
        const t = await this.fetchFn(`${attrs.realm}?${q}`, basic ? { headers: { authorization: basic } } : {});
        if (t.ok) {
          const body = (await t.json()) as { token?: string; access_token?: string };
          this.token = body.token ?? body.access_token;
          return this.send(url, init, true);
        }
      }
    }
    return res;
  }

  private async expect(res: Response, what: string, ok: number[] = [200, 201, 202]): Promise<Response> {
    if (!ok.includes(res.status)) throw new OciError(`${this.host}: ${what} answered ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  async tags(repo: string): Promise<string[]> {
    const res = await this.send(`${this.base}/${repo}/tags/list`);
    if (res.status === 404) return [];
    await this.expect(res, "listing tags");
    return ((await res.json()) as { tags?: string[] | null }).tags ?? [];
  }

  /** The manifest at a tag with its digest, or undefined when the tag is absent. */
  async manifest(repo: string, ref: string): Promise<{ digest: string; manifest: Manifest } | undefined> {
    const res = await this.send(`${this.base}/${repo}/manifests/${ref}`, { headers: { accept: MANIFEST_TYPE } });
    if (res.status === 404) return undefined;
    await this.expect(res, `reading ${ref}`);
    const text = await res.text();
    return { digest: res.headers.get("docker-content-digest") ?? sha256(text), manifest: JSON.parse(text) as Manifest };
  }

  private async pushBlob(repo: string, data: Uint8Array): Promise<{ digest: string; size: number }> {
    const digest = sha256(data);
    const head = await this.send(`${this.base}/${repo}/blobs/${digest}`, { method: "HEAD" });
    if (head.status === 200) return { digest, size: data.length };
    const start = await this.expect(await this.send(`${this.base}/${repo}/blobs/uploads/`, { method: "POST" }), "starting an upload");
    const where = start.headers.get("location");
    if (!where) throw new OciError(`${this.host}: the upload answered without a location`);
    const abs = where.startsWith("http") ? where : `${this.opts.scheme ?? "https"}://${this.host}${where}`;
    const url = `${abs}${abs.includes("?") ? "&" : "?"}digest=${encodeURIComponent(digest)}`;
    await this.expect(
      await this.send(url, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: data as BodyInit }),
      "uploading a blob",
    );
    return { digest, size: data.length };
  }

  /** Push a module archive under a tag; returns the manifest digest. */
  async pushModule(repo: string, tag: string, archive: Uint8Array, annotations: Record<string, string>): Promise<string> {
    await this.pushBlob(repo, archive);
    await this.pushBlob(repo, Buffer.from("{}"));
    const body = moduleManifest(archive, annotations);
    await this.expect(
      await this.send(`${this.base}/${repo}/manifests/${tag}`, { method: "PUT", headers: { "content-type": MANIFEST_TYPE }, body: body as BodyInit }),
      `publishing ${tag}`,
    );
    return sha256(body);
  }

  /** The manifest bytes at a tag or digest, exactly as the registry holds them, or undefined when absent. */
  async manifestBytes(repo: string, ref: string): Promise<Buffer | undefined> {
    const res = await this.send(`${this.base}/${repo}/manifests/${ref}`, { headers: { accept: MANIFEST_TYPE } });
    if (res.status === 404) return undefined;
    await this.expect(res, `reading ${ref}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

/**
 * The manifest bytes pushModule writes for an archive: the module layer and an
 * empty config. The same archive and annotations give the same bytes, so the
 * manifest digest is known before the push.
 */
export function moduleManifest(archive: Uint8Array, annotations: Record<string, string>): Buffer {
  const empty = Buffer.from("{}");
  const manifest: Manifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_TYPE,
    artifactType: MODULE_TYPE,
    config: { mediaType: EMPTY_TYPE, digest: sha256(empty), size: empty.length },
    layers: [{ mediaType: MODULE_TYPE, digest: sha256(archive), size: archive.length }],
    annotations,
  };
  return Buffer.from(JSON.stringify(manifest));
}
