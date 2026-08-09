import type { HertaTool } from "@herta/core";
import { editFileTool } from "./edit-file/index.js";
import { gitDiffTool } from "./git-diff/index.js";
import { gitStatusTool } from "./git-status/index.js";
import { globTool } from "./glob/index.js";
import { listFilesTool } from "./list-files/index.js";
import { memorySaveTool } from "./memory-save/index.js";
import { readFileTool } from "./read-file/index.js";
import {
  commandOutputTool,
  commandStopTool,
  runCommandTool,
} from "./run-command/index.js";
import { searchTextTool } from "./search-text/index.js";
import { showExcerptTool } from "./show-excerpt/index.js";
import { todoWriteTool } from "./todo-write/index.js";
import { writeNewFileTool } from "./write-new-file/index.js";

// Exported for the attachment ingest (ADR 0033): the denylist must apply to
// the SOURCE file at the door, because safeStoredName's hash suffix means the
// stored name (`id_rsa-ab12cd34`) no longer matches the basename rules — a
// deny that only ran on the stored side would be a bypass, not a guard.
export {
  isCredentialBasename,
  isSensitiveSegment,
} from "./credential-denylist.js";
export type { EditFileData, EditFileRuleDeps } from "./edit-file/index.js";
export {
  editFileTool,
  makeEditFileRule,
  registerEditFileRule,
} from "./edit-file/index.js";
export type { EditFileInput } from "./edit-file/schema.js";
export type { ToolErrorCode } from "./errors.js";
export { TOOL_ERROR_CODES } from "./errors.js";
export type { GitDiffData, GitDiffFile } from "./git-diff/index.js";
export { gitDiffTool } from "./git-diff/index.js";
export type { GitDiffInput } from "./git-diff/schema.js";
export type { GitStatusData, GitStatusFile } from "./git-status/index.js";
export { gitStatusTool } from "./git-status/index.js";
export type { GitStatusInput } from "./git-status/schema.js";
export { globToRegExp } from "./glob/glob-to-regex.js";
export type { GlobData, GlobFileEntry } from "./glob/index.js";
export { globTool } from "./glob/index.js";
export type { GlobInput } from "./glob/schema.js";
export type { ListFilesData } from "./list-files/index.js";
export { listFilesTool } from "./list-files/index.js";
export type { ListFilesInput } from "./list-files/schema.js";
export type { MemorySaveData } from "./memory-save/index.js";
export { memorySaveTool } from "./memory-save/index.js";
export type { MemorySaveInput } from "./memory-save/schema.js";
// Exported so the attachment ingest (ADR 0033) can assert end-to-end that
// whatever it writes is reachable through the carve-out and refused without
// it — the two halves living in different packages is exactly why that needs
// a test rather than a shared assumption.
export type { ResolveSafePathOpts, SafePathResult } from "./path-safety.js";
export { resolveSafePath } from "./path-safety.js";
export type { ReadFileData } from "./read-file/index.js";
export { readFileTool } from "./read-file/index.js";
export type { ReadFileInput } from "./read-file/schema.js";
export type { RunCommandData } from "./run-command/index.js";
export {
  commandOutputTool,
  commandStopTool,
  makeRunCommandRule,
  registerRunCommandRule,
  runCommandTool,
} from "./run-command/index.js";
export type { RunCommandInput } from "./run-command/schema.js";
export type { SearchMatch, SearchTextData } from "./search-text/index.js";
export { searchTextTool } from "./search-text/index.js";
export type { SearchTextInput } from "./search-text/schema.js";
export {
  MAX_EXCERPT_CHARS,
  MAX_EXCERPT_LINES,
  showExcerptTool,
} from "./show-excerpt/index.js";
export type { ShowExcerptInput } from "./show-excerpt/schema.js";
export { looksBinary, SNIFF_BYTES } from "./text-sniff.js";
export type { TodoWriteData } from "./todo-write/index.js";
export { MAX_TODO_ITEMS, todoWriteTool } from "./todo-write/index.js";
export type { TodoWriteInput } from "./todo-write/schema.js";
export {
  canonicalWorkspaceRoot,
  validateWorkspaceRoot,
  type WorkspaceRootCheck,
} from "./validate-workspace-root.js";
export type {
  WriteNewFileData,
  WriteNewFileRuleDeps,
} from "./write-new-file/index.js";
export {
  makeWriteNewFileRule,
  registerWriteNewFileRule,
  writeNewFileTool,
} from "./write-new-file/index.js";
export type { WriteNewFileInput } from "./write-new-file/schema.js";

export function createMvpTools(): HertaTool[] {
  return [
    readFileTool(),
    // Presentation, not navigation: read_file is silent to the user and to
    // Herta, so "show me what's in that file" needs its own tool (ADR 0027).
    showExcerptTool(),
    listFilesTool(),
    searchTextTool(),
    globTool(),
    editFileTool(),
    runCommandTool(),
    commandOutputTool(),
    commandStopTool(),
    writeNewFileTool(),
    todoWriteTool(),
    gitStatusTool(),
    gitDiffTool(),
    memorySaveTool(),
  ];
}

// The lore tools (lore_search / lore_open / lore_neighbors) were removed
// 2026-07-06: no runtime ever registered them (both bootstraps use only
// createMvpTools), and the packaged app deliberately ships without the
// knowledge DB they query. If canon search ever becomes a real feature,
// restore them from git history as a power-user, bring-your-own-DB tool
// set — the DB stays non-redistributable either way.
