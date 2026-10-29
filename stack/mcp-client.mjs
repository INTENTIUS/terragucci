// An MCP client, the official TypeScript SDK's. It starts the server command
// given after --, over stdio, lists the server's tools, makes the calls an
// agent would, and prints what it got as one JSON object on stdout.
//
// For the mcp-last-apply smoke claim:
//
//   node stack/mcp-client.mjs <root> -- <command> [<arg>...]
//
//   tools       each tool's name and its read-only and destructive hints
//   last_apply  last_apply for <root>
//   index       index, the newest tf-apply row
//   approve     a call to approve wave-1, which the server must refuse
//   token       estate with a token argument, which the server must refuse
//
// One call, as an agent makes it (the tg-agent-request scenario, terragucci#1311):
//
//   node stack/mcp-client.mjs [--propose] call <tool> '<json arguments>' [-- <command> [<arg>...]]
//
// The server is `terragucci mcp` from this checkout's bundle, run in the
// current directory, unless a command follows --. With --propose the client
// appends --propose to the server's command, so the server serves the tools
// that open pull requests. It prints { server, tools, call }, where call is
// the tool's answer and whether tools/list listed it, and exits 0 when the
// tool was listed and answered without an error, 1 when not (an unlisted
// tool, a refusal), 2 on a usage error.
//
// A call's answer is { error, text, json }: json when its text parses.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const USAGE = "usage: mcp-client.mjs <root> -- <command> [<arg>...] | mcp-client.mjs [--propose] call <tool> '<json arguments>' [-- <command> [<arg>...]]";
const args = process.argv.slice(2);
const split = args.indexOf("--");
const before = split < 0 ? args : args.slice(0, split);
const after = split < 0 ? [] : args.slice(split + 1);
const propose = before[0] === "--propose";
const mode = propose ? before.slice(1) : before;
const calling = mode[0] === "call";

let command;
let rest;
let tool;
let toolArgs;
if (calling) {
  [, tool] = mode;
  if (!tool || mode.length !== 3) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    toolArgs = JSON.parse(mode[2]);
  } catch (e) {
    console.error(`mcp-client: the arguments of ${tool} are not JSON (${e.message})`);
    process.exit(2);
  }
  const bundle = fileURLToPath(new URL("../packages/terragucci/dist/terragucci.mjs", import.meta.url));
  [command, ...rest] = after.length > 0 ? after : [process.execPath, bundle, "mcp"];
  if (propose) rest.push("--propose");
} else {
  [command, ...rest] = after;
  if (propose || split < 0 || before.length !== 1 || !command) {
    console.error(USAGE);
    process.exit(2);
  }
}

const transport = new StdioClientTransport({ command, args: rest, env: process.env, stderr: "inherit" });
const client = new Client({ name: calling ? "terragucci-harness-agent" : "terragucci-smoke", version: "1" });
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
const listed = tools.map((t) => ({ name: t.name, readOnly: t.annotations?.readOnlyHint === true, destructive: t.annotations?.destructiveHint !== false }));

if (calling) {
  // A tool chant's server contributes is listed as terragucci:<name>; the agent calls the name it was given.
  const name = tools.some((t) => t.name === tool) ? tool : tools.some((t) => t.name === `terragucci:${tool}`) ? `terragucci:${tool}` : undefined;
  const got = name ? await call(name, toolArgs) : { error: true, text: `the server lists no tool ${tool} (it lists ${tools.map((t) => t.name).join(", ") || "none"})` };
  await client.close();
  console.log(JSON.stringify({ server: client.getServerVersion(), tools: listed, call: { tool: name ?? tool, listed: name !== undefined, ...got } }));
  process.exit(name !== undefined && !got.error ? 0 : 1);
}

const [root] = before;
const out = {
  server: client.getServerVersion(),
  tools: listed,
  last_apply: await call("last_apply", { root }),
  index: await call("index", { stage: "tf-apply", limit: 1 }),
  approve: await call("approve", { wave: "wave-1" }),
  token: await call("estate", { token: "smoke-not-a-token" }),
};
await client.close();
console.log(JSON.stringify(out));
