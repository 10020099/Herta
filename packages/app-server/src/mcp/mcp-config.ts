/**
 * MCP (Model Context Protocol) client configuration. It is scoped to a
 * workspace and stored in `<workspaceRoot>/.herta/mcp.json`.
 *
 * Legacy stdio entries remain valid:
 *
 *   { "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "…"] } } }
 *
 * Remote servers use an explicit transport and URL:
 *
 *   { "mcpServers": {
 *       "legacy-sse": { "transport": "sse", "url": "https://example.com/sse" },
 *       "modern-http": {
 *         "transport": "streamable-http",
 *         "url": "https://example.com/mcp",
 *         "headers": { "Authorization": "Bearer …" }
 *       }
 *   } }
 *
 * MCP is opt-in. A malformed on-disk entry is dropped during loading so one
 * broken server never prevents a session from starting. Writes, on the other
 * hand, reject malformed data so the GUI cannot silently discard a server.
 */
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hertaHomeDir, projectHertaDir } from "../config-scope.js";

export type McpTransport = "stdio" | "sse" | "streamable-http";

export interface StdioMcpServerConfig {
  /** Omitted for backwards compatibility with the original stdio-only shape. */
  transport?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface RemoteMcpServerConfigBase {
  url: string;
  /** Static request headers, for example Authorization or X-API-Key. */
  headers?: Record<string, string>;
}

export interface SseMcpServerConfig extends RemoteMcpServerConfigBase {
  transport: "sse";
}

export interface StreamableHttpMcpServerConfig
  extends RemoteMcpServerConfigBase {
  transport: "streamable-http";
}

export type McpServerConfig =
  | StdioMcpServerConfig
  | SseMcpServerConfig
  | StreamableHttpMcpServerConfig;

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/** Project-scoped MCP configuration path. */
export function mcpConfigPath(workspaceRoot: string): string {
  return join(projectHertaDir(workspaceRoot), "mcp.json");
}

/** Visible user-scoped MCP configuration path (`~/.herta/mcp.json` by default). */
export function globalMcpConfigPath(
  opts: {
    readonly home?: string;
    readonly hertaHome?: string | undefined;
  } = {},
): string {
  return join(hertaHomeDir(opts), "mcp.json");
}

/** Provenance retained for GUI override indicators without exposing secrets. */
export type McpConfigScope = "global" | "project";

export interface MergedMcpConfig extends McpConfig {
  /** The winning layer for every server definition. */
  readonly scopes: Readonly<Record<string, McpConfigScope>>;
  /** Project names that replaced equally named global definitions. */
  readonly overrides: readonly string[];
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function validRemoteUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parse one configuration entry. `type` and the common `http` /
 * `streamableHttp` spellings are accepted on read, then normalized to Herta's
 * canonical `transport` form. This makes hand-authored configuration and other
 * MCP client conventions interoperate without widening the internal union.
 */
export function parseMcpServerConfig(value: unknown): McpServerConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const entry = value as {
    transport?: unknown;
    type?: unknown;
    command?: unknown;
    args?: unknown;
    env?: unknown;
    url?: unknown;
    headers?: unknown;
  };
  const transport = entry.transport ?? entry.type;

  // No transport means legacy stdio. An explicit stdio value behaves the same.
  if (transport === undefined || transport === "stdio") {
    if (typeof entry.command !== "string" || entry.command.length === 0) {
      return null;
    }
    const cfg: StdioMcpServerConfig = {
      ...(transport === "stdio" ? { transport: "stdio" as const } : {}),
      command: entry.command,
    };
    if (
      Array.isArray(entry.args) &&
      entry.args.every((argument) => typeof argument === "string")
    ) {
      cfg.args = [...entry.args] as string[];
    }
    const env = stringMap(entry.env);
    if (env !== undefined) cfg.env = env;
    return cfg;
  }

  if (!validRemoteUrl(entry.url)) return null;
  const headers = stringMap(entry.headers);
  if (transport === "sse") {
    return {
      transport: "sse",
      url: entry.url,
      ...(headers !== undefined ? { headers } : {}),
    };
  }
  if (
    transport === "streamable-http" ||
    transport === "streamableHttp" ||
    transport === "http"
  ) {
    return {
      transport: "streamable-http",
      url: entry.url,
      ...(headers !== undefined ? { headers } : {}),
    };
  }
  return null;
}

/** Best-effort on-disk reader: invalid entries are excluded individually. */
export function parseMcpConfig(value: unknown): McpConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { mcpServers: {} };
  }
  const servers = (value as { mcpServers?: unknown }).mcpServers;
  if (
    typeof servers !== "object" ||
    servers === null ||
    Array.isArray(servers)
  ) {
    return { mcpServers: {} };
  }
  const out: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(servers)) {
    const cfg = parseMcpServerConfig(entry);
    if (cfg !== null) out[name] = cfg;
  }
  return { mcpServers: out };
}

/** Read one MCP configuration file. Missing or corrupt files mean no servers. */
export function loadMcpConfig(workspaceRoot: string): McpConfig {
  try {
    return parseMcpConfig(
      JSON.parse(readFileSync(mcpConfigPath(workspaceRoot), "utf-8")),
    );
  } catch {
    return { mcpServers: {} };
  }
}

/** Read the user-wide MCP configuration without consulting Electron userData. */
export function loadGlobalMcpConfig(
  opts: {
    readonly home?: string;
    readonly hertaHome?: string | undefined;
  } = {},
): McpConfig {
  try {
    return parseMcpConfig(
      JSON.parse(readFileSync(globalMcpConfigPath(opts), "utf-8")),
    );
  } catch {
    return { mcpServers: {} };
  }
}

/**
 * Merge user-wide and project MCP entries for a new session. Project entries
 * win on a name collision, so a repository can override a personal default
 * without changing any other project.
 */
export function mergeMcpConfigs(
  global: McpConfig,
  project: McpConfig,
): MergedMcpConfig {
  const mcpServers: Record<string, McpServerConfig> = { ...global.mcpServers };
  const scopes: Record<string, McpConfigScope> = Object.fromEntries(
    Object.keys(global.mcpServers).map((name) => [name, "global" as const]),
  );
  const overrides: string[] = [];
  for (const [name, config] of Object.entries(project.mcpServers)) {
    if (Object.hasOwn(mcpServers, name)) overrides.push(name);
    mcpServers[name] = config;
    scopes[name] = "project";
  }
  return { mcpServers, scopes, overrides };
}

/** Load the complete effective MCP set for one workspace. */
export function loadEffectiveMcpConfig(
  workspaceRoot: string,
  opts: {
    readonly home?: string;
    readonly hertaHome?: string | undefined;
  } = {},
): MergedMcpConfig {
  return mergeMcpConfigs(
    loadGlobalMcpConfig(opts),
    loadMcpConfig(workspaceRoot),
  );
}

/**
 * Persist a complete MCP configuration using a temp-file rename. Unlike the
 * reader, this validates every named entry so callers get a clear failure
 * rather than losing malformed data during a save.
 */
async function writeMcpConfigAtPath(
  path: string,
  value: unknown,
): Promise<void> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("MCP configuration must be an object");
  }
  const servers = (value as { mcpServers?: unknown }).mcpServers;
  if (
    typeof servers !== "object" ||
    servers === null ||
    Array.isArray(servers)
  ) {
    throw new TypeError("MCP configuration must contain an mcpServers object");
  }
  const normalized: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (name.trim().length === 0) {
      throw new TypeError("MCP server names must not be empty");
    }
    const config = parseMcpServerConfig(entry);
    if (config === null) {
      throw new TypeError(`Invalid MCP configuration for server "${name}"`);
    }
    normalized[name] = config;
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(
      tmp,
      `${JSON.stringify({ mcpServers: normalized }, null, 2)}\n`,
      "utf-8",
    );
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Persist one project-scoped MCP configuration. */
export async function writeMcpConfig(
  workspaceRoot: string,
  value: unknown,
): Promise<void> {
  await writeMcpConfigAtPath(mcpConfigPath(workspaceRoot), value);
}

/** Persist the visible user-scoped MCP configuration. */
export async function writeGlobalMcpConfig(
  value: unknown,
  opts: {
    readonly home?: string;
    readonly hertaHome?: string | undefined;
  } = {},
): Promise<void> {
  await writeMcpConfigAtPath(globalMcpConfigPath(opts), value);
}
