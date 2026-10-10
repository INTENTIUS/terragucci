// A TFE API for the migrate-backend-tfe, import-hcp and import-scalr smoke
// claims (stack/smoke.sh). For the move, the part the remote backend and the
// cloud block use to read and lock a workspace's state: one organization,
// acme, with one workspace, app-prod (ws-app). For the imports, the reads of
// /tfe/api.json when the claim mounts one (hcp.json, scalr.json here):
//
//   { "tfe":  { "<path under /api/tfe/v2/>[?<filters>]": <list or document> },
//     "iacp": { "<path under /api/iacp/v3/>[?<filters>]": <list or document> } }
//
// A key's query holds every parameter but page[...], sorted, unencoded:
// `workspaces?filter[environment]=env-dev`. A list (an array, or an object
// with data and included) is served a page at a time, at most PAGE_MAX
// (default 5) a page whatever page[size] asks, with meta.pagination's
// next-page, so a client that reads one page misses the rest. A sensitive
// variable in the files carries a value, which the real APIs never send, so
// a claim can tell an importer that copies it.
//
//   node tfe.mjs        HTTPS on :443 with /tfe/cert.pem and /tfe/key.pem,
//                       control over HTTP on :8080
//
// Every API call needs `Authorization: Bearer $TOKEN`. Discovery at
// /.well-known/terraform.json points tfe.v2 at /api/tfe/v2/, as Scalr's does,
// so a client that skips discovery misses it.
//
//   GET  /api/tfe/v2/organizations/acme/workspaces/app-prod
//   GET  /api/tfe/v2/workspaces/ws-app/current-state-version
//   GET  /_archivist/<sv-id>                 the version's state
//   POST /api/tfe/v2/workspaces/ws-app/actions/lock    409 when locked
//   POST /api/tfe/v2/workspaces/ws-app/actions/unlock
//   GET  /api/tfe/v2/...  /api/iacp/v3/...       from /tfe/api.json
//
// The claim drives it on :8080:
//
//   POST   /versions        a new current state version with the body as its state
//   DELETE /versions/last   drop the current state version
//   GET    /status          {locked, versions: [ids], calls: ["METHOD path"]}
import { existsSync, readFileSync } from "node:fs";
import { createServer as https } from "node:https";
import { createServer as http } from "node:http";

const TOKEN = process.env.TOKEN;
const BASE = "/api/tfe/v2";
const versions = [];
const calls = [];
let locked = false;
let n = 0;
const API = existsSync("/tfe/api.json") ? JSON.parse(readFileSync("/tfe/api.json", "utf-8")) : {};
const PAGE_MAX = Number(process.env.PAGE_MAX ?? 5);

// The document api.json holds for a GET under a base, paged when it is a list; undefined when it holds none.
const fromFile = (doc, url) => {
  const params = [...url.searchParams].filter(([k]) => !k.startsWith("page[")).sort(([a], [b]) => a.localeCompare(b));
  const key = url.pathname.split("/").slice(4).join("/") + (params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "");
  const got = doc?.[key];
  if (got === undefined) return undefined;
  const list = Array.isArray(got) ? { data: got } : Array.isArray(got.data) ? got : undefined;
  if (!list) return got;
  const size = Math.min(PAGE_MAX, Number(url.searchParams.get("page[size]") ?? 20));
  const page = Number(url.searchParams.get("page[number]") ?? 1);
  const pages = Math.max(1, Math.ceil(list.data.length / size));
  return {
    data: list.data.slice((page - 1) * size, page * size),
    ...(list.included ? { included: list.included } : {}),
    meta: { pagination: { "current-page": page, "next-page": page < pages ? page + 1 : null, "total-pages": pages, "total-count": list.data.length } },
  };
};

const body = (req) => new Promise((done) => {
  let b = "";
  req.on("data", (d) => (b += d));
  req.on("end", () => done(b));
});
const send = (res, status, doc) => {
  res.writeHead(status, { "content-type": "application/vnd.api+json" });
  res.end(typeof doc === "string" ? doc : JSON.stringify(doc));
};
const workspace = () => ({ data: { id: "ws-app", type: "workspaces", attributes: { name: "app-prod", locked, "execution-mode": "local" } } });

https({ cert: readFileSync("/tfe/cert.pem"), key: readFileSync("/tfe/key.pem") }, async (req, res) => {
  const url = new URL(req.url, "https://x");
  const path = url.pathname;
  calls.push(`${req.method} ${decodeURIComponent(path + url.search)}`);
  await body(req);
  if (path === "/.well-known/terraform.json") return send(res, 200, { "tfe.v2": `${BASE}/`, "state.v2": `${BASE}/` });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { errors: [{ status: "401", title: "unauthorized" }] });
  if (req.method === "GET" && path === `${BASE}/organizations/acme/workspaces/app-prod`) return send(res, 200, workspace());
  if (req.method === "GET" && (path.startsWith(`${BASE}/`) || path.startsWith("/api/iacp/v3/"))) {
    const got = fromFile(path.startsWith(BASE) ? API.tfe : API.iacp, url);
    if (got !== undefined) return send(res, 200, got);
  }
  if (req.method === "GET" && path === `${BASE}/workspaces/ws-app/current-state-version`) {
    const v = versions.at(-1);
    if (!v) return send(res, 404, { errors: [{ status: "404", title: "not found" }] });
    return send(res, 200, { data: { id: v.id, type: "state-versions", attributes: { serial: v.serial, "hosted-state-download-url": `https://${req.headers.host}/_archivist/${v.id}` } } });
  }
  if (req.method === "GET" && path.startsWith("/_archivist/")) {
    const v = versions.find((x) => x.id === path.slice("/_archivist/".length));
    return v ? send(res, 200, v.state) : send(res, 404, "");
  }
  if (req.method === "POST" && path === `${BASE}/workspaces/ws-app/actions/lock`) {
    if (locked) return send(res, 409, { errors: [{ status: "409", title: "conflict", detail: "Unable to lock workspace. The workspace is already locked." }] });
    locked = true;
    return send(res, 200, workspace());
  }
  if (req.method === "POST" && path === `${BASE}/workspaces/ws-app/actions/unlock`) {
    locked = false;
    return send(res, 200, workspace());
  }
  return send(res, 404, { errors: [{ status: "404", title: "not found" }] });
}).listen(443);

http(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const b = await body(req);
  if (req.method === "POST" && path === "/versions") {
    const id = `sv-${String(++n).padStart(4, "0")}`;
    versions.push({ id, state: b, serial: JSON.parse(b).serial });
    return send(res, 200, { id });
  }
  if (req.method === "DELETE" && path === "/versions/last") return send(res, 200, { dropped: versions.pop()?.id ?? null });
  if (req.method === "GET" && path === "/status") return send(res, 200, { locked, versions: versions.map((v) => v.id), calls });
  return send(res, 404, "");
}).listen(8080);
