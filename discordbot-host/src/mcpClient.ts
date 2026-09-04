import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Direct (non-agent) MCP tool calls, for host-side automation that doesn't
// need Claude in the loop: executing an already-decided reaction-confirm
// action, and the auth-failure / Never-tracked sentries' polls. See
// CLAUDE.md's discordbot-host section for why each of these is a plain
// function call rather than a fresh cold invocation.
export async function withMcpClient<T>(
  clientName: string,
  url: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: clientName, version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

export async function callTool(
  clientName: string,
  url: string,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return withMcpClient(clientName, url, (client) =>
    client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
  );
}

export function toolResultText(result: CallToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export function toolResultJson<T>(result: CallToolResult): T {
  return JSON.parse(toolResultText(result)) as T;
}
