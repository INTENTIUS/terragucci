import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CACHING_DISABLED, EDGE_CODE, EDGE_CODE_LIMIT } from "../front-door/front-door";

// The template the site offers, as `just ci` rendered it.
const template = JSON.parse(readFileSync(new URL("../docs-site/public/reports-front-door.json", import.meta.url), "utf8"));
const resources = template.Resources as Record<string, { Type: string; Condition?: string; Properties: any }>;
const ofType = (type: string) => Object.entries(resources).filter(([, r]) => r.Type === type);
const one = (type: string) => {
  const found = ofType(type);
  expect(found, type).toHaveLength(1);
  return { name: found[0][0], ...found[0][1] };
};

describe("front door: the template", () => {
  const distribution = one("AWS::CloudFront::Distribution");
  const config = distribution.Properties.DistributionConfig;
  const behavior = config.DefaultCacheBehavior;

  it("serves the bucket through Origin Access Control, never in public", () => {
    const access = one("AWS::CloudFront::OriginAccessControl");
    expect(access.Properties.OriginAccessControlConfig).toMatchObject({ OriginAccessControlOriginType: "s3", SigningBehavior: "always", SigningProtocol: "sigv4" });
    expect(config.Origins).toHaveLength(1);
    expect(config.Origins[0].OriginAccessControlId).toEqual({ "Fn::GetAtt": [access.name, "Id"] });
    expect(config.Origins[0].S3OriginConfig).toEqual({ OriginAccessIdentity: "" });
    expect(JSON.stringify(config.Origins[0].DomainName)).toContain('{"Ref":"ReportsBucket"}');
  });

  it("runs the sign-in check on every viewer request, over HTTPS only, with nothing cached", () => {
    const version = one("AWS::Lambda::Version");
    expect(behavior.LambdaFunctionAssociations).toEqual([{ EventType: "viewer-request", LambdaFunctionARN: { Ref: version.name } }]);
    expect(config.CacheBehaviors).toBeUndefined();
    expect(behavior.ViewerProtocolPolicy).toBe("redirect-to-https");
    expect(behavior.AllowedMethods).toEqual(["GET", "HEAD"]);
    expect(behavior.CachePolicyId).toBe(CACHING_DISABLED);
  });

  it("answers at the domain with its certificate, and the bucket policy admits only this distribution", () => {
    expect(config.Aliases).toEqual([{ Ref: "DomainName" }]);
    expect(config.ViewerCertificate).toMatchObject({ SslSupportMethod: "sni-only", MinimumProtocolVersion: "TLSv1.2_2021" });
    const policy = one("AWS::S3::BucketPolicy");
    expect(policy.Condition).toBeDefined();
    const [statement] = policy.Properties.PolicyDocument.Statement;
    expect(statement).toMatchObject({ Effect: "Allow", Principal: { Service: "cloudfront.amazonaws.com" }, Action: "s3:GetObject" });
    expect(JSON.stringify(statement.Condition.StringEquals["AWS:SourceArn"])).toContain(`{"Fn::GetAtt":["${distribution.name}","Id"]}`);
    expect(ofType("AWS::Route53::RecordSet").map(([, r]) => r.Properties.Type).sort()).toEqual(["A", "AAAA"]);
    expect(Object.keys(template.Outputs).sort()).toEqual(["BucketPolicyStatement", "DistributionDomainName", "DistributionId", "Url"]);
  });

  it("inlines the edge code under CloudFormation's cap, and publishes a new version when it changes", () => {
    const edge = one("AWS::Lambda::Function");
    expect(edge.Properties.Code.ZipFile).toBe(EDGE_CODE);
    expect(Buffer.byteLength(EDGE_CODE)).toBeLessThan(EDGE_CODE_LIMIT);
    expect(edge.Properties).toMatchObject({ Runtime: "nodejs22.x", Handler: "index.handler", MemorySize: 128, Timeout: 5 });
    expect(edge.Properties.Environment).toBeUndefined();
    const digest = createHash("sha256").update(EDGE_CODE).digest("hex").slice(0, 16);
    expect(one("AWS::Lambda::Version").Properties.Description).toContain(digest);
    const trust = one("AWS::IAM::Role").Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service;
    expect(trust).toEqual(["lambda.amazonaws.com", "edgelambda.amazonaws.com"]);
  });
});

// ── the edge code, as deployed (the minified ZipFile) ──

type Res = { status?: string; headers: Record<string, { key: string; value: string }[]>; uri?: string; body?: string };
type Handler = (event: unknown, context: { functionName: string }) => Promise<Res>;
const edgeModule = (): { makeHandler: (deps: unknown) => Handler } => {
  const mod = { exports: {} as any };
  new Function("exports", "require", "module", EDGE_CODE)(mod.exports, createRequire(import.meta.url), mod);
  return mod.exports;
};

const ISSUER = "https://idp.acme.example";
const SETTINGS = { issuer: ISSUER, clientId: "client-1", clientSecretName: "front-door-client", domain: "reports.acme.example", allowedDomain: "", sessionHours: "12", sessionKey: "k".repeat(64) };
const DISCOVERY = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token` };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const idToken = (claims: Record<string, unknown>) => `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;

function door(over: { settings?: Partial<typeof SETTINGS>; claims?: (nonce: string) => Record<string, unknown>; tokenStatus?: number } = {}) {
  let nowMs = 1_800_000_000_000;
  const secrets: string[] = [];
  const posts: { url: string; body: URLSearchParams }[] = [];
  let lastNonce = "";
  const deps = {
    now: () => nowMs,
    secret: async (name: string) => {
      secrets.push(name);
      return name === "front-door-client" ? "s3cret" : JSON.stringify({ ...SETTINGS, ...over.settings });
    },
    fetch: async (url: string, init?: { body: string }) => {
      if (url === `${ISSUER}/.well-known/openid-configuration`) return { ok: true, status: 200, json: async () => DISCOVERY };
      if (url === DISCOVERY.token_endpoint) {
        posts.push({ url, body: new URLSearchParams(init!.body) });
        const claims = over.claims?.(lastNonce) ?? { iss: ISSUER, aud: "client-1", exp: nowMs / 1000 + 300, nonce: lastNonce, email: "ana@acme.example", email_verified: true };
        return { ok: (over.tokenStatus ?? 200) === 200, status: over.tokenStatus ?? 200, json: async () => ({ id_token: idToken(claims) }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  };
  const handler = edgeModule().makeHandler(deps);
  const ctx = { functionName: "us-east-1.front-door" };
  const request = (uri: string, opts: { querystring?: string; cookie?: string } = {}) => handler({
    Records: [{ cf: { request: { uri, querystring: opts.querystring ?? "", method: "GET", headers: opts.cookie ? { cookie: [{ key: "Cookie", value: opts.cookie }] } : {} } } }],
  }, ctx);
  const cookieOf = (res: Res, name: string) => (res.headers["set-cookie"] ?? []).map((c) => c.value).find((v) => v.startsWith(`${name}=`));
  const valueOf = (setCookie: string | undefined) => setCookie!.split(";")[0];
  // Start at a report, sign in at the identity provider, and come back.
  async function signIn(uri = "/reports/acme/infra/index.html") {
    const start = await request(uri);
    const to = new URL(start.headers.location[0].value);
    const login = valueOf(cookieOf(start, "tg_login"));
    lastNonce = to.searchParams.get("nonce")!;
    const back = await request("/_terragucci/callback", { querystring: `code=abc&state=${to.searchParams.get("state")}`, cookie: login });
    return { start, to, login, back };
  }
  return { request, signIn, cookieOf, valueOf, secrets, posts, advance: (ms: number) => { nowMs += ms; } };
}

describe("front door: the sign-in check", () => {
  it("sends a request with no session to the identity provider, remembering where it was going", async () => {
    const d = door();
    const res = await d.request("/reports/index.html", { querystring: "q=1" });
    expect(res.status).toBe("302");
    const to = new URL(res.headers.location[0].value);
    expect(`${to.origin}${to.pathname}`).toBe(DISCOVERY.authorization_endpoint);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({ response_type: "code", client_id: "client-1", redirect_uri: "https://reports.acme.example/_terragucci/callback", scope: "openid email" });
    expect(to.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
    const login = d.cookieOf(res, "tg_login")!;
    expect(login).toContain("Path=/_terragucci/");
    expect(login).toContain("Secure; HttpOnly; SameSite=Lax");
    expect(res.headers["cache-control"][0].value).toBe("no-store");
  });

  it("reads its settings from the secret named like the function, and the client secret from the one they name", async () => {
    const d = door();
    await d.request("/");
    await d.request("/");
    expect(d.secrets).toEqual(["front-door", "front-door-client"]);
    d.advance(301_000);
    await d.request("/");
    expect(d.secrets).toHaveLength(4);
  });

  it("trades the code at the token endpoint, sets a signed session and returns to the report", async () => {
    const d = door();
    const { back } = await d.signIn("/reports/acme/infra/index.html");
    expect(d.posts).toHaveLength(1);
    expect(Object.fromEntries(d.posts[0].body)).toEqual({ grant_type: "authorization_code", code: "abc", redirect_uri: "https://reports.acme.example/_terragucci/callback", client_id: "client-1", client_secret: "s3cret" });
    expect(back.status).toBe("302");
    expect(back.headers.location[0].value).toBe("/reports/acme/infra/index.html");
    const session = d.cookieOf(back, "tg_session")!;
    expect(session).toContain(`Max-Age=${12 * 3600}`);
    expect(session).toContain("Path=/;");
    expect(d.cookieOf(back, "tg_login")).toContain("Max-Age=0");

    const through = await d.request("/reports/acme/infra/", { cookie: `other=1; ${d.valueOf(session)}` });
    expect(through.status).toBeUndefined();
    expect(through.uri).toBe("/reports/acme/infra/index.html");
    expect(through.headers.cookie).toBeUndefined();
  });

  it("refuses a callback whose state is not the one this browser started", async () => {
    const d = door();
    const start = await d.request("/");
    const res = await d.request("/_terragucci/callback", { querystring: "code=abc&state=0000", cookie: d.valueOf(d.cookieOf(start, "tg_login")) });
    expect(res.status).toBe("403");
    expect(d.posts).toHaveLength(0);
    expect((await d.request("/_terragucci/callback", { querystring: "code=abc&state=0000" })).status).toBe("403");
  });

  it.each([
    ["another issuer", (n: string) => ({ iss: "https://evil.example", aud: "client-1", exp: 2e9, nonce: n, email: "ana@acme.example" })],
    ["another audience", (n: string) => ({ iss: ISSUER, aud: ["client-2"], exp: 2e9, nonce: n, email: "ana@acme.example" })],
    ["another nonce", () => ({ iss: ISSUER, aud: "client-1", exp: 2e9, nonce: "replayed", email: "ana@acme.example" })],
    ["an expired token", (n: string) => ({ iss: ISSUER, aud: "client-1", exp: 1, nonce: n, email: "ana@acme.example" })],
  ])("refuses an ID token from %s", async (_why, claims) => {
    const d = door({ claims });
    const { back } = await d.signIn();
    expect(back.status).toBe("403");
    expect(d.cookieOf(back, "tg_session")).toBeUndefined();
  });

  it("refuses when the identity provider refuses the code", async () => {
    const { back } = await door({ tokenStatus: 400 }).signIn();
    expect(back.status).toBe("403");
  });

  it("lets in only the allowed email domain, verified", async () => {
    const at = (email: string, verified = true) => door({ settings: { allowedDomain: "acme.example" }, claims: (n) => ({ iss: ISSUER, aud: "client-1", exp: 2e9, nonce: n, email, email_verified: verified }) });
    expect((await at("ana@ACME.example").signIn()).back.status).toBe("302");
    expect((await at("ana@other.example").signIn()).back.status).toBe("403");
    expect((await at("ana@evilacme.example").signIn()).back.status).toBe("403");
    expect((await at("ana@acme.example", false).signIn()).back.status).toBe("403");
  });

  it("never takes a login cookie, a forged session or an expired one for a sign-in", async () => {
    const d = door();
    const { login, back } = await d.signIn();
    const session = d.valueOf(d.cookieOf(back, "tg_session"));
    const asSession = `tg_session=${login.slice("tg_login=".length)}`;
    expect((await d.request("/x.html", { cookie: asSession })).status).toBe("302");
    const [payload, sig] = session.slice("tg_session=".length).split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), e: "mallory" })).toString("base64url");
    expect((await d.request("/x.html", { cookie: `tg_session=${forged}.${sig}` })).status).toBe("302");
    expect((await d.request("/x.html", { cookie: session })).status).toBeUndefined();
    d.advance(12 * 3600 * 1000 + 1000);
    expect((await d.request("/x.html", { cookie: session })).status).toBe("302");
  });

  it("signs out by clearing the session", async () => {
    const d = door();
    const res = await d.request("/_terragucci/logout");
    expect(res.status).toBe("200");
    expect(d.cookieOf(res, "tg_session")).toContain("Max-Age=0");
  });
});
