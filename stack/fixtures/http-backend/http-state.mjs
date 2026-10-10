// An http state backend for the migrate-backend-http smoke claim
// (stack/smoke.sh): the REST protocol Terraform's and OpenTofu's http backend
// speaks, with locking, holding each state in memory by its path.
//
//   GET    /<path>          the state, or 404 when there is none
//   POST   /<path>[?ID=id]  write the state; 423 when the path is locked
//                           and the write does not carry the lock's ID
//   DELETE /<path>[?ID=id]  remove the state, under the same rule
//   LOCK   /<path>          take the lock (the body is the lock info);
//                           423 with the holder's info when it is held
//   UNLOCK /<path>          release the lock (the body names its ID)
//
// Control, for the claim:
//
//   GET /_status            200 when it serves
//   GET /_locks             the paths locked now, as a JSON list
//   GET /_writes            each write, as {path, serial, locked}, in order
//
// The claim gives lock_address and unlock_address the state's own address.
//
//   node http-state.mjs     HTTP on :8080
import { createServer } from "node:http";

const states = new Map();
const locks = new Map();
const writes = [];

const body = (req) =>
  new Promise((resolve, reject) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });

const send = (res, code, text = "", type = "text/plain") => {
  res.writeHead(code, { "content-type": type });
  res.end(text);
};

const json = (res, code, value) => send(res, code, JSON.stringify(value), "application/json");

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  const data = await body(req);
  if (req.method === "GET" && path === "/_status") return send(res, 200, "ok");
  if (req.method === "GET" && path === "/_locks") return json(res, 200, [...locks.keys()]);
  if (req.method === "GET" && path === "/_writes") return json(res, 200, writes);
  const held = locks.get(path);
  switch (req.method) {
    case "GET": {
      const s = states.get(path);
      return s ? send(res, 200, s, "application/json") : send(res, 404);
    }
    case "POST":
    case "DELETE": {
      const id = url.searchParams.get("ID");
      if (held && held.ID !== id) return json(res, 423, held);
      if (req.method === "DELETE") {
        states.delete(path);
        return send(res, 200);
      }
      let serial = null;
      try {
        serial = JSON.parse(data.toString("utf-8")).serial ?? null;
      } catch {
        return send(res, 400, "not a state");
      }
      states.set(path, data);
      writes.push({ path, serial, locked: Boolean(held) });
      return send(res, 200);
    }
    case "LOCK": {
      if (held) return json(res, 423, held);
      let info;
      try {
        info = JSON.parse(data.toString("utf-8"));
      } catch {
        return send(res, 400, "not lock info");
      }
      locks.set(path, info);
      return send(res, 200);
    }
    case "UNLOCK": {
      let id = "";
      try {
        id = data.length > 0 ? (JSON.parse(data.toString("utf-8")).ID ?? "") : "";
      } catch {
        return send(res, 400, "not lock info");
      }
      if (held && id && held.ID !== id) return json(res, 423, held);
      locks.delete(path);
      return send(res, 200);
    }
    default:
      return send(res, 405);
  }
}).listen(8080);
