import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const memorySaveInputSchema = z
  .object({
    kind: z.enum([
      "build_command",
      "test_command",
      "style_preference",
      "repo_fact",
      "known_flaky_test",
      "recurring_mistake",
      "herta_lesson",
    ]),
    text: z.string().min(1).max(500),
  })
  .strict();

export type MemorySaveInput = z.infer<typeof memorySaveInputSchema>;

export const memorySaveJsonSchema = zodToJsonSchema(memorySaveInputSchema);
