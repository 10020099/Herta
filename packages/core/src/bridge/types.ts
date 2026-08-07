/**
 * Actor-to-backend dispatch. Carries the bare minimum: an opaque task id
 * for tracing. The backend reconstructs its task context from the
 * `userMessages` history threaded through `BackendBuildInput`, NOT from
 * any framing the actor (Herta) writes.
 *
 * Pre-May 2026 this carried `userRequestQuoted` + `hertaInterpretation`
 * + `taskType` + `successCriteria` + `constraints`. That contract forced
 * Herta to wear two hats — speaker AND task framer — and the framer
 * half produced a bureaucratic LLM-written interpretation that the
 * backend then took as ground truth. Replaced with a zero-arg-ish
 * dispatch so Herta is a pure speaker and the agent reads the user's
 * actual words.
 */
export interface HertaToAgentBrief {
  taskId: string;
}

export interface ChangedFileSummary {
  path: string;
  kind: "created" | "modified" | "deleted";
  diffSummary: string;
}

export interface EvidenceItem {
  kind: "file" | "search" | "command" | "test" | "git" | "tool";
  summary: string;
  source?: string;
}

export interface TestRunSummary {
  command: string;
  status: "passed" | "failed" | "skipped" | "not_run";
  summary: string;
}

/**
 * Result-data shape of the `run_command` tool. Lives in core (not
 * @herta/tools) because it is a cross-layer contract: the tool produces
 * it, and the bridge layer (@herta/herta's backend-bridge) reads it to
 * project command results into the terminal record. Keeping it here
 * keeps the package graph a DAG — @herta/herta must not depend on
 * @herta/tools (tools → knowledge → herta would close a reference
 * cycle; found 2026-07-05 when a stale-dist build broke on the cycle).
 * @herta/tools re-exports this type for its own consumers.
 */
export interface RunCommandData {
  argv: readonly string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  logPath: string;
  timedOut: boolean;
  /**
   * Populated when the command is a recognized test runner (npm/pnpm
   * test, pytest, cargo test, go test). The bridge layer's report
   * absorber picks this up to populate AgentExecutionReport.tests[].
   * Absent for non-test commands.
   */
  testRun?: TestRunSummary;
  /**
   * Managed background commands (ADR 0025 slice 4): `backgroundId` is
   * set on the run_command start result and on every command_output /
   * command_stop snapshot; `running` is true while the process is
   * alive. The bridge projects a "background … running" row instead of
   * an exit row when `running` is set.
   */
  backgroundId?: string;
  running?: boolean;
}

/**
 * Result-data shape of the `show_excerpt` tool (ADR 0027). Lives in core for
 * the same reason as {@link RunCommandData} — the tool produces it and the
 * bridge reads it, and @herta/herta must not depend on @herta/tools.
 */
export interface ShowExcerptData {
  /** The slice, line-numbered like read_file's content. Verbatim from disk:
   *  the harness cut it, so nothing paraphrased it on the way here. */
  excerpt: string;
  /** 1-based inclusive line range actually returned. */
  range: [number, number];
  totalLines: number;
  /** The requested span was clipped by the presentation bounds. */
  truncated: boolean;
  relPath: string;
}

export interface PermissionEventSummary {
  tool: string;
  /**
   * Risk label as classified by the deterministic permission engine.
   * Intentionally `string` (not the `RiskLevel` union from
   * permission-engine) to keep the bridge contract decoupled from
   * permission-engine internals.
   */
  risk: string;
  /**
   * `"allow"` and `"deny"` are user decisions; `"blocked"` is the
   * deterministic auto-deny case where no user prompt fired.
   */
  decision: "allow" | "deny" | "blocked";
  summary: string;
}

/**
 * How a 板砖 brief ENDED. `interrupted` is a first-class member (audit
 * 2026-07-24, 1.4): the turn loop already distinguishes a user abort from an
 * internal failure (`error.kind`), but the runtime collapsed every
 * `turn.failed` into one boolean, so pressing Stop was durably recorded as
 * 板砖 失败 — a lie the record kept, Herta narrated, and the next dispatch
 * inherited as a prior-run failure.
 */
export type ExecutionStatus =
  | "completed"
  | "blocked"
  | "failed"
  | "interrupted"
  | "partial";

/**
 * Structured report the backend returns to the actor. No model-written
 * `summary` field — Herta synthesizes her commentary from the concrete
 * artifacts below, not from a prose paraphrase the agent wrote about
 * itself. This is the load-bearing rule for "Herta is the self that uses
 * the agent, not a re-renderer of the agent's voice" (PHILOSOPHY §5).
 */
export interface AgentExecutionReport {
  taskId: string;
  status: ExecutionStatus;
  changedFiles: readonly ChangedFileSummary[];
  evidence: readonly EvidenceItem[];
  tests: readonly TestRunSummary[];
  permissions: readonly PermissionEventSummary[];
  residualRisks: readonly string[];
  nextActions: readonly string[];
}
