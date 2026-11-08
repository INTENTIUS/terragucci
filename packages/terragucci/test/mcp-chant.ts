/**
 * An MCP client on chant's server with terragucci's tools in it, in process:
 * chant's `McpServer` with terragucci's product hook (`productHook`), reached
 * over the SDK's in-memory transport, as `terragucci mcp` serves them over
 * stdio. Tool names go to and come back from the server as `terragucci:<name>`;
 * the client below takes and gives them without the prefix. A call's result
 * is read as any object: chant puts a tool's array result in
 * `structuredContent`, which the SDK's own result schema refuses.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@intentius/chant/cli/mcp/server";
import { setActiveProductWords } from "@intentius/chant/ci-product-words";
import { TERRAGUCCI_WORDS } from "../src/ci-words";
import { productHook, TOOLS, type McpOptions } from "../src/mcp";

const PREFIX = "terragucci:";

export async function chantClient(o: McpOptions): Promise<Client> {
  setActiveProductWords(TERRAGUCCI_WORDS as never);
  const server = new McpServer([], { workspace: { cwd: o.cwd }, readOnly: true, ...(o.propose ? { propose: true } : {}), product: productHook(o, o.tools ?? TOOLS, o.propose === true) as never });
  const [a, b] = InMemoryTransport.createLinkedPair();
  a.onmessage = (m) => {
    void server.handleRequest(m as never).then((r) => (r ? a.send(r as never) : undefined));
  };
  await a.start();
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const callTool = client.callTool.bind(client);
  const listTools = client.listTools.bind(client);
  client.callTool = ((p: { name: string; arguments?: Record<string, unknown> }, ...rest: never[]) => callTool({ ...p, name: p.name.includes(":") ? p.name : `${PREFIX}${p.name}` }, (rest[0] ?? z.looseObject({})) as never, ...rest.slice(1))) as typeof client.callTool;
  client.listTools = (async (...args: Parameters<typeof listTools>) => {
    const r = await listTools(...args);
    return { ...r, tools: r.tools.filter((t) => t.name.startsWith(PREFIX)).map((t) => ({ ...t, name: t.name.slice(PREFIX.length) })) };
  }) as typeof client.listTools;
  return client;
}
