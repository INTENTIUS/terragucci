// The Prow smoke test's stand-in for GitHub, run inside the scratch cluster
// in the terragucci image (node and git). One HTTP server on port 8080:
//
//   /<owner>/<repo>.git/...  the repository over git's smart HTTP
//                            (git-http-backend), which clonerefs clones from
//                            and the smoke test pushes to
//   /api/v3/...              the GitHub REST calls the jobs make: pull
//                            requests, labels, comments, statuses, issues
//   /_smoke/state            GET dumps what the jobs posted and every request;
//                            PUT replaces the pull requests the jobs read and
//                            clears what they posted
//   /_smoke/artifact?key=    one object of the job artifacts in MinIO
//
// Nothing here reaches outside the cluster. A request the stand-in has no
// answer for is logged and answered 404, so the test shows what a job asked.
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const ROOT = process.env.GIT_ROOT ?? "/srv/git";
const TOKEN_LOGIN = process.env.TOKEN_LOGIN ?? "smoke-bot";
const BACKEND = ["/usr/lib/git-core/git-http-backend", "/usr/libexec/git-core/git-http-backend"].find((p) => existsSync(p));

/** What the jobs read: pull requests by number, each with its head, labels, comments and, once merged, its merge commit. */
let pulls = {};
let comments = [];
let statuses = [];
let issues = [];
let requests = [];
let nextId = 1000;

const now = () => new Date().toISOString();

function resetState(body) {
  pulls = {};
  comments = [];
  statuses = [];
  issues = [];
  // The request log runs across resets, so a run's dump shows every call its jobs made.
  for (const p of body.pulls ?? []) {
    pulls[p.number] = p;
    for (const c of p.comments ?? []) comments.push({ id: nextId++, issue: p.number, body: c.body, user: c.user, created_at: c.created_at ?? now() });
  }
}

const pullJson = (repo, p) => ({
  number: p.number,
  state: p.merged ? "closed" : "open",
  title: p.title ?? `change ${p.number}`,
  body: p.body ?? "",
  user: { login: p.author, id: 1 },
  head: { ref: p.head_ref ?? `change-${p.number}`, sha: p.head, repo: { full_name: p.head_repo ?? repo } },
  base: { ref: p.base ?? "main", sha: p.base_sha ?? "", repo: { full_name: repo } },
  merged: Boolean(p.merged),
  merged_at: p.merged ? p.merged_at ?? now() : null,
  merge_commit_sha: p.merge_commit ?? null,
  labels: (p.labels ?? []).map((name) => ({ name })),
  html_url: `http://fakegh/${repo}/pull/${p.number}`,
});

const commentJson = (repo, c) => ({
  id: c.id,
  body: c.body,
  user: { login: c.user, id: c.user === TOKEN_LOGIN ? 2 : 3, type: c.user === TOKEN_LOGIN ? "Bot" : "User" },
  created_at: c.created_at,
  updated_at: c.updated_at ?? c.created_at,
  html_url: `http://fakegh/${repo}/pull/${c.issue}#issuecomment-${c.id}`,
  issue_url: `http://fakegh/api/v3/repos/${repo}/issues/${c.issue}`,
});

function api(method, path, query, body) {
  let m;
  if (method === "GET" && path === "/user") return [200, { login: TOKEN_LOGIN, id: 2, type: "Bot" }];
  if (!(m = path.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/))) return [404, { message: "Not Found" }];
  const repo = m[1];
  const rest = m[2] ?? "";
  if (method === "GET" && rest === "") return [200, { full_name: repo, default_branch: "main", private: true }];
  if (method === "GET" && (m = rest.match(/^\/commits\/([0-9a-f]{7,40})\/pulls$/))) {
    const sha = m[1];
    return [200, Object.values(pulls).filter((p) => p.merge_commit?.startsWith(sha) || p.head.startsWith(sha)).map((p) => pullJson(repo, p))];
  }
  if (method === "GET" && rest === "/pulls") {
    const state = query.get("state") ?? "open";
    const base = query.get("base");
    const page = Number(query.get("page") ?? "1");
    const list = Object.values(pulls).filter((p) => (state === "all" || (state === "open") === !p.merged) && (!base || (p.base ?? "main") === base));
    return [200, page === 1 ? list.map((p) => pullJson(repo, p)) : []];
  }
  if (method === "GET" && (m = rest.match(/^\/pulls\/(\d+)$/))) {
    const p = pulls[m[1]];
    return p ? [200, pullJson(repo, p)] : [404, { message: "Not Found" }];
  }
  if (method === "GET" && (m = rest.match(/^\/pulls\/(\d+)\/(commits|files|reviews)$/))) {
    const p = pulls[m[1]];
    if (!p) return [404, { message: "Not Found" }];
    if (m[2] === "commits") return [200, (p.commits ?? [p.head]).map((sha) => ({ sha, author: { login: p.author }, committer: { login: p.author }, commit: { author: { name: p.author, email: `${p.author}@example.invalid` }, committer: { name: p.author, email: `${p.author}@example.invalid` } } }))];
    return [200, []];
  }
  if (method === "GET" && (m = rest.match(/^\/issues\/(\d+)\/labels$/))) {
    const p = pulls[m[1]];
    return p ? [200, (p.labels ?? []).map((name) => ({ name }))] : [404, { message: "Not Found" }];
  }
  if (method === "GET" && (m = rest.match(/^\/issues\/(\d+)\/comments$/))) {
    const page = Number(query.get("page") ?? "1");
    const all = comments.filter((c) => c.issue === Number(m[1])).map((c) => commentJson(repo, c));
    return [200, page === 1 ? all : []];
  }
  if (method === "POST" && (m = rest.match(/^\/issues\/(\d+)\/comments$/))) {
    const c = { id: nextId++, issue: Number(m[1]), body: String(body?.body ?? ""), user: TOKEN_LOGIN, created_at: now() };
    comments.push(c);
    return [201, commentJson(repo, c)];
  }
  if ((method === "PATCH" || method === "POST") && (m = rest.match(/^\/issues\/comments\/(\d+)$/))) {
    const c = comments.find((x) => x.id === Number(m[1]));
    if (!c) return [404, { message: "Not Found" }];
    c.body = String(body?.body ?? c.body);
    c.updated_at = now();
    return [200, commentJson(repo, c)];
  }
  if (method === "POST" && (m = rest.match(/^\/statuses\/([0-9a-f]{40})$/))) {
    const s = { id: nextId++, sha: m[1], ...body, created_at: now() };
    statuses.push(s);
    return [201, s];
  }
  if (method === "GET" && (m = rest.match(/^\/commits\/([0-9a-f]{7,40})\/(statuses|status)$/))) {
    const list = statuses.filter((s) => s.sha.startsWith(m[1])).reverse();
    return [200, m[2] === "status" ? { state: list[0]?.state ?? "pending", statuses: list } : list];
  }
  if (method === "GET" && rest === "/issues") {
    const state = query.get("state") ?? "open";
    const labels = (query.get("labels") ?? "").split(",").filter(Boolean);
    return [200, issues.filter((i) => (state === "all" || i.state === state) && labels.every((l) => i.labels.some((x) => x.name === l)))];
  }
  if (method === "POST" && rest === "/issues") {
    const i = { number: 900 + issues.length, title: body?.title, body: body?.body, state: "open", labels: (body?.labels ?? []).map((name) => ({ name })), user: { login: TOKEN_LOGIN }, html_url: `http://fakegh/${repo}/issues/${900 + issues.length}` };
    issues.push(i);
    return [201, i];
  }
  if (method === "PATCH" && (m = rest.match(/^\/issues\/(\d+)$/))) {
    const i = issues.find((x) => x.number === Number(m[1]));
    if (!i) return [404, { message: "Not Found" }];
    Object.assign(i, body);
    return [200, i];
  }
  return [404, { message: "Not Found", documentation_url: "the Prow smoke test's fake GitHub has no answer for this" }];
}

// ── MinIO, read with SigV4, for the job artifacts ─────────────────────────────
const hmac = (key, s) => createHmac("sha256", key).update(s).digest();
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
async function artifact(key) {
  const host = process.env.S3_ENDPOINT ?? "minio.prow.svc.cluster.local:9000";
  const bucket = process.env.S3_BUCKET ?? "prow-logs";
  const access = process.env.S3_ACCESS_KEY;
  const secret = process.env.S3_SECRET_KEY;
  const region = "minio";
  const path = `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payload = sha256("");
  const canonical = ["GET", path, "", `host:${host}`, `x-amz-content-sha256:${payload}`, `x-amz-date:${amzDate}`, "", "host;x-amz-content-sha256;x-amz-date", payload].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const signing = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signing).update(toSign).digest("hex");
  const r = await fetch(`http://${host}${path}`, {
    headers: {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payload,
      authorization: `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    },
  });
  return [r.status, Buffer.from(await r.arrayBuffer())];
}

// ── git over smart HTTP ──────────────────────────────────────────────────────
function ensureRepo(name) {
  const dir = join(ROOT, `${name}.git`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", dir]);
    spawnSync("git", ["-C", dir, "config", "http.receivepack", "true"]);
    spawnSync("git", ["-C", dir, "config", "uploadpack.allowAnySHA1InWant", "true"]);
  }
}

function git(req, res, url) {
  const m = url.pathname.match(/^\/([^/]+\/[^/]+)\.git(\/.*)$/);
  ensureRepo(m[1]);
  const child = spawn(BACKEND, [], {
    env: {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: ROOT,
      GIT_HTTP_EXPORT_ALL: "1",
      REMOTE_USER: "smoke",
      REQUEST_METHOD: req.method,
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
      ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
      ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: req.headers["git-protocol"] } : {}),
    },
  });
  req.pipe(child.stdin);
  let head = Buffer.alloc(0);
  let sent = false;
  child.stdout.on("data", (chunk) => {
    if (sent) return void res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    const lines = head.subarray(0, end).toString().split("\r\n");
    let status = 200;
    for (const l of lines) {
      const i = l.indexOf(":");
      const k = l.slice(0, i).trim();
      const v = l.slice(i + 1).trim();
      if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]);
      else res.setHeader(k, v);
    }
    res.writeHead(status);
    sent = true;
    res.write(head.subarray(end + 4));
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  child.on("close", () => res.end());
}

createServer((req, res) => {
  const url = new URL(req.url, "http://fakegh");
  if (/^\/[^/]+\/[^/]+\.git\//.test(url.pathname)) return git(req, res, url);
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString();
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/healthz") return send(200, { ok: true });
    if (url.pathname === "/_smoke/state") {
      if (req.method === "PUT") {
        resetState(body ?? {});
        return send(200, { ok: true });
      }
      return send(200, { pulls, comments, statuses, issues, requests });
    }
    if (url.pathname === "/_smoke/artifact") {
      const [status, data] = await artifact(url.searchParams.get("key") ?? "");
      res.writeHead(status, { "content-type": "application/octet-stream" });
      return res.end(data);
    }
    if (url.pathname.startsWith("/api/v3/")) {
      const path = url.pathname.slice("/api/v3".length);
      const [status, value] = api(req.method, path, url.searchParams, body);
      requests.push({ at: now(), method: req.method, path: `${path}${url.search}`, status, token: Boolean(req.headers.authorization) });
      if (status === 404) console.log(`no answer: ${req.method} ${path}${url.search}`);
      return send(status, value);
    }
    return send(404, { message: "Not Found" });
  });
}).listen(8080, () => console.log("fake GitHub on :8080"));
