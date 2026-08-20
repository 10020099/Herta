import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadMcpConfig,
  mcpConfigPath,
  parseMcpConfig,
  writeMcpConfig,
} from "./mcp-config.js";

describe("MCP configuration", () => {
  it("normalizes legacy stdio, SSE, and Streamable HTTP entries", () => {
    expect(
      parseMcpConfig({
        mcpServers: {
          local: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem"],
            env: { ROOT: "/tmp/project" },
          },
          sse: {
            transport: "sse",
            url: "https://mcp.example.test/sse",
            headers: { Authorization: "Bearer one" },
          },
          modern: {
            type: "http",
            url: "https://mcp.example.test/mcp",
            headers: { "X-API-Key": "two" },
          },
        },
      }),
    ).toEqual({
      mcpServers: {
        local: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
          env: { ROOT: "/tmp/project" },
        },
        sse: {
          transport: "sse",
          url: "https://mcp.example.test/sse",
          headers: { Authorization: "Bearer one" },
        },
        modern: {
          transport: "streamable-http",
          url: "https://mcp.example.test/mcp",
          headers: { "X-API-Key": "two" },
        },
      },
    });
  });

  it("drops malformed on-disk entries without hiding valid servers", () => {
    expect(
      parseMcpConfig({
        mcpServers: {
          valid: {
            transport: "streamable-http",
            url: "https://example.test/mcp",
          },
          noCommand: { transport: "stdio" },
          wrongScheme: { transport: "sse", url: "file:///tmp/mcp" },
          unknownTransport: {
            transport: "websocket",
            url: "https://example.test",
          },
        },
      }),
    ).toEqual({
      mcpServers: {
        valid: {
          transport: "streamable-http",
          url: "https://example.test/mcp",
        },
      },
    });
  });

  it("writes canonical JSON atomically and rejects malformed GUI submissions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "herta-mcp-config-"));
    try {
      await writeMcpConfig(workspace, {
        mcpServers: {
          remote: {
            transport: "streamable-http",
            url: "https://mcp.example.test/mcp",
            headers: { Authorization: "Bearer secret" },
          },
        },
      });

      expect(loadMcpConfig(workspace)).toEqual({
        mcpServers: {
          remote: {
            transport: "streamable-http",
            url: "https://mcp.example.test/mcp",
            headers: { Authorization: "Bearer secret" },
          },
        },
      });
      expect(
        JSON.parse(await readFile(mcpConfigPath(workspace), "utf-8")),
      ).toEqual({
        mcpServers: {
          remote: {
            transport: "streamable-http",
            url: "https://mcp.example.test/mcp",
            headers: { Authorization: "Bearer secret" },
          },
        },
      });

      await expect(
        writeMcpConfig(workspace, {
          mcpServers: { remote: { transport: "sse", url: "not a URL" } },
        }),
      ).rejects.toThrow('Invalid MCP configuration for server "remote"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
