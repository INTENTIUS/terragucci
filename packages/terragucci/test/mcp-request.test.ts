import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { overrideChantNext, type ChantProductMcpHook } from "../src/chant-next";
import { loadConfig } from "../src/config";
import type { Fetch } from "../src/forge";
import { mcp, productHook, PROPOSE_TOOLS, PROPOSED_FOOTER, serve, TOOLS, type McpOptions } from "../src/mcp";
import { bareFrom, git, tmp, write } from "./helpers";

const CATALOG = readFileSync(join(__dirname, "fixtures/templates/catalog.json"), "utf-8");

const CONFIG = `forge: forgejo
url: https://forge.test/acme/infra
token_env: FORGE_TOKEN
modules:
  registry:
    dir: registry
    url: https://modules.test
    namespace: acme
generate:
  backend:
    s3:
      bucket: state
      key: "{root}/terraform.tfstate"
      region: us-east-1
  providers:
    aws:
      source: hashicorp/aws
      version: "~> 5.0"
      region: us-east-1
  required_version: ">= 1.14.0"
templates: {}
`;

/** A forgejo answering what a request asks: whose token it is, the default branch, the open pull requests, and a new one. */
function fakeForge() {
  const pulls: { number: number; html_url: string; title: string; body: string; head: { ref: string; repo: { full_name: string } }; base: { ref: string } }[] = [];
  const calls: { method: string; path: string; body?: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v1/, "");
    calls.push({ method, path, ...(init?.body !== undefined ? { body: init.body } : {}) });
    let out: unknown = [];
    if (path === "/user") out = { login: "agent-bot" };
    else if (path === "/repos/acme/infra") out = { default_branch: "main", full_name: "acme/infra" };
    else if (method === "GET" && path === "/repos/acme/infra/pulls") out = (u.searchParams.get("page") ?? "1") === "1" ? pulls : [];
    else if (method === "POST" && path === "/repos/acme/infra/pulls") {
      const b = JSON.parse(init!.body!) as { head: string; base: string; title: string; body: string };
      const pr = { number: 7 + pulls.length, html_url: `https://forge.test/acme/infra/pulls/${7 + pulls.length}`, title: b.title, body: b.body, head: { ref: b.head, repo: { full_name: "acme/infra" } }, base: { ref: b.base } };
      pulls.push(pr);
      out = pr;
    }
    return { ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out) };
  };
  return { fetch, pulls, opened: () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/pulls")) };
}

/** A clone of a bare origin holding the config and the fixture catalog, and the server's options over it. */
async function requesting(propose = true) {
  const bare = bareFrom(write(tmp(), { "terragucci.yml": CONFIG, "registry/catalog/index.json": CATALOG }));
  const dir = tmp();
  git(dir, "clone", "-q", bare, ".");
  const forge = fakeForge();
  const o: McpOptions = { cwd: dir, config: await loadConfig(join(dir, "terragucci.yml")), env: { FORGE_TOKEN: "t", PATH: process.env.PATH ?? "" }, propose, forgeFetch: forge.fetch, sleep: async () => {} };
  return { bare, dir, forge, o };
}

async function connected(o: McpOptions): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await serve(o, a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return client;
}

const said = (r: object): string => ((r as { content: unknown }).content as { text: string }[])[0].text;
const requestBranches = (bare: string): string[] => git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/request").split("\n").filter(Boolean);

describe("terragucci mcp: templates and request_from_template", () => {
  it("serves templates always and request_from_template only with --propose", async () => {
    const { o } = await requesting(false);
    const plain = (await (await connected(o)).listTools()).tools.map((t) => t.name);
    expect(plain).toContain("templates");
    expect(plain).not.toContain("request_from_template");
    const proposing = (await (await connected({ ...o, propose: true })).listTools()).tools;
    expect(proposing.map((t) => t.name)).toEqual(expect.arrayContaining(["templates", "request_from_template"]));
    const req = proposing.find((t) => t.name === "request_from_template")!;
    expect(req.annotations?.readOnlyHint).toBe(false);
    expect(req.annotations?.destructiveHint).toBe(false);
    expect(req.inputSchema.required).toEqual(["template", "name"]);
  });

  it("templates answers with the document templates list --json prints", async () => {
    const { o } = await requesting(false);
    const client = await connected(o);
    const rows = JSON.parse(said(await client.callTool({ name: "templates", arguments: {} })));
    expect(rows.map((r: { template: string; kind: string }) => `${r.template}:${r.kind}`)).toEqual(["acme/bucket/aws:app", "acme/cache/aws:addon"]);
    const one = JSON.parse(said(await client.callTool({ name: "templates", arguments: { template: "acme/bucket/aws" } })));
    expect(one).toMatchObject({ template: "acme/bucket/aws", kind: "app", latest: "1.2.0" });
    expect(one.fields.find((f: { name: string }) => f.name === "api_key")).toMatchObject({ sensitive: true });
  });

  it("opens one pull request on request/bucket/orders with via: mcp and the propose footer, and a second call returns it as existing", async () => {
    const { bare, forge, o } = await requesting();
    const client = await connected(o);
    const args = { template: "acme/bucket/aws", name: "orders", inputs: { bucket_name: "orders-data" } };
    const r = await client.callTool({ name: "request_from_template", arguments: args });
    expect(r.isError, said(r)).toBeFalsy();
    expect(JSON.parse(said(r))).toMatchObject({ branch: "request/bucket/orders", pull_request: 7, url: "https://forge.test/acme/infra/pulls/7", existing: false });
    expect(JSON.parse(said(r)).next).toContain("plan_result with pull_request 7");
    expect(requestBranches(bare)).toEqual(["refs/heads/request/bucket/orders"]);
    const sent = JSON.parse(forge.opened()[0]!.body!) as { head: string; title: string; body: string };
    expect(sent).toMatchObject({ head: "request/bucket/orders", title: "Request: orders from bucket 1.2.0" });
    expect(sent.body).toContain('"via": "mcp"');
    expect(sent.body).toContain('"requestedBy": "agent-bot"');
    expect(sent.body.trimEnd().endsWith(PROPOSED_FOOTER)).toBe(true);

    const again = await client.callTool({ name: "request_from_template", arguments: args });
    expect(JSON.parse(said(again))).toMatchObject({ branch: "request/bucket/orders", pull_request: 7, existing: true });
    expect(forge.opened()).toHaveLength(1);
  });

  it("carries claimed_by as the request's claimedBy beside the forge's requester", async () => {
    const { forge, o } = await requesting();
    const client = await connected(o);
    const r = await client.callTool({ name: "request_from_template", arguments: { template: "acme/bucket/aws", name: "orders", inputs: { bucket_name: "orders-data" }, claimed_by: "bob" } });
    expect(r.isError, said(r)).toBeFalsy();
    const body = (JSON.parse(forge.opened()[0]!.body!) as { body: string }).body;
    expect(body).toContain('"requestedBy": "agent-bot"');
    expect(body).toContain('"claimedBy": "bob"');
  });

  it("refuses a sensitive input with sensitive-input, and pushes no branch", async () => {
    const { bare, forge, o } = await requesting();
    const client = await connected(o);
    const r = await client.callTool({ name: "request_from_template", arguments: { template: "acme/bucket/aws", name: "orders", inputs: { bucket_name: "orders-data", api_key: "x" } } });
    expect(r.isError).toBe(true);
    expect(said(r)).toContain("sensitive-input");
    expect(requestBranches(bare)).toEqual([]);
    expect(forge.opened()).toHaveLength(0);
  });

  it("refuses an extra token argument by name, and inputs that are no object", async () => {
    const { bare, o } = await requesting();
    const client = await connected(o);
    const r = await client.callTool({ name: "request_from_template", arguments: { template: "acme/bucket/aws", name: "orders", inputs: {}, token: "ghp_x" } });
    expect(r.isError).toBe(true);
    expect(said(r)).toContain("request_from_template takes no token");
    expect(said(r)).toContain("credentials from its own environment");
    const bad = await client.callTool({ name: "request_from_template", arguments: { template: "acme/bucket/aws", name: "orders", inputs: "bucket_name=x" } });
    expect(bad.isError).toBe(true);
    expect(said(bad)).toContain("inputs must be an object");
    expect(requestBranches(bare)).toEqual([]);
  });
});

/** A chant whose `serve mcp` serves the hook's tools as `terragucci:<name>` on `transport`, under chant's name. */
function fakeChant(transport: Transport) {
  const seen: { argv: string[]; hook?: ChantProductMcpHook } = { argv: [] };
  const m = {
    PRODUCT_MCP_HOOK_FLOOR: "0.0.0",
    PRODUCT_MCP_PROPOSE_FLOOR: "0.0.1",
    PRODUCT_TOOL_PROPOSE_WORDS: ["request", "propose"],
    async runChantInProcess(argv: string[], _words: object, options?: { mcp?: ChantProductMcpHook }): Promise<number> {
      seen.argv = argv;
      seen.hook = options?.mcp;
      const propose = argv.includes("--propose");
      const tools = (options?.mcp?.tools({ cwd: "/", readOnly: true, propose }) ?? []).filter((t) => t.readOnly === true || (propose && t.forgeWrite === true));
      const server = new Server({ name: "chant", version: "0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((t) => ({ name: `terragucci:${t.name}`, description: t.description, inputSchema: t.inputSchema })) }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));
      await server.connect(transport);
      await new Promise<void>((resolve) => (server.onclose = () => resolve()));
      return 0;
    },
  };
  return { m, seen };
}

async function startMcp(o: McpOptions) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const chant = fakeChant(a);
  const restore = overrideChantNext("productMcp", chant.m);
  const done = mcp({ ...o, transport: a });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return { client, chant, done, restore };
}

describe("terragucci mcp --propose: which server", () => {
  it("runs on chant's server, with the forge tools declared forgeWrite", async () => {
    const { o } = await requesting();
    const { client, chant, done, restore } = await startMcp(o);
    try {
      expect(client.getServerVersion()?.name).toBe("chant");
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["terragucci:templates", "terragucci:request_from_template", "terragucci:propose", "terragucci:request_plan", "terragucci:plan_result"]));
      expect(chant.seen.argv).toEqual(["serve", "mcp", "--read-only", "--propose", "--lexicon", "terraform"]);
      expect(chant.seen.hook?.propose).toBe(true);
      const tools = chant.seen.hook!.tools({ cwd: "/", readOnly: true, propose: true });
      expect(tools.filter((t) => t.forgeWrite === true).map((t) => t.name).sort()).toEqual(PROPOSE_TOOLS.map((t) => t.name).sort());
      expect(tools.filter((t) => t.readOnly === true).map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    } finally {
      await client.close();
      await done;
      restore();
    }
  });

  it("serves templates and no forge tool on chant's server without --propose", async () => {
    const { o } = await requesting(false);
    const { client, chant, done, restore } = await startMcp(o);
    try {
      expect(client.getServerVersion()?.name).toBe("chant");
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("terragucci:templates");
      expect(names).not.toContain("terragucci:request_from_template");
      expect(chant.seen.argv).not.toContain("--propose");
      expect(chant.seen.hook?.propose).toBeUndefined();
    } finally {
      await client.close();
      await done;
      restore();
    }
  });

  it("the hook without propose contributes no forgeWrite tool", () => {
    const hook = productHook({ cwd: "/repo", config: {} });
    expect(hook.tools({ cwd: "/repo", readOnly: true }).some((t) => t.forgeWrite === true)).toBe(false);
  });

});
