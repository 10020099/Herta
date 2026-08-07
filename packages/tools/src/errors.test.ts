import { describe, expect, it } from "vitest";
import { TOOL_ERROR_CODES, type ToolErrorCode } from "./errors.js";

describe("ToolErrorCode", () => {
  it("exposes all documented error codes", () => {
    expect(TOOL_ERROR_CODES).toEqual([
      "path_denied",
      "path_outside_workspace",
      "not_found",
      "file_too_large",
      "binary_file",
      "invalid_input",
      "invalid_pattern",
      "read_failed",
      "empty_pattern",
      "read_required",
      "stale_read",
      "parse_failed",
      "hunk_not_found",
      "hunk_ambiguous",
      "hunk_overlap",
      "write_failed",
      "command_blocked",
      "timeout",
      "spawn_failed",
      "file_exists",
      "parent_invalid",
      "plan_invalid",
      "unknown_plan_item",
      "git_failed",
      "not_a_repo",
    ]);
  });

  it("compiles with the type", () => {
    const code: ToolErrorCode = "not_found";
    expect(code).toBe("not_found");
  });
});
