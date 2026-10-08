// The sign-in check of the reports front door: a Lambda@Edge function on every
// viewer request of the distribution (front-door/front-door.ts).
//
// A request with a valid session cookie goes on to the bucket. Any other
// request is sent to the identity provider (OpenID Connect, authorization code
// flow); its answer comes back to /_terragucci/callback, where the code is
// traded for an ID token at the token endpoint and the session cookie is set.
// Both cookies are HMAC-SHA256 signed with the stack's generated key, each
// under its own kind, so a login cookie never passes as a session.
//
// Lambda@Edge has no environment variables, so the settings live in the
// stack's secret, named like the function, and the client secret in the
// secret that names; the function reads both at start and again every five
// minutes. The ID token comes straight from the token
// endpoint over TLS, so its claims are checked and its signature is not
// (OpenID Connect Core 3.1.3.7).
//
// The composite minifies this file into the template's inline code, which
// CloudFormation caps at 4096 bytes; test/front-door.test.ts holds it under.
"use strict";
const crypto = require("node:crypto");

const PREFIX = "/_terragucci/";
const CALLBACK = PREFIX + "callback";
const LOGOUT = PREFIX + "logout";
const SESSION = "tg_session";
const LOGIN = "tg_login";
const LOGIN_SECONDS = 600;
const CONFIG_MS = 300000;

function mac(kind, payload, key) {
  return crypto.createHmac("sha256", key).update(kind + "." + payload).digest("base64url");
}

function sign(kind, value, key) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return payload + "." + mac(kind, payload, key);
}

// The signed value, or null when the token is missing, forged, of another kind or expired.
function verify(kind, token, key, now) {
  const parts = (token || "").split(".");
  if (parts.length !== 2) return null;
  const want = Buffer.from(mac(kind, parts[0], key));
  const got = Buffer.from(parts[1]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    return typeof value.x === "number" && value.x > now ? value : null;
  } catch {
    return null;
  }
}

function cookies(headers) {
  const out = {};
  for (const h of headers.cookie || []) {
    for (const pair of h.value.split(";")) {
      const i = pair.indexOf("=");
      if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }
  return out;
}

function cookie(name, value, seconds, path) {
  return name + "=" + value + "; Path=" + path + "; Max-Age=" + seconds + "; Secure; HttpOnly; SameSite=Lax";
}

function respond(status, extra, setCookies, body) {
  const headers = { "cache-control": [{ key: "Cache-Control", value: "no-store" }] };
  for (const [key, value] of Object.entries(extra)) headers[key.toLowerCase()] = [{ key, value }];
  if (setCookies.length) headers["set-cookie"] = setCookies.map((value) => ({ key: "Set-Cookie", value }));
  return body === undefined ? { status, headers } : { status, headers, body };
}

const redirect = (location, setCookies) => respond("302", { Location: location }, setCookies);
const deny = (message) => respond("403", { "Content-Type": "text/plain; charset=utf-8" }, [], message + "\n");

// Who signed in (email, else subject), or null when the ID token is not for this login.
function signedIn(claims, cfg, idp, nonce, now) {
  if (!claims || claims.iss !== idp.issuer || claims.nonce !== nonce) return null;
  if (!(typeof claims.exp === "number" && claims.exp > now)) return null;
  if (![].concat(claims.aud).includes(cfg.clientId)) return null;
  if (cfg.allowedDomain) {
    const email = String(claims.email || "").toLowerCase();
    if (!email.endsWith("@" + cfg.allowedDomain.toLowerCase()) || claims.email_verified === false) return null;
  }
  return claims.email || claims.sub;
}

function idClaims(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString());
  } catch {
    return null;
  }
}

async function readSecret(name) {
  const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
  const out = await new SecretsManagerClient({ region: "us-east-1" }).send(new GetSecretValueCommand({ SecretId: name }));
  return out.SecretString;
}

function makeHandler(deps) {
  let loaded;
  async function settings(functionName) {
    if (loaded && deps.now() - loaded.at < CONFIG_MS) return loaded;
    // At the edge the function is named "us-east-1.<name>"; the secret is "<name>".
    const cfg = JSON.parse(await deps.secret(functionName.replace(/^us-east-1\./, "")));
    cfg.clientSecret = await deps.secret(cfg.clientSecretName);
    const res = await deps.fetch(cfg.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration");
    if (!res.ok) throw new Error("OpenID discovery answered " + res.status);
    loaded = { at: deps.now(), cfg, idp: await res.json() };
    return loaded;
  }

  async function callback(req, cfg, idp, jar, now) {
    const query = new URLSearchParams(req.querystring);
    const login = verify(LOGIN, jar[LOGIN], cfg.sessionKey, now);
    if (!login || !query.get("code") || query.get("state") !== login.s) return deny("This sign-in did not start here. Open the report again.");
    const redirectUri = "https://" + cfg.domain + CALLBACK;
    // client_secret_post: Google, Microsoft Entra ID, Okta and Auth0 all take it.
    const form = new URLSearchParams({ grant_type: "authorization_code", code: query.get("code"), redirect_uri: redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret });
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    const res = await deps.fetch(idp.token_endpoint, { method: "POST", headers, body: form.toString() });
    if (!res.ok) return deny("The identity provider refused the sign-in.");
    const who = signedIn(idClaims((await res.json()).id_token), cfg, idp, login.n, now);
    if (!who) return deny("This account may not open these reports.");
    const seconds = Math.round(Number(cfg.sessionHours || 12) * 3600);
    const back = /^\/(?![/\\])/.test(login.r) ? login.r : "/";
    return redirect(back, [cookie(SESSION, sign(SESSION, { e: who, x: now + seconds }, cfg.sessionKey), seconds, "/"), cookie(LOGIN, "", 0, PREFIX)]);
  }

  return async (event, context) => {
    const req = event.Records[0].cf.request;
    const { cfg, idp } = await settings(context.functionName);
    const jar = cookies(req.headers);
    const now = Math.floor(deps.now() / 1000);
    if (req.uri === CALLBACK) return callback(req, cfg, idp, jar, now);
    if (req.uri === LOGOUT) return respond("200", { "Content-Type": "text/plain; charset=utf-8" }, [cookie(SESSION, "", 0, "/")], "Signed out.\n");
    if (verify(SESSION, jar[SESSION], cfg.sessionKey, now)) {
      if (req.uri.endsWith("/")) req.uri += "index.html";
      delete req.headers.cookie;
      return req;
    }
    const state = crypto.randomBytes(16).toString("hex");
    const nonce = crypto.randomBytes(16).toString("hex");
    const back = req.uri + (req.querystring ? "?" + req.querystring : "");
    const to = new URL(idp.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: cfg.clientId, redirect_uri: "https://" + cfg.domain + CALLBACK, scope: "openid email", state, nonce })) to.searchParams.set(k, v);
    return redirect(to.toString(), [cookie(LOGIN, sign(LOGIN, { s: state, n: nonce, r: back, x: now + LOGIN_SECONDS }, cfg.sessionKey), LOGIN_SECONDS, PREFIX)]);
  };
}

exports.makeHandler = makeHandler;
exports.handler = makeHandler({ fetch: (url, init) => fetch(url, init), secret: readSecret, now: Date.now });
