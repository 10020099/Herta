/**
 * Bridge MCP tools onto Herta's `HertaTool` interface so the coding backend
 * can call them like any built-in tool. A tool's MCP name gets a
 * `mcp__<server>__<tool>` prefix so servers can never collide with the
 * built-in tool set.
 */
import type {
  HertaTool,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import type { Client } from "@modelcontextprotocol/sdk/client";

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export class McpTool implements HertaTool {
  constructor(
    private readonly client: Client,
    private readonly serverName: string,
    private readonly def: McpToolDef,
  ) {}

  get name(): string {
    return mcpToolName(this.serverName, this.def.name);
  }

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.def.description ?? "",
      inputSchema: this.def.inputSchema ?? { type: "object", properties: {} },
    };
  }

  async run(call: ToolCallRequest, ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = await this.client.callTool(
        {
          name: this.def.name,
          arguments:
            typeof call.input === "object" && call.input !== null
              ? (call.input as Record<string, unknown>)
              : {},
        },
        undefined,
        { signal: ctx.signal },
      );
      const content = (result.content ?? []) as Array<{
        type: string;
        text?: string;
      }>;
      const text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      return {
        ok: !result.isError,
        summary: text,
        data: content,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `MCP 工具调用失败：${message}`,
        error: { code: "mcp", message, retryable: false },
      };
    }
  }
}
