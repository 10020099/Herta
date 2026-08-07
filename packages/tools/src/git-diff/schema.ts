import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const REF_PATTERN = /^[A-Za-z0-9_./^~@-]+$/;

export const gitDiffInputSchema = z
  .object({
    staged: z.boolean().optional(),
    ref: z
      .string()
      .min(1)
      .max(200)
      .regex(REF_PATTERN, "ref contains disallowed characters")
      .optional(),
  })
  .strict()
  .refine((v) => !(v.staged === true && v.ref !== undefined), {
    message: "staged and ref are mutually exclusive",
  });

export type GitDiffInput = z.infer<typeof gitDiffInputSchema>;

export const gitDiffJsonSchema = zodToJsonSchema(gitDiffInputSchema);
