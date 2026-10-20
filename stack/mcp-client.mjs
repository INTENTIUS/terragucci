// An MCP client, the official TypeScript SDK's, for the mcp-last-apply smoke
// claim. It starts the server command given after --, over stdio, lists the
// server's tools, makes the calls an agent would, and prints what it got as
// one JSON object on stdout:
//
//   node stack/mcp-client.mjs <root> -- <command> [<arg>...]
//
//   tools       each tool's name and its read-only and destructive hints
//   last_apply  last_apply for <root>
//   index       index, the newest tf-apply row
//   approve     a call to approve wave-1, which the server must refuse
//   token       estate with a token argument, which the server must refuse
//
// A call's answer is { error, text, json }: json when its text parses.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const split = args.indexOf("--");
const [root] = args.slice(0, split);
const [command, ...rest] = args.slice(split + 1);
if (split < 0 || !root || !command) {
  console.error("usage: mcp-client.mjs <root> -- <command> [<arg>...]");
  process.exit(2);
}

const transport = new StdioClientTransport({ command, args: rest, env: process.env, stderr: "inherit" });
const client = new Client({ name: "terragucci-smoke", version: "1" });
await client.connect(transport);

const answer = (r) => {
  const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { error: r.isError === true, text, ...(json !== undefined ? { json } : {}) };
};
const call = async (name, a) => {
  try {
    return answer(await client.callTool({ name, arguments: a }));
  } catch (e) {
    return { error: true, text: `the call failed: ${e.message}` };
  }
};

const { tools } = await client.listTools();
const out = {
  server: client.getServerVersion(),
  tools: tools.map((t) => ({ name: t.name, readOnly: t.annotations?.readOnlyHint === true, destructive: t.annotations?.destructiveHint !== false })),
  last_apply: await call("last_apply", { root }),
  index: await call("index", { stage: "tf-apply", limit: 1 }),
  approve: await call("approve", { wave: "wave-1" }),
  token: await call("estate", { token: "smoke-not-a-token" }),
};
await client.close();
console.log(JSON.stringify(out));
