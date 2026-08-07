import type { RiskLevel } from "../permission-engine.js";

/**
 * Ephemeral user-only UI state for in-flight approval prompts. Per D7,
 * this state must NEVER enter TerminalRecord and must NEVER reach Herta's
 * prompt context. The outcome of an approval becomes a system block
 * (label "系统") in TerminalRecord; the overlay state itself does not.
 *
 * SPEC v0.2 §4.3.
 */
export interface IdleApprovalOverlay {
  readonly kind: "idle";
}

export interface PendingPermissionApproval {
  readonly kind: "pending-permission";
  readonly requestId: string;
  readonly risk: RiskLevel;
  /** request.call.tool — which tool wants to run. */
  readonly tool: string;
  /** request.reason — one-line human-readable description of the operation. */
  readonly summary: string;
  /** request.code — stable ask-class code (e.g. "command_ask_unknown").
   *  The GUI localizes the summary line by this code when it recognizes it;
   *  `summary` stays the neutral-English fallback (D2). */
  readonly code?: string;
  /** run_command only: argv joined with spaces. Undefined for other tools. */
  readonly command?: string;
  /** request.diff — the unified diff behind a file-write ask (edit_file /
   *  write_new_file). The GUI shows it behind a collapsed disclosure so the
   *  user can inspect exactly what changes before deciding (user 2026-07-24;
   *  the record's patch preview carries the same diff, but it sits in a
   *  collapsed activity group above the panel at decision time). */
  readonly diff?: string;
  /** request.files, when the request names target files. */
  readonly files?: readonly string[];
  /** Whether a "yes-and-remember (session)" choice would actually be cached
   *  for this request — SessionApprovalCache.isCacheable(tool, risk, scope).
   *  The GUI hides its "always allow" button when this is not true, so the
   *  user is never offered a choice that silently no-ops and re-prompts
   *  (audit T3.4 follow-up; mirrors the CLI's showRemember gate). Absent on
   *  hand-built test/legacy overlays → treated as not cacheable. */
  readonly cacheable?: boolean;
  /** Display form of the ONE project rule a persistence:"always" resolution
   *  would save (`node src/index.mjs:*` — ADR 0030). Present only when the
   *  ask class is rule-eligible AND a rule is derivable; the GUI hides its
   *  「本项目允许」 button otherwise — same never-offer-a-no-op contract as
   *  `cacheable` above. */
  readonly projectRule?: string;
}

export interface PendingCommandApproval {
  readonly kind: "pending-command";
  readonly requestId: string;
  readonly command: string;
}

export type ApprovalOverlayState =
  | IdleApprovalOverlay
  | PendingPermissionApproval
  | PendingCommandApproval;
