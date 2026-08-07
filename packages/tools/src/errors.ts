export type ToolErrorCode =
  | "path_denied"
  | "path_outside_workspace"
  | "not_found"
  | "file_too_large"
  | "binary_file"
  | "invalid_input"
  | "invalid_pattern"
  | "read_failed"
  | "empty_pattern"
  | "read_required"
  | "stale_read"
  | "parse_failed"
  | "hunk_not_found"
  | "hunk_ambiguous"
  | "hunk_overlap"
  | "write_failed"
  | "command_blocked"
  | "timeout"
  | "spawn_failed"
  | "file_exists"
  | "parent_invalid"
  | "plan_invalid"
  | "unknown_plan_item"
  | "git_failed"
  | "not_a_repo";

export const TOOL_ERROR_CODES: readonly ToolErrorCode[] = [
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
] as const;
