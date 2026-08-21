/**
 * Connect to configured MCP servers, list their tools, and wrap them as Herta
 * tools. Each configured server may use a local stdio process, legacy SSE, or
 * the modern Streamable HTTP transport. Connection is best-effort per server:
 * one failed server is logged and skipped without wedging the session.
 */
import type { HertaTool } from "@herta/core";
import { Client } from "@modelcontextprotocol/sdk/client";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpConnectionStatus } from "../types.js";
import type { McpServerConfig } from "./mcp-config.js";
import { McpTool } from "./mcp-tool.js";

export interface McpConnection {
  readonly tools: HertaTool[];
  /** Per configured server, captured after the session-start connection attempt.
   *  A server is `connected` only after both the transport handshake and tool
   *  listing succeed; otherwise it is `failed` and contributes no tools. */
  readonly connectionStatus: Readonly<Record<string, McpConnectionStatus>>;
  dispose(): Promise<void>;
}

const CLIENT_INFO = { name: "herta", version: "0.1.1" };

function requestOptions(
  headers: Record<string, string> | undefined,
): { requestInit?: RequestInit } | undefined {
  return headers === undefined ? undefined : { requestInit: { headers } };
}

function createTransport(
  config: McpServerConfig,
): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
  if (config.transport === "sse") {
    return new SSEClientTransport(
      new URL(config.url),
      requestOptions(config.headers),
    );
  }
  if (config.transport === "streamable-http") {
    return new StreamableHTTPClientTransport(
      new URL(config.url),
      requestOptions(config.headers),
    );
  }
  return new StdioClientTransport({
    command: config.command,
    ...(config.args !== undefined ? { args: config.args } : {}),
    ...(config.env !== undefined ? { env: config.env } : {}),
    stderr: "pipe",
  });
}

export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
): Promise<McpConnection> {
  const tools: HertaTool[] = [];
  const connectionStatus: Record<string, McpConnectionStatus> = {};
  const disposeClient: Array<() => Promise<void>> = [];

  for (const [serverName, config] of Object.entries(servers)) {
    try {
      const transport = createTransport(config);
      const client = new Client(CLIENT_INFO);
      await client.connect(transport);
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        tools.push(new McpTool(client, serverName, tool));
      }
      connectionStatus[serverName] = "connected";
      disposeClient.push(async () => {
        // Streamable HTTP servers may retain a session after the transport closes.
        // Ask them to release it first; a server may decline DELETE (405), which
        // the SDK treats as a valid no-op.
        if (transport instanceof StreamableHTTPClientTransport) {
          await transport.terminateSession().catch(() => {
            /* close below remains mandatory */
          });
        }
        await client.close();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[herta] mcp server "${serverName}" failed to connect: ${message}`,
      );
      connectionStatus[serverName] = "failed";
      // Best-effort: skip this server, keep the others.
    }
  }

  return {
    tools,
    connectionStatus,
    async dispose(): Promise<void> {
      for (const close of disposeClient) {
        try {
          await close();
        } catch {
          // already closed or no longer reachable
        }
      }
    },
  };
}
