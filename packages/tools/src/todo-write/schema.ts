import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/** ADR 0025 §2: cap matches the old plan-item cap. */
export const MAX_TODO_ITEMS = 32;

// Strict (2026-07-31): unknown keys are named instead of silently stripped.
const TodoItemSchema = z
  .object({
    content: z.string().min(1).max(200),
    status: z.enum(["pending", "in_progress", "completed"]),
  })
  .strict();

/**
 * Full-list replacement — the input IS the entire new list. An empty
 * array is legal and clears the list (e.g. the task turned out to be a
 * single step after all). No ids, no patch grammar: the patch-op API
 * this replaces is precisely what the model never managed to use.
 */
export const todoWriteInputSchema = z
  .object({
    todos: z.array(TodoItemSchema).max(MAX_TODO_ITEMS),
  })
  .strict();

export type TodoWriteInput = z.infer<typeof todoWriteInputSchema>;

export const todoWriteJsonSchema = zodToJsonSchema(
  todoWriteInputSchema,
) as Record<string, unknown>;
