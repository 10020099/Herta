import type {
  HertaTool,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { errResult } from "../errors.js";
import {
  type GitStatusData,
  parseStatusPorcelain,
} from "../git/parse-status.js";
import { spawnGit } from "../git/spawn-git.js";
import { formatInputIssues } from "../input-issues.js";
import { gitStatusInputSchema, gitStatusJsonSchema } from "./schema.js";

export type { GitStatusData, GitStatusFile } from "../git/parse-status.js";
export type { GitStatusInput } from "./schema.js";

export function gitStatusTool(): HertaTool {
  return {
    name: "git_status",
    readOnly: true,
    schema(): ToolSchema {
      return {
        name: "git_status",
        description:
          "Return structured git working-tree status: branch + ahead/behind + per-file index/worktree status. Read-only.",
        inputSchema: gitStatusJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<GitStatusData>> {
      const parsed = gitStatusInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return errResult(
          "invalid_input",
          formatInputIssues(parsed.error),
          "usage: {} — git_status takes no arguments",
          "invalid input",
        );
      }

      const r = await spawnGit(
        ctx.workspaceRoot,
        ["status", "--porcelain=v1", "--branch", "--untracked-files=all"],
        ctx.signal,
      );
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

      const data = parseStatusPorcelain(r.stdout);
      const summary = data.clean ? "clean" : `${data.files.length} changed`;
      return { ok: true, data, summary };
    },
  };
}
