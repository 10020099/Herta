import type {
  HertaTool,
  TodoItem,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import { todoWriteInputSchema, todoWriteJsonSchema } from "./schema.js";

export type { TodoWriteInput } from "./schema.js";
export { MAX_TODO_ITEMS } from "./schema.js";

export interface TodoWriteData {
  todos: readonly TodoItem[];
}

/**
 * Backend todo tool per ADR 0025 §2 — replaces the removed
 * plan_update / research_update pair. Full-list replacement: every call
 * carries the entire list, so the model never needs ids or patch ops.
 * The current list is rendered back into the prompt each iteration
 * (`BackendPromptFrame.todoState`), and unfinished items fold into the
 * report's `nextActions` when the brief ends.
 */
export function todoWriteTool(): HertaTool {
  return {
    name: "todo_write",
    schema(): ToolSchema {
      return {
        name: "todo_write",
        description:
          "Replace your ENTIRE todo list for this task. Pass the FULL list every " +
          "call — items you omit are dropped. Use for multi-step tasks (3+ distinct " +
          "actions): the first call lays out the steps as pending, then rewrite the " +
          "list as statuses change. Statuses: pending | in_progress | completed; " +
          "keep at most one item in_progress at a time, and mark an item completed " +
          "as soon as it is done. Skip this tool for single-step jobs. An empty " +
          "list clears the todos.",
        inputSchema: todoWriteJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<TodoWriteData>> {
      const parsed = todoWriteInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: formatInputIssues(parsed.error),
            retryable: false,
          },
          suggestion:
            "usage: {todos: [{content, status: pending|in_progress|completed}, …]} — full-list replacement",
          summary: "invalid input",
        };
      }

      ctx.todos.replace(parsed.data.todos);
      const todos = ctx.todos.all();

      ctx.bus.publish({
        type: "plan.updated",
        layer: "backend",
        todos,
      });

      const completed = todos.filter((t) => t.status === "completed").length;
      return {
        ok: true,
        data: { todos },
        summary:
          todos.length === 0
            ? "todos cleared"
            : `todos ${completed}/${todos.length} completed`,
      };
    },
  };
}
