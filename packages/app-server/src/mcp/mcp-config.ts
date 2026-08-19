/**
 * MCP (Model Context Protocol) server configuration — Microsoft convention
 * shape, stdio only (方案 A). Read from `<workspaceRoot>/.herta/mcp.json`:
 *
 *   { "mcpServers": { "name": { "command": "npx", "args": ["-y", "…"],
 *                               "env": { "KEY": "VAL" } } } }
 *
 * A missing / corrupt / empty file resolves to no servers — MCP is opt-in
 * and a bad file must never wedge a session.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export function mcpConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".herta", "mcp.json");
}

/** Read the MCP config. Best-effort: a missing/corrupt file (or an off-shape
 *  server entry) is dropped rather than thrown. */
export function loadMcpConfig(workspaceRoot: string): McpConfig {
  try {
    const raw = readFileSync(mcpConfigPath(workspaceRoot), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null)
      return { mcpServers: {} };
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (typeof servers !== "object" || servers === null) {
      return { mcpServers: {} };
    }
    const out: Record<string, McpServerConfig> = {};
    for (const [name, entry] of Object.entries(
      servers as Record<string, unknown>,
    )) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as { command?: unknown; args?: unknown; env?: unknown };
      if (typeof e.command !== "string" || e.command.length === 0) continue;
      const cfg: McpServerConfig = { command: e.command };
      if (Array.isArray(e.args) && e.args.every((a) => typeof a === "string")) {
        cfg.args = e.args as string[];
      }
      if (typeof e.env === "object" && e.env !== null) {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
          if (typeof v === "string") env[k] = v;
        }
        if (Object.keys(env).length > 0) cfg.env = env;
      }
      out[name] = cfg;
    }
    return { mcpServers: out };
  } catch {
    return { mcpServers: {} };
  }
}
