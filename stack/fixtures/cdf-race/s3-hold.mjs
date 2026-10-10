// A proxy in front of floci's S3 for the cdf-concurrency and
// cdf-write-race smoke claims (stack/smoke.sh), after choudoufu's own
// live/smoke/s3proxy.py. Two applies started together rarely overlap: one
// writes before the other has read. The proxy holds every PUT whose path
// matches a pattern until the claim releases it, so both writes are in flight
// at once and each was planned against the same records.
//
//   node s3-hold.mjs        S3 on :4566, forwarded to UPSTREAM (floci:4566)
//
// ALIAS is the proxy's own name on the network. choudoufu's record store
// addresses a bucket virtual-hosted (<bucket>.<endpoint host>), so the claim
// gives the container the alias <bucket>.<ALIAS> too, and a request for that
// host is sent on path-style, which floci answers.
//
// The claim drives it over HTTP on :8080:
//
//   POST /hold?re=<regex>&markers=a,b   hold each PUT whose path matches, from
//                                       now on, numbering arrivals from 1; the
//                                       first marker found in a held body names it
//   GET  /held                          [{seq, marker, path}] of the PUTs held so far
//   POST /release?order=2,1             forward the held PUTs in that order, each
//                                       answered before the next is sent
//   POST /open                          stop holding, and forward what is held in
//                                       arrival order
//   GET  /log                           one line per request: method, path, status,
//                                       and for a PUT its If-Match or If-None-Match
import http from "node:http";

const [upHost, upPort] = (process.env.UPSTREAM ?? "floci:4566").split(":");
const alias = process.env.ALIAS ?? "";

let hold = null;
let markers = [];
let held = [];
let chain = Promise.resolve();
const lines = [];

const body = (req) =>
  new Promise((resolve) => {
    const parts = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => resolve(Buffer.concat(parts)));
  });

/** The path floci is sent: a virtual-hosted request is rewritten path-style. */
function target(req) {
  const host = (req.headers.host ?? "").split(":")[0];
  if (!alias || !host.endsWith(`.${alias}`)) return req.url;
  const bucket = host.slice(0, -(alias.length + 1));
  // <account>.<ALIAS> is S3 Control (the provider's bucket tags), whose path
  // floci reads as it is.
  if (/^[0-9]{12}$/.test(bucket)) return req.url;
  if (req.url === "/") return `/${bucket}`;
  return req.url.startsWith("/?") ? `/${bucket}${req.url.slice(1)}` : `/${bucket}${req.url}`;
}

function precondition(req) {
  if (req.headers["if-match"]) return `if-match:${req.headers["if-match"]}`;
  if (req.headers["if-none-match"]) return `if-none-match:${req.headers["if-none-match"]}`;
  return "no-precondition";
}

function forward(req, res, path, payload) {
  return new Promise((resolve) => {
    const headers = { ...req.headers, host: `${upHost}:${upPort}`, "content-length": String(payload.length) };
    delete headers.connection;
    delete headers.expect;
    delete headers["transfer-encoding"];
    const up = http.request({ host: upHost, port: Number(upPort), method: req.method, path, headers }, (r) => {
      const out = [];
      r.on("data", (d) => out.push(d));
      r.on("end", () => {
        const data = Buffer.concat(out);
        // A HEAD answer keeps the object's length; any other carries the body read here.
        const h = req.method === "HEAD" ? { ...r.headers } : { ...r.headers, "content-length": String(data.length) };
        delete h.connection;
        delete h["transfer-encoding"];
        res.writeHead(r.statusCode ?? 502, h);
        res.end(req.method === "HEAD" ? undefined : data);
        lines.push(`${req.method} ${path.split("?")[0]} ${r.statusCode}${req.method === "PUT" ? ` ${precondition(req)}` : ""}`);
        resolve();
      });
    });
    up.on("error", (e) => {
      res.writeHead(502);
      res.end(String(e));
      lines.push(`${req.method} ${path.split("?")[0]} 502 ${e.message}`);
      resolve();
    });
    up.end(payload);
  });
}

/** Release the held PUTs named, one at a time; a later call queues behind it. */
function release(order) {
  chain = chain.then(async () => {
    for (const seq of order) {
      const h = held.find((x) => x.seq === seq && !x.sent);
      if (!h) continue;
      h.sent = true;
      await forward(h.req, h.res, h.path, h.payload);
    }
  });
}

http
  .createServer(async (req, res) => {
    const payload = await body(req);
    const path = target(req);
    if (req.method === "PUT" && hold && hold.test(path.split("?")[0])) {
      const text = payload.toString("utf8");
      held.push({ seq: held.length + 1, marker: markers.find((m) => text.includes(m)) ?? "-", path, req, res, payload, sent: false });
      return;
    }
    await forward(req, res, path, payload);
  })
  .listen(4566);

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://control");
    const reply = (status, data, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(type === "application/json" ? JSON.stringify(data) : data);
    };
    if (req.method === "POST" && url.pathname === "/hold") {
      hold = new RegExp(url.searchParams.get("re") ?? "^$");
      markers = (url.searchParams.get("markers") ?? "").split(",").filter(Boolean);
      held = [];
      return reply(200, { hold: hold.source, markers });
    }
    if (req.method === "GET" && url.pathname === "/held") return reply(200, held.map(({ seq, marker, path }) => ({ seq, marker, path })));
    if (req.method === "POST" && url.pathname === "/release") {
      release((url.searchParams.get("order") ?? "").split(",").filter(Boolean).map(Number));
      return reply(200, { released: url.searchParams.get("order") });
    }
    if (req.method === "POST" && url.pathname === "/open") {
      hold = null;
      release(held.map((h) => h.seq));
      return reply(200, { open: true });
    }
    if (req.method === "GET" && url.pathname === "/log") return reply(200, lines.join("\n") + "\n", "text/plain");
    reply(404, { error: `no ${req.method} ${url.pathname}` });
  })
  .listen(8080);
