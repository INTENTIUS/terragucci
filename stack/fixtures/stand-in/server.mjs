// A stand-in service for the smoke claims (stack/smoke.sh) that need a
// service the stack does not run: a typed-decision service in the Jev shape,
// an OTLP/HTTP collector that wants a header, an STS that says which roles
// it was asked for, or a chat incoming webhook. It runs in a CI image (they
// all carry node) on the stack's network.
//
//   MODE=decide  POST /v1/systemone answers every noul question with NOUL
//                (default 0.95), as the model the request pins (or MODEL)
//   MODE=otlp    POST /v1/traces and /v1/metrics answer 200, or 401 when
//                REQUIRE names a header (name=value) the request lacks
//   MODE=sts     AWS STS: AssumeRoleWithWebIdentity and AssumeRole answer
//                keys for any role (floci takes any keys), and
//                GetCallerIdentity answers the account 000000000000
//   MODE=webhook a chat incoming webhook (Slack, Teams): any POST answers
//                200 "ok", as Slack's does, and is kept with its JSON body
//   MODE=cost    a cost estimator's API: POST /estimate takes a plan's
//                show -json and answers Infracost's JSON, 10.00 a month for
//                each resource the plan creates, less 10.00 for each it
//                deletes; 401 when REQUIRE names a header the request lacks
//   MODE=s3      S3, forwarded to UPSTREAM (floci:4566). HOLD_PATH holds the
//                first two PUTs to that path until both arrived (or 60s
//                passed), then sends them at once, so two writers race on
//                one object. STRIP=1 drops If-Match and If-None-Match, as a
//                store that ignores them would. ANSWER_501=1 answers 501 to a
//                PUT of an index.json that carries either header.
//
// It listens on PORT (default 8790; s3 on 4566). GET /_requests lists every request it
// took, in order: method, path, status, headers, the body as JSON when it
// parses, and a form body's fields as form (the claims read this from the
// host through a published port).
import http from "node:http";

const mode = process.env.MODE ?? "decide";
const port = Number(process.env.PORT ?? (mode === "s3" ? 4566 : 8790));
const seen = [];

const answer = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
  return status;
};

function decide(req, body) {
  if (req.method !== "POST" || !req.url.startsWith("/v1/systemone")) return [404, { detail: "not found" }];
  const noul = Number(process.env.NOUL ?? 0.95);
  const answers = {};
  for (const [name, q] of Object.entries(body?.questions ?? {})) {
    if (q.type === "noul") answers[name] = { type: "noul", noul };
    else if (q.type === "choice") {
      const first = Object.keys(q.criteria ?? {})[0];
      answers[name] = { type: "choice", choice: first, probabilities: Object.fromEntries(Object.keys(q.criteria ?? {}).map((k) => [k, k === first ? noul : (1 - noul) / Math.max(1, Object.keys(q.criteria).length - 1)])) };
    }
  }
  return [200, { model: process.env.MODEL ?? body?.model ?? "stand-in", answers }];
}

function sts(form) {
  const action = form.Action ?? "";
  const xml = (inner) => `<${action}Response xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><${action}Result>${inner}</${action}Result><ResponseMetadata><RequestId>stand-in</RequestId></ResponseMetadata></${action}Response>`;
  if (action === "GetCallerIdentity") {
    return [200, xml("<Arn>arn:aws:sts::000000000000:assumed-role/stand-in/smoke</Arn><UserId>stand-in</UserId><Account>000000000000</Account>"), "text/xml"];
  }
  if (action === "AssumeRoleWithWebIdentity" || action === "AssumeRole") {
    const expires = new Date(Date.now() + 3600_000).toISOString();
    const creds = `<Credentials><AccessKeyId>test</AccessKeyId><SecretAccessKey>test</SecretAccessKey><SessionToken>stand-in</SessionToken><Expiration>${expires}</Expiration></Credentials>`;
    return [200, xml(`${creds}<AssumedRoleUser><Arn>${form.RoleArn ?? ""}/${form.RoleSessionName ?? "smoke"}</Arn><AssumedRoleId>stand-in:smoke</AssumedRoleId></AssumedRoleUser>`), "text/xml"];
  }
  return [400, `<ErrorResponse><Error><Code>InvalidAction</Code><Message>${action} is not answered here</Message></Error></ErrorResponse>`, "text/xml"];
}

function webhook(req) {
  if (req.method !== "POST") return [405, "only POST", "text/plain"];
  return [200, "ok", "text/plain"];
}

function cost(req, body) {
  if (req.method !== "POST" || req.url !== "/estimate") return [404, { error: "not found" }];
  const lacks = required(req);
  if (lacks) return [401, { error: lacks }];
  const changes = body?.resource_changes ?? [];
  const count = (action) => changes.filter((c) => c.change?.actions?.includes(action)).length;
  const after = count("create") * 10;
  const before = count("delete") * 10;
  const n = (x) => x.toFixed(10);
  return [200, { version: "0.2", currency: "USD", totalMonthlyCost: n(after), pastTotalMonthlyCost: n(before), diffTotalMonthlyCost: n(after - before), projects: [] }];
}

/** Why a request lacks the header REQUIRE (name=value) names, or nothing. */
function required(req) {
  const need = process.env.REQUIRE;
  if (!need) return "";
  const [name, ...rest] = need.split("=");
  return req.headers[name.toLowerCase()] === rest.join("=") ? "" : `${name} is missing or wrong`;
}

function otlp(req) {
  if (req.method !== "POST" || !/^\/v1\/(traces|metrics|logs)$/.test(req.url)) return [404, { error: "not found" }];
  const need = process.env.REQUIRE;
  if (need) {
    const [name, ...rest] = need.split("=");
    if (req.headers[name.toLowerCase()] !== rest.join("=")) return [401, { error: `${name} is missing or wrong` }];
  }
  return [200, {}];
}

// ── s3 ──
const [upHost, upPort] = (process.env.UPSTREAM ?? "floci:4566").split(":");
const held = [];
let holding = Boolean(process.env.HOLD_PATH);

function forward(req, res, payload) {
  const headers = { ...req.headers, host: `${upHost}:${upPort}`, "content-length": String(payload.length) };
  delete headers.connection;
  delete headers.expect;
  delete headers["transfer-encoding"];
  const cond = req.headers["if-match"] ? `if-match ${req.headers["if-match"]}` : req.headers["if-none-match"] ? `if-none-match ${req.headers["if-none-match"]}` : "";
  if (process.env.STRIP) {
    delete headers["if-match"];
    delete headers["if-none-match"];
  }
  const up = http.request({ host: upHost, port: Number(upPort), method: req.method, path: req.url, headers }, (r) => {
    const out = [];
    r.on("data", (d) => out.push(d));
    r.on("end", () => {
      const data = Buffer.concat(out);
      const h = req.method === "HEAD" ? { ...r.headers } : { ...r.headers, "content-length": String(data.length) };
      delete h.connection;
      delete h["transfer-encoding"];
      res.writeHead(r.statusCode ?? 502, h);
      res.end(req.method === "HEAD" ? undefined : data);
      seen.push({ method: req.method, path: req.url.split("?")[0], status: r.statusCode, cond });
    });
  });
  up.on("error", (e) => {
    res.writeHead(502);
    res.end(String(e));
    seen.push({ method: req.method, path: req.url.split("?")[0], status: 502, cond, error: e.message });
  });
  up.end(payload);
}

function s3(req, res, payload) {
  const path = req.url.split("?")[0];
  const cond = req.headers["if-match"] || req.headers["if-none-match"];
  if (req.method === "PUT" && process.env.ANSWER_501 && cond && path.endsWith("/index.json")) {
    seen.push({ method: req.method, path, status: 501, cond: req.headers["if-match"] ? "if-match" : "if-none-match" });
    res.writeHead(501, { "content-type": "application/xml" });
    return res.end("<Error><Code>NotImplemented</Code><Message>A header you provided implies functionality that is not implemented</Message></Error>");
  }
  if (req.method === "PUT" && holding && path === process.env.HOLD_PATH) {
    held.push({ req, res, payload });
    const go = () => {
      if (!holding) return;
      holding = false;
      for (const h of held.splice(0)) forward(h.req, h.res, h.payload);
    };
    if (held.length >= 2) go();
    else setTimeout(go, 60_000);
    return;
  }
  forward(req, res, payload);
}

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/_requests") return answer(res, 200, seen);
      if (mode === "s3") return s3(req, res, Buffer.concat(chunks));
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      const form = /x-www-form-urlencoded/.test(req.headers["content-type"] ?? "") ? Object.fromEntries(new URLSearchParams(raw)) : undefined;
      const [status, out, type] = mode === "webhook" ? webhook(req) : mode === "cost" ? cost(req, body) : mode === "otlp" ? otlp(req) : mode === "sts" ? sts(form ?? Object.fromEntries(new URL(req.url, "http://x").searchParams)) : decide(req, body);
      seen.push({ method: req.method, path: req.url, status, headers: req.headers, body, form });
      answer(res, status, out, type);
    });
  })
  .listen(port, () => console.log(`stand-in ${mode} on :${port}`));
