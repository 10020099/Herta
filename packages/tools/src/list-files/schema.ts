import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Strict (2026-07-31): unknown keys are named instead of silently stripped.
export const listFilesInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Workspace-relative directory to list. Default: the workspace root.",
      ),
    recursive: z
      .boolean()
      .optional()
      .describe("Descend into subdirectories. Default false."),
    maxEntries: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe("Cap on entries returned. Default 1000."),
  })
  .strict();

export type ListFilesInput = z.infer<typeof listFilesInputSchema>;

export const listFilesJsonSchema = zodToJsonSchema(listFilesInputSchema);
