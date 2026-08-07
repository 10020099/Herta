import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Strict (2026-07-31): unknown keys are named instead of silently stripped.
export const globInputSchema = z
  .object({
    pattern: z.string().min(1, "pattern must be non-empty").max(200),
    path: z.string().min(1).optional(),
    maxResults: z.number().int().min(1).max(2000).optional(),
  })
  .strict();

export type GlobInput = z.infer<typeof globInputSchema>;

export const globJsonSchema = zodToJsonSchema(globInputSchema);
