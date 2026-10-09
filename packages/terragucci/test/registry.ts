import { execFileSync } from "node:child_process";

/** A registry in a function: blobs, manifests and tags kept in maps. */
export function fakeRegistry() {
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

