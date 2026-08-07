import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Strict (2026-07-31, with the rest of the tool schemas): non-strict zod
// silently strips wrong OPTIONAL key names (`context` for `contextLines`,
// `max` for `maxMatches`), running the search with defaults instead of
// telling the model which key it misspelled.
export const searchTextInputSchema = z
  .object({
    pattern: z.string().min(1, "pattern must be non-empty"),
    path: z.string().min(1).optional(),
    caseSensitive: z.boolean().optional(),
    contextLines: z.number().int().min(0).max(5).optional(),
    maxMatches: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export type SearchTextInput = z.infer<typeof searchTextInputSchema>;

export const searchTextJsonSchema = zodToJsonSchema(searchTextInputSchema);
