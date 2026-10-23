/**
 * The parts of the MCP SDK `terragucci mcp` runs on, loaded when it starts.
 * In the bundle this module is replaced by the SDK and zod built on their own
 * and kept gzipped, then imported when `loadMcpSdk` is first called
 * (scripts/cli-bundle.mjs), so the commands that serve no MCP do not carry
 * them. From the sources it imports the SDK as is.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface McpSdk {
  Server: typeof Server;
  StdioServerTransport: typeof StdioServerTransport;
  CallToolRequestSchema: typeof CallToolRequestSchema;
  ListToolsRequestSchema: typeof ListToolsRequestSchema;
}

export async function loadMcpSdk(): Promise<McpSdk> {
  const [{ Server }, { StdioServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  return { Server, StdioServerTransport, CallToolRequestSchema, ListToolsRequestSchema };
}
