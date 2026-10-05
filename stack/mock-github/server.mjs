// A small stateful GitHub for the validation stack's github profile.
//
// GitHub has no self-hostable edition, so this answers the API calls
// terragucci makes and serves the repos' git over smart HTTP (git
// http-backend). Dependency-free node; it needs git on PATH. Everything lives
// under MOCK_DATA (default /tmp/mock-github) and goes away with the container.
//
//   POST   /api/v3/user/repos                     create a repo for the token's user
//   GET    /api/v3/repos/:o/:r                    repo, with default_branch
//   DELETE /api/v3/repos/:o/:r
//   GET    /api/v3/repos/:o/:r/branches/:branch
//   GET    /api/v3/repos/:o/:r/pulls?state=&head=owner:branch
//   POST   /api/v3/repos/:o/:r/pulls              open a pull request
//   GET    /api/v3/repos/:o/:r/pulls/:n
//   PATCH  /api/v3/repos/:o/:r/pulls/:n           state=closed|open
//   PUT    /api/v3/repos/:o/:r/pulls/:n/merge     a merge commit on the base branch
//   GET|POST /api/v3/repos/:o/:r/issues/:n/comments, PATCH .../issues/comments/:id
//   POST   /api/v3/repos/:o/:r/statuses/:sha        a commit status
//   GET    /api/v3/repos/:o/:r/commits/:sha/statuses newest first
//   GET|POST /:o/:r.git/...                       git; a push needs the token
//
// Auth: `Authorization: Bearer <token>` or `token <token>` on the API, and
// basic auth with the token as the password for git (what `oauth2:<token>@`
// sends). The token is MOCK_TOKEN. Reads of the API and git fetches are open,
// like a public repo on GitHub.
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8188);
const DATA = process.env.MOCK_DATA ?? "/tmp/mock-github";
const TOKEN = process.env.MOCK_TOKEN ?? "tg-mock-github-token";
const USER = process.env.MOCK_USER ?? "terragucci-admin";
const PUBLIC = process.env.MOCK_PUBLIC_URL ?? `http://localhost:${PORT}`;
mkdirSync(DATA, { recursive: true });

/** repo full name -> { pulls: [], comments: [] } */
const state = new Map();
const repoDir = (o, r) => join(DATA, o, `${r}.git`);
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function json(res, code, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
const notFound = (res) => json(res, 404, { message: "Not Found" });
const readBody = (req) => new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });

function authed(req) {
  const h = req.headers.authorization ?? "";
  if (/^(Bearer|token) /i.test(h)) return h.replace(/^\S+ /, "") === TOKEN;
  if (/^Basic /i.test(h)) return Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":") === TOKEN;
  return false;
}

function repoJson(o, r) {
  const dir = repoDir(o, r);
  let branch = "main";
  try { branch = git(dir, "symbolic-ref", "--short", "HEAD"); } catch { /* keep main */ }
  return { id: 1, name: r, full_name: `${o}/${r}`, private: false, owner: { login: o }, default_branch: branch, html_url: `${PUBLIC}/${o}/${r}`, clone_url: `${PUBLIC}/${o}/${r}.git` };
}
const sha = (dir, ref) => { try { return git(dir, "rev-parse", "--verify", `refs/heads/${ref}`); } catch { return null; } };

function pullJson(o, r, p) {
  const dir = repoDir(o, r);
  return {
    number: p.number, state: p.state, title: p.title, body: p.body, merged: p.merged,
    html_url: `${PUBLIC}/${o}/${r}/pull/${p.number}`,
    head: { ref: p.head, sha: sha(dir, p.head), label: `${o}:${p.head}` },
    base: { ref: p.base, sha: sha(dir, p.base) },
  };
}

function merge(o, r, p) {
  const tmp = mkdtempSync(join(DATA, "merge-"));
  try {
    git(tmp, "init", "-q"); // a plain repo to merge in; the bare one is only fetched from and pushed to
    git(tmp, "fetch", "-q", repoDir(o, r), `+refs/heads/${p.base}:refs/remotes/o/${p.base}`, `+refs/heads/${p.head}:refs/remotes/o/${p.head}`);
    git(tmp, "checkout", "-q", "-B", p.base, `o/${p.base}`);
    git(tmp, "-c", "user.name=mock-github", "-c", "user.email=mock@github.local", "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", `Merge pull request #${p.number} from ${p.head}`, `o/${p.head}`);
    git(tmp, "push", "-q", repoDir(o, r), `HEAD:refs/heads/${p.base}`);
    return git(tmp, "rev-parse", "HEAD");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function backend(req, res, url, body) {
  const m = url.pathname.match(/^\/([^/]+)\/([^/]+?)\.git(\/.*)?$/);
  const [, o, r, rest = "/"] = m;
  if (!existsSync(repoDir(o, r))) return notFound(res);
  const push = url.searchParams.get("service") === "git-receive-pack" || rest.endsWith("git-receive-pack");
  if (push && !authed(req)) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="mock-github"' });
    return res.end();
  }
  const child = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: join(DATA, o), GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${r}.git${rest}`, REQUEST_METHOD: req.method, QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "", HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
      REMOTE_USER: USER, REMOTE_ADDR: "127.0.0.1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.receivepack", GIT_CONFIG_VALUE_0: "true",
    },
  });
  child.stdin.end(body);
  const chunks = [];
  child.stdout.on("data", (d) => chunks.push(d));
  child.on("close", () => {
    const out = Buffer.concat(chunks);
    const split = out.indexOf("\r\n\r\n");
    const head = out.subarray(0, split).toString().split("\r\n");
    const headers = {};
    let status = 200;
    for (const line of head) {
      const i = line.indexOf(":");
      const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
      if (k.toLowerCase() === "status") status = Number.parseInt(v, 10);
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.end(out.subarray(split + 4));
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const body = await readBody(req).catch(() => "");
  try {
    if (url.pathname === "/__mock/health") return json(res, 200, { ok: true });
    if (/^\/[^/]+\/[^/]+?\.git(\/|$)/.test(url.pathname)) return backend(req, res, url, body);

    const path = url.pathname.replace(/^\/api\/v3/, "");
    if (!url.pathname.startsWith("/api/v3/")) return notFound(res);
    if (req.method !== "GET" && !authed(req)) return json(res, 401, { message: "Bad credentials" });
    const seg = path.split("/").filter(Boolean).map(decodeURIComponent);
    const data = body.length ? JSON.parse(body.toString()) : {};

    if (req.method === "POST" && path === "/user/repos") {
      const dir = repoDir(USER, data.name);
      if (existsSync(dir)) return json(res, 422, { message: "name already exists on this account" });
      mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q", "--bare", "-b", data.default_branch ?? "main");
      state.set(`${USER}/${data.name}`, { pulls: [], comments: [] });
      return json(res, 201, repoJson(USER, data.name));
    }
    if (seg[0] !== "repos" || seg.length < 3) return notFound(res);
    const [, o, r] = seg;
    if (!existsSync(repoDir(o, r))) return notFound(res);
    const st = state.get(`${o}/${r}`) ?? (state.set(`${o}/${r}`, { pulls: [], comments: [] }), state.get(`${o}/${r}`));
    const rest = seg.slice(3);

    if (rest.length === 0) {
      if (req.method === "GET") return json(res, 200, repoJson(o, r));
      if (req.method === "DELETE") { rmSync(repoDir(o, r), { recursive: true, force: true }); state.delete(`${o}/${r}`); return json(res, 204); }
    }
    if (rest[0] === "branches" && req.method === "GET") {
      const name = rest.slice(1).join("/");
      const s = sha(repoDir(o, r), name);
      return s ? json(res, 200, { name, commit: { sha: s } }) : notFound(res);
    }
    if (rest[0] === "statuses" && rest.length === 2 && req.method === "POST") {
      st.statuses ??= [];
      const s = { id: st.statuses.length + 1, sha: rest[1], state: data.state, context: data.context ?? "default", description: data.description ?? null, target_url: data.target_url ?? null };
      st.statuses.push(s);
      return json(res, 201, s);
    }
    if (rest[0] === "commits" && rest[2] === "statuses" && rest.length === 3 && req.method === "GET") {
      return json(res, 200, (st.statuses ?? []).filter((s) => s.sha === rest[1]).reverse());
    }
    if (rest[0] === "pulls" && rest.length === 1) {
      if (req.method === "GET") {
        const want = url.searchParams.get("state") ?? "open";
        const head = url.searchParams.get("head");
        const list = st.pulls.filter((p) => (want === "all" || p.state === want) && (!head || head === `${o}:${p.head}` || head === p.head));
        return json(res, 200, list.map((p) => pullJson(o, r, p)));
      }
      if (req.method === "POST") {
        const dir = repoDir(o, r);
        if (!sha(dir, data.head) || !sha(dir, data.base)) return json(res, 422, { message: "Validation Failed: head or base is not a branch" });
        if (sha(dir, data.head) === sha(dir, data.base)) return json(res, 422, { message: "Validation Failed: no commits between base and head" });
        const p = { number: st.pulls.length + 1, state: "open", merged: false, head: data.head, base: data.base, title: data.title ?? "", body: data.body ?? "" };
        st.pulls.push(p);
        return json(res, 201, pullJson(o, r, p));
      }
    }
    if (rest[0] === "pulls" && rest.length >= 2) {
      const p = st.pulls.find((x) => x.number === Number(rest[1]));
      if (!p) return notFound(res);
      if (rest[2] === "merge" && req.method === "PUT") {
        if (p.state !== "open") return json(res, 405, { message: "Pull Request is not mergeable" });
        const merged = merge(o, r, p);
        p.state = "closed"; p.merged = true;
        return json(res, 200, { merged: true, sha: merged, message: "Pull Request successfully merged" });
      }
      if (rest.length === 2 && req.method === "GET") return json(res, 200, pullJson(o, r, p));
      if (rest.length === 2 && req.method === "PATCH") { if (data.state) p.state = data.state; return json(res, 200, pullJson(o, r, p)); }
    }
    if (rest[0] === "issues") {
      if (rest[1] === "comments" && rest.length === 3 && req.method === "PATCH") {
        const c = st.comments.find((x) => x.id === Number(rest[2]));
        if (!c) return notFound(res);
        c.body = data.body ?? c.body;
        return json(res, 200, c);
      }
      if (rest[2] === "comments") {
        const number = Number(rest[1]);
        if (req.method === "GET") return json(res, 200, st.comments.filter((c) => c.issue === number));
        if (req.method === "POST") {
          const c = { id: st.comments.length + 1, issue: number, body: data.body ?? "", user: { login: USER } };
          st.comments.push(c);
          return json(res, 201, c);
        }
      }
    }
    return notFound(res);
  } catch (e) {
    return json(res, 500, { message: String(e.stderr ?? e.message ?? e) });
  }
}).listen(PORT, () => console.log(`mock-github on :${PORT}, data in ${DATA}`));
