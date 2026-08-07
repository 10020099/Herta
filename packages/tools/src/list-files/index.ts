import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import type {
  HertaTool,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import { resolveSafePath } from "../path-safety.js";
import { type WalkEntry, walkDir } from "../walker.js";
import { listFilesInputSchema, listFilesJsonSchema } from "./schema.js";

export interface ListFilesData {
  entries: WalkEntry[];
  truncated: boolean;
  skipped: string[];
}

export function listFilesTool(): HertaTool {
  return {
    name: "list_files",
    readOnly: true,
    schema(): ToolSchema {
      return {
        name: "list_files",
        description:
          "List files and directories in the workspace. Optionally recursive. Skips .git, node_modules, dist, build, .herta, .claude, coverage.",
        inputSchema: listFilesJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<ListFilesData>> {
      const parsed = listFilesInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: formatInputIssues(parsed.error),
            retryable: false,
          },
          suggestion: "usage: {path?, recursive?, maxEntries?}",
          summary: "invalid input",
        };
      }
      const { path = ".", recursive = false, maxEntries = 1000 } = parsed.data;

      const safe = await resolveSafePath(ctx.workspaceRoot, path);
      if (!safe.ok) {
        return {
          ok: false,
          error: { code: safe.code, message: safe.message, retryable: false },
          summary: `denied: ${safe.message}`,
        };
      }

      let info: Stats;
      try {
        info = await stat(safe.resolved);
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === "ENOENT") {
          return {
            ok: false,
            error: {
              code: "not_found",
              message: `not found: ${safe.relative || path}`,
              retryable: false,
            },
            summary: `not found: ${safe.relative || path}`,
          };
        }
        return {
          ok: false,
          error: {
            code: "read_failed",
            message: (err as Error).message ?? "stat failed",
            retryable: false,
          },
          summary: "read failed",
        };
      }

      if (!info.isDirectory()) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: `not a directory: ${safe.relative || path}`,
            retryable: false,
          },
          summary: `not a directory: ${safe.relative || path}`,
        };
      }

      const entries: WalkEntry[] = [];
      const skipped: string[] = [];
      let truncated = false;
      let walked = 0;
      try {
        // ctx.signal threads into the walk (audit M4): a Ctrl-C mid-listing
        // over a large tree lands within one entry instead of after the
        // whole traversal.
        for await (const e of walkDir(ctx.workspaceRoot, safe.resolved, {
          recursive,
          maxEntries: maxEntries + 1,
          onSkipped: (n) => skipped.push(n),
          signal: ctx.signal,
        })) {
          if (entries.length >= maxEntries) {
            truncated = true;
            break;
          }
          walked++;
          // Same per-entry gate as search_text (2026-07-10 audit, finding 1)
          // at name granularity: credential basenames and symlinks resolving
          // outside the workspace don't appear in listings.
          const safeEntry = await resolveSafePath(ctx.workspaceRoot, e.path);
          if (!safeEntry.ok) continue;
          entries.push(e);
        }
        // The walker's cap fired but denied entries kept `entries` under
        // maxEntries — the listing is still incomplete, say so.
        if (walked > maxEntries) truncated = true;
      } catch (err: unknown) {
        // An abort is an interrupt, not a read failure — rethrow so the turn
        // loop classifies it as `interrupted` rather than folding it into a
        // read_failed tool result.
        if ((err as Error)?.name === "AbortError") throw err;
        return {
          ok: false,
          error: {
            code: "read_failed",
            message: (err as Error).message ?? "walk failed",
            retryable: false,
          },
          summary: "read failed",
        };
      }

      entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

      const dirs = entries.filter((e) => e.type === "dir").length;
      const files = entries.filter((e) => e.type === "file").length;
      const skippedNote =
        skipped.length > 0
          ? ` (skipped: ${[...new Set(skipped)].sort().join(", ")})`
          : "";
      const truncNote = truncated ? " (truncated)" : "";
      const where = safe.relative === "" ? "." : safe.relative;
      const summary = truncated
        ? `listed ${entries.length} of many entries in ${where}${truncNote}${skippedNote}`
        : `listed ${entries.length} entries in ${where} (${dirs} dirs, ${files} files)${skippedNote}`;

      return {
        ok: true,
        data: { entries, truncated, skipped: [...new Set(skipped)].sort() },
        summary,
      };
    },
  };
}
