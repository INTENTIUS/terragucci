// A TFE API for the migrate-backend-tfe smoke claim (stack/smoke.sh): the
// part the remote backend and the cloud block use to read and lock a
// workspace's state, and nothing else. One organization, acme, with one
// workspace, app-prod (ws-app).
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
//
// The claim drives it on :8080:
//
//   POST   /versions        a new current state version with the body as its state
//   DELETE /versions/last   drop the current state version
//   GET    /status          {locked, versions: [ids], calls: ["METHOD path"]}
import { readFileSync } from "node:fs";
import { createServer as https } from "node:https";
import { createServer as http } from "node:http";

const TOKEN = process.env.TOKEN;
const BASE = "/api/tfe/v2";
const versions = [];
const calls = [];
let locked = false;
let n = 0;

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
  const path = new URL(req.url, "https://x").pathname;
  calls.push(`${req.method} ${path}`);
  await body(req);
  if (path === "/.well-known/terraform.json") return send(res, 200, { "tfe.v2": `${BASE}/`, "state.v2": `${BASE}/` });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { errors: [{ status: "401", title: "unauthorized" }] });
  if (req.method === "GET" && path === `${BASE}/organizations/acme/workspaces/app-prod`) return send(res, 200, workspace());
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
