import type { TodoItem } from "./types/todo.js";

/**
 * Per-brief todo state (ADR 0025 §2). Reset on every `runBrief` like the
 * transcript and read ledger; unfinished items survive the brief only by
 * folding into the report's `nextActions` and the done-marker detail
 * (which the next dispatch reads back through `workingHistory`).
 *
 * Full-list replacement is the whole API: the `todo_write` tool always
 * sends the entire list, so there is no patch grammar to misuse.
 */
export class TodoStore {
  private items: readonly TodoItem[] = [];

  replace(items: readonly TodoItem[]): void {
    this.items = items.map((i) => ({ ...i }));
  }

  all(): readonly TodoItem[] {
    return this.items;
  }

  unfinished(): readonly TodoItem[] {
    return this.items.filter((i) => i.status !== "completed");
  }
}

const STATUS_LABEL_ZH: Record<TodoItem["status"], string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "已完成",
};

/**
 * Render the current todo list as the per-iteration reminder section
 * (`BackendPromptFrame.todoState`). Returns "" when the list is empty so
 * the translate layer emits nothing. The reminder is transient — it is
 * appended after the transcript on each provider call and never persisted
 * into the durable transcript (state the model cannot see is state the
 * model will not maintain; state written into history twice is noise).
 */
export function renderTodoState(
  items: readonly TodoItem[],
  lang: "zh" | "en" = "zh",
): string {
  if (items.length === 0) return "";
  if (lang === "en") {
    const lines = items.map((i) => `- [${i.status}] ${i.content}`);
    return [
      "## Current todo list",
      ...lines,
      "(You maintain this with todo_write — full-list replacement. Update statuses as steps finish; when the task ends, the list must be honest.)",
    ].join("\n");
  }
  const lines = items.map(
    (i) => `- [${STATUS_LABEL_ZH[i.status]}] ${i.content}`,
  );
  return [
    "## 当前任务清单",
    ...lines,
    "（这份清单由你用 todo_write 全量维护：每完成一步就整单重写一次。收尾时清单要如实——没做完的项保持原状态。）",
  ].join("\n");
}
