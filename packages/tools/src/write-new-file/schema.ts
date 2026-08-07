import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Strict (2026-07-31): unknown keys are named instead of silently stripped.
export const writeNewFileInputSchema = z
  .object({
    path: z.string().min(1, "path must be non-empty"),
    content: z.string(),
  })
  .strict();

export type WriteNewFileInput = z.infer<typeof writeNewFileInputSchema>;

export const writeNewFileJsonSchema = zodToJsonSchema(writeNewFileInputSchema);
