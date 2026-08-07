import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Strict (2026-07-31): unknown keys are named instead of silently stripped.
export const listFilesInputSchema = z
  .object({
    path: z.string().min(1).optional(),
    recursive: z.boolean().optional(),
    maxEntries: z.number().int().min(1).max(5000).optional(),
  })
  .strict();

export type ListFilesInput = z.infer<typeof listFilesInputSchema>;

export const listFilesJsonSchema = zodToJsonSchema(listFilesInputSchema);
