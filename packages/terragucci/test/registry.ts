import { createHash } from "node:crypto";

const digestOf = (body: Buffer): string => `sha256:${createHash("sha256").update(body).digest("hex")}`;

/**
 * A registry in a function: blobs, manifests and tags kept in maps. A
 * manifest stays readable by its digest after its tag moves, as in a real
 * registry before garbage collection.
 */
export function fakeRegistry() {
  const blobs = new Map<string, Buffer>();
  const manifests = new Map<string, { body: Buffer; digest: string }>();
  const byDigest = new Map<string, Buffer>();
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
    if ((m = /\/blobs\/(sha256:.+)$/.exec(path))) {
      const blob = blobs.get(m[1]);
      if (!blob) return new Response(null, { status: 404 });
      const headers = { "content-type": "application/octet-stream", "content-length": String(blob.length), "docker-content-digest": m[1] };
      return new Response(method === "HEAD" ? null : new Uint8Array(blob), { status: 200, headers });
    }
    if ((m = /^(.+)\/manifests\/(.+)$/.exec(path))) {
      const repo = m[1];
      const ref = decodeURIComponent(m[2]);
      if (method === "PUT") {
        const body = Buffer.from(init.body as Uint8Array);
        const digest = digestOf(body);
        manifests.set(`${repo}:${ref}`, { body, digest });
        byDigest.set(`${repo}@${digest}`, body);
        return new Response(null, { status: 201, headers: { "docker-content-digest": digest } });
      }
      const body = ref.startsWith("sha256:") ? byDigest.get(`${repo}@${ref}`) : manifests.get(`${repo}:${ref}`)?.body;
      if (!body) return new Response(null, { status: 404 });
      const type = (JSON.parse(body.toString()) as { mediaType?: string }).mediaType ?? "application/vnd.oci.image.manifest.v1+json";
      const headers = { "docker-content-digest": digestOf(body), "content-type": type, "content-length": String(body.length) };
      return new Response(method === "HEAD" ? null : new Uint8Array(body), { status: 200, headers });
    }
    if ((m = /^(.+)\/tags\/list$/.exec(path))) {
      const tags = [...manifests.keys()].filter((k) => k.startsWith(`${m![1]}:`)).map((k) => k.slice(m![1].length + 1));
      return tags.length ? Response.json({ name: m[1], tags }) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 400 });
  };
  return { fetch: fetchFn, blobs, manifests, log, puts: () => log.filter((l) => l.startsWith("PUT")).length };
}
