import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Strict (2026-07-31): a wrong optional key name (`timeout` for `timeoutMs`,
// `background` for `runInBackground`) used to be silently stripped — the
// command ran with defaults instead of what the model asked for.
export const runCommandInputSchema = z
  .object({
    argv: z
      .array(z.string().min(1, "argv entry must be non-empty"))
      .min(1, "argv must be non-empty"),
    cwd: z.string().min(1, "cwd must be non-empty").optional(),
    timeoutMs: z
      .number()
      .int()
      .min(1, "timeoutMs must be positive")
      .max(600_000, "timeoutMs must be ≤ 600000")
      .optional(),
    /** Extra environment for the child (ADR 0025 slice 4). Merged over the
     *  inherited env; a fixed denylist of escalation-prone keys (PATH,
     *  NODE_OPTIONS, LD_*, git exec hooks, …) is rejected. */
    env: z.record(z.string(), z.string()).optional(),
    /** Start the command in the background (ADR 0025 slice 4). Returns
     *  immediately with a backgroundId; read output with command_output,
     *  stop with command_stop. For long-running processes (dev servers,
     *  watchers). */
    runInBackground: z.boolean().optional(),
  })
  .strict();

export type RunCommandInput = z.infer<typeof runCommandInputSchema>;

export const runCommandJsonSchema = zodToJsonSchema(runCommandInputSchema);

export const commandOutputInputSchema = z
  .object({
    backgroundId: z.string().min(1),
    /** Return only output appended since the given byte offset into the
     *  merged stream (default 0 = from the start). */
    sinceByte: z.number().int().min(0).optional(),
  })
  .strict();
export type CommandOutputInput = z.infer<typeof commandOutputInputSchema>;
export const commandOutputJsonSchema = zodToJsonSchema(
  commandOutputInputSchema,
);

export const commandStopInputSchema = z
  .object({
    backgroundId: z.string().min(1),
  })
  .strict();
export type CommandStopInput = z.infer<typeof commandStopInputSchema>;
export const commandStopJsonSchema = zodToJsonSchema(commandStopInputSchema);
