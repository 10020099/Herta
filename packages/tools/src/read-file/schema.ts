import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Strict (2026-07-31): a wrong optional key name (`startLine` for `offset`)
// used to be silently stripped — the read succeeded from line 1 instead of
// the range the model asked for.
export const readFileInputSchema = z
  .object({
    path: z.string().min(1, "path must be non-empty"),
    offset: z.number().int().min(1).max(1_000_000).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict();

export type ReadFileInput = z.infer<typeof readFileInputSchema>;

export const readFileJsonSchema = zodToJsonSchema(readFileInputSchema);
