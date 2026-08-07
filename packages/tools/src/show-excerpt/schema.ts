import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Either an explicit line range OR a match + context window. Both are
 * harness-evaluated against the file on disk — the model never supplies the
 * text itself, which is what makes "verbatim" a guarantee rather than a
 * promise (see the tool's doc comment).
 */
export const showExcerptInputSchema = z
  .object({
    path: z.string().min(1, "path must be non-empty"),
    fromLine: z.number().int().min(1).max(1_000_000).optional(),
    toLine: z.number().int().min(1).max(1_000_000).optional(),
    /** Literal substring to centre the excerpt on (first match wins). */
    match: z.string().min(1).optional(),
    /** Lines of context each side of `match`. Default 6. */
    context: z.number().int().min(0).max(60).optional(),
  })
  // Strict, because every range key is OPTIONAL: non-strict zod silently
  // STRIPPED wrong key names (`from`/`startLine`/…), so a call that did carry
  // a range was told "give either `match` or `fromLine`" — technically true,
  // actually misleading (live 板砖 run, user 2026-07-31). Strict names the
  // unrecognized keys instead, and advertises additionalProperties:false in
  // the model-facing JSON schema.
  .strict()
  .refine(
    (v) => v.match !== undefined || v.fromLine !== undefined,
    "give either `match` or `fromLine`",
  )
  .refine(
    (v) =>
      v.toLine === undefined ||
      v.fromLine === undefined ||
      v.toLine >= v.fromLine,
    "toLine must be >= fromLine",
  );

export type ShowExcerptInput = z.infer<typeof showExcerptInputSchema>;

export const showExcerptJsonSchema = zodToJsonSchema(showExcerptInputSchema);
