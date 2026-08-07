/**
 * Backend todo state per ADR 0025 §2 — the plain plan contract the
 * harness guarantees. Replaced the earlier PlanItem/ResearchProjection
 * pair (write-only stubs the model was never taught to use). Full-list
 * replacement semantics: `todo_write` always carries the entire list.
 */
export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}
