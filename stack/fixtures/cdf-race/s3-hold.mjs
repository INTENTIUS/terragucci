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
//        [&methods=POST,PUT] [&target=<regex>]
//                                       hold those methods instead of PUT alone,
//                                       and with target only an AWS JSON call
//                                       whose X-Amz-Target matches (SQS's
//                                       AmazonSQS.SetQueueAttributes). A new
//                                       hold keeps holding what is held, and
//                                       numbers on from it
//   GET  /held                          [{seq, marker, path, sent}] of what was held so far
//   POST /release?order=2,1             forward the held PUTs in that order, each
//                                       answered before the next is sent
//   POST /open                          stop holding, and forward what is held in
//                                       arrival order
//   POST /drop?seq=3                    answer that held request 503 and never
//                                       forward it (the request of a run that
//                                       was killed while it was held)
//   GET  /events                        [{seq, method, path, target, marker,
//                                       arrived, answered, status}] of every
//                                       request, times in epoch milliseconds,
//                                       target the X-Amz-Target of a JSON call
//   GET  /log                           one line per request: method, path, status,
//                                       and for a PUT its If-Match or If-None-Match
import http from "node:http";

const [upHost, upPort] = (process.env.UPSTREAM ?? "floci:4566").split(":");
const alias = process.env.ALIAS ?? "";

let hold = null;
let methods = ["PUT"];
let targetRe = null;
let markers = [];
let held = [];
let chain = Promise.resolve();
const lines = [];
const events = [];

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

function forward(req, res, path, payload, event) {
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
        if (event) Object.assign(event, { answered: Date.now(), status: r.statusCode });
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
      await forward(h.req, h.res, h.path, h.payload, h.event);
    }
  });
}

http
  .createServer(async (req, res) => {
    const payload = await body(req);
    const path = target(req);
    const text = payload.toString("utf8");
    const event = { method: req.method, path: path.split("?")[0], target: String(req.headers["x-amz-target"] ?? ""), marker: markers.find((m) => text.includes(m)) ?? "-", arrived: Date.now() };
    events.push(event);
    if (hold && methods.includes(req.method) && hold.test(path.split("?")[0]) && (!targetRe || targetRe.test(event.target))) {
      const seq = held.length + 1;
      event.seq = seq;
      held.push({ seq, marker: event.marker, path, req, res, payload, sent: false, event });
      return;
    }
    await forward(req, res, path, payload, event);
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
      methods = (url.searchParams.get("methods") ?? "PUT").split(",").filter(Boolean);
      targetRe = url.searchParams.get("target") ? new RegExp(url.searchParams.get("target")) : null;
      return reply(200, { hold: hold.source, markers, methods, target: targetRe?.source ?? null });
    }
    if (req.method === "GET" && url.pathname === "/held") return reply(200, held.map(({ seq, marker, path, sent }) => ({ seq, marker, path, sent })));
    if (req.method === "POST" && url.pathname === "/release") {
      release((url.searchParams.get("order") ?? "").split(",").filter(Boolean).map(Number));
      return reply(200, { released: url.searchParams.get("order") });
    }
    if (req.method === "POST" && url.pathname === "/open") {
      hold = null;
      release(held.map((h) => h.seq));
      return reply(200, { open: true });
    }
    if (req.method === "POST" && url.pathname === "/drop") {
      const h = held.find((x) => x.seq === Number(url.searchParams.get("seq")) && !x.sent);
      if (h) {
        h.sent = true;
        Object.assign(h.event, { answered: Date.now(), status: 503, dropped: true });
        try {
          h.res.writeHead(503);
          h.res.end("dropped");
        } catch {
          // The caller is gone.
        }
      }
      return reply(200, { dropped: Boolean(h) });
    }
    if (req.method === "GET" && url.pathname === "/events") return reply(200, events);
    if (req.method === "GET" && url.pathname === "/log") return reply(200, lines.join("\n") + "\n", "text/plain");
    reply(404, { error: `no ${req.method} ${url.pathname}` });
  })
  .listen(8080);
