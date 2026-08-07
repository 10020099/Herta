import type {
  HertaTool,
  ProgressFn,
  ToolCallRequest,
  ToolContext,
  ToolResult,
} from "./types/tool.js";

export interface ToolRegistry {
  register(tool: HertaTool): void;
  get(name: string): HertaTool | undefined;
  list(): HertaTool[];
  run(
    call: ToolCallRequest,
    ctx: ToolContext,
    progress: ProgressFn,
  ): Promise<ToolResult>;
}

export class InMemoryToolRegistry implements ToolRegistry {
  private tools = new Map<string, HertaTool>();

  register(tool: HertaTool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): HertaTool | undefined {
    return this.tools.get(name);
  }

  list(): HertaTool[] {
    return [...this.tools.values()];
  }

  async run(
    call: ToolCallRequest,
    ctx: ToolContext,
    progress: ProgressFn,
  ): Promise<ToolResult> {
    const tool = this.tools.get(call.tool);
    if (!tool) {
      return {
        ok: false,
        error: {
          code: "unknown_tool",
          message: `tool not registered: ${call.tool}`,
          retryable: false,
        },
        summary: `unknown tool: ${call.tool}`,
      };
    }
    return tool.run(call, ctx, progress);
  }
}
