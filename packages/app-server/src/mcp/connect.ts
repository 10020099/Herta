/**
 * Connect to the configured stdio MCP servers, list their tools, and wrap
 * them as Herta tools. Connection is best-effort per server: a server that
 * fails to spawn or handshake is logged and skipped, never wedging the
 * session. The returned `dispose` closes every connected client (app close /
 * session lifetime).
 */
import type { HertaTool } from "@herta/core";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "./mcp-config.js";
import { McpTool } from "./mcp-tool.js";

export interface McpConnection {
  readonly tools: HertaTool[];
  dispose(): Promise<void>;
}

const CLIENT_INFO = { name: "herta", version: "0.1.1" };

export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
): Promise<McpConnection> {
  const tools: HertaTool[] = [];
  const clients: Client[] = [];

  for (const [serverName, cfg] of Object.entries(servers)) {
    try {
      const transport = new StdioClientTransport({
        command: cfg.command,
        ...(cfg.args !== undefined ? { args: cfg.args } : {}),
        ...(cfg.env !== undefined ? { env: cfg.env } : {}),
        stderr: "pipe",
      });
      const client = new Client(CLIENT_INFO);
      await client.connect(transport);
      const listed = await client.listTools();
      for (const t of listed.tools) {
        tools.push(new McpTool(client, serverName, t));
      }
      clients.push(client);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[herta] mcp server "${serverName}" failed to connect: ${message}`,
      );
      // Best-effort: skip this server, keep the others.
    }
  }

  return {
    tools,
    async dispose(): Promise<void> {
      for (const client of clients) {
        try {
          await client.close();
        } catch {
          // already closed
        }
      }
    },
  };
}
