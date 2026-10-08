// A stand-in service for the smoke claims (stack/smoke.sh) that need a
// service the stack does not run: a typed-decision service in the Jev shape,
// an OTLP/HTTP collector that wants a header, or an STS that says which roles
// it was asked for. It runs in a CI image (they all carry node) on the
// stack's network.
//
//   MODE=decide  POST /v1/systemone answers every noul question with NOUL
//                (default 0.95), as the model the request pins (or MODEL)
//   MODE=otlp    POST /v1/traces and /v1/metrics answer 200, or 401 when
//                REQUIRE names a header (name=value) the request lacks
//   MODE=sts     AWS STS: AssumeRoleWithWebIdentity and AssumeRole answer
//                keys for any role (floci takes any keys), and
//                GetCallerIdentity answers the account 000000000000
//
// It listens on PORT (default 8790). GET /_requests lists every request it
// took, in order: method, path, status, headers, the body as JSON when it
// parses, and a form body's fields as form (the claims read this from the
// host through a published port).
import http from "node:http";

const mode = process.env.MODE ?? "decide";
const port = Number(process.env.PORT ?? 8790);
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

function otlp(req) {
  if (req.method !== "POST" || !/^\/v1\/(traces|metrics|logs)$/.test(req.url)) return [404, { error: "not found" }];
  const need = process.env.REQUIRE;
  if (need) {
    const [name, ...rest] = need.split("=");
    if (req.headers[name.toLowerCase()] !== rest.join("=")) return [401, { error: `${name} is missing or wrong` }];
  }
  return [200, {}];
}

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/_requests") return answer(res, 200, seen);
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      const form = /x-www-form-urlencoded/.test(req.headers["content-type"] ?? "") ? Object.fromEntries(new URLSearchParams(raw)) : undefined;
      const [status, out, type] = mode === "otlp" ? otlp(req) : mode === "sts" ? sts(form ?? Object.fromEntries(new URL(req.url, "http://x").searchParams)) : decide(req, body);
      seen.push({ method: req.method, path: req.url, status, headers: req.headers, body, form });
      answer(res, status, out, type);
    });
  })
  .listen(port, () => console.log(`stand-in ${mode} on :${port}`));
