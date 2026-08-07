import type {
  HertaTool,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { type GitDiffFile, parseDiffStat } from "../git/parse-diff-stat.js";
import { spawnGit } from "../git/spawn-git.js";
import { formatInputIssues } from "../input-issues.js";
import { gitDiffInputSchema, gitDiffJsonSchema } from "./schema.js";

export type { GitDiffFile } from "../git/parse-diff-stat.js";
export type { GitDiffInput } from "./schema.js";

export interface GitDiffData {
  mode: "working-tree" | "staged" | "ref";
  ref?: string;
  files: readonly GitDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  empty: boolean;
}

function errResult(
  code: string,
  message: string,
  suggestion: string,
  summary: string,
): ToolResult<GitDiffData> {
  return {
    ok: false,
    error: { code, message, retryable: false },
    suggestion,
    summary,
  };
}

export function gitDiffTool(): HertaTool {
  return {
    name: "git_diff",
    readOnly: true,
    schema(): ToolSchema {
      return {
        name: "git_diff",
        description:
          "Return structured git diff --stat summary. Defaults to working-tree-vs-HEAD. Pass { staged: true } for staged-only or { ref } for vs-ref. ref and staged are mutually exclusive. Read-only.",
        inputSchema: gitDiffJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<GitDiffData>> {
      const parsed = gitDiffInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return errResult(
          "invalid_input",
          formatInputIssues(parsed.error),
          "usage: {} or {staged: true} or {ref} — staged and ref are exclusive",
          "invalid input",
        );
      }
      const input = parsed.data;

      let mode: GitDiffData["mode"];
      let argv: string[];
      if (input.staged === true) {
        mode = "staged";
        argv = ["diff", "--stat", "--no-color", "--cached"];
      } else if (input.ref !== undefined) {
        mode = "ref";
        argv = ["diff", "--stat", "--no-color", input.ref];
      } else {
        mode = "working-tree";
        argv = ["diff", "--stat", "--no-color", "HEAD"];
      }

      const r = await spawnGit(ctx.workspaceRoot, argv, ctx.signal);
      if (!r.ok) {
        if (r.code === "not_a_repo") {
          return errResult(
            "not_a_repo",
            r.message,
            "this workspace is not a git repository — git tools are unavailable",
            "not a git repo",
          );
        }
        if (r.code === "spawn_failed") {
          return errResult(
            "spawn_failed",
            r.message,
            "git is not on PATH",
            "spawn failed",
          );
        }
        return errResult(
          "git_failed",
          r.message,
          "git exited non-zero; check the message",
          "git failed",
        );
      }

      const stat = parseDiffStat(r.stdout);
      const data: GitDiffData = {
        mode,
        ...(mode === "ref" && input.ref !== undefined
          ? { ref: input.ref }
          : {}),
        files: stat.files,
        totalAdditions: stat.totalAdditions,
        totalDeletions: stat.totalDeletions,
        empty: stat.files.length === 0,
      };
      const summary = data.empty
        ? "no diff"
        : `${data.files.length} files, +${data.totalAdditions}/-${data.totalDeletions}`;
      return { ok: true, data, summary };
    },
  };
}
