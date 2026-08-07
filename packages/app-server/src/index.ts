// @herta/app-server — surface-agnostic session API over the v0.2 runtime.
//
// See:
//   docs/superpowers/specs/2026-05-27-v0.3-slice-2-app-server-design.md
//   docs/superpowers/plans/2026-05-27-v0.3-slice-2-app-server.md
//
// Public surface:
//   - createSessionHost(config: AppServerConfig): SessionHost
//   - defaultDirsFor(opts): DefaultDirs (convenience for callers)
//   - All public types
//
// Re-export ApprovalOverlayState + the session record types from
// @herta/core so surface consumers (e.g. the GUI renderer) can pull the
// overlay vocabulary and record shapes from the app-server boundary
// instead of reaching into @herta/core directly. `types.ts` only
// *imports* TerminalRecord / TerminalRecordBlock / AgentEvent for its own
// declarations, so `export type * from "./types.js"` does NOT surface
// them — they must be re-exported explicitly here.
export type {
  AgentEvent,
  ApprovalOverlayState,
  SessionTopic,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
export type { DefaultDirs, DefaultDirsOpts } from "./config-helpers.js";
export { defaultDirsFor } from "./config-helpers.js";
export type { RecordTail } from "./record-window.js";
export { RECORD_TAIL_BLOCKS, recordTail } from "./record-window.js";
export { createSessionHost } from "./session-host.js";
export type { SessionSearchHit } from "./session-search.js";
export type * from "./types.js";
