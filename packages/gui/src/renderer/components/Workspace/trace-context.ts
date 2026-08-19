import type { TerminalRecordBlock } from "@herta/app-server";
import type { SystemBlock } from "./group-record.js";

/** The op member of the system-block digest union (no name-import needed). */
type OpDigest = Extract<NonNullable<SystemBlock["digest"]>, { kind: "op" }>;

/**
 * A structured result note for one op row. Structured, not a string, for the
 * same reason every digest is: the CARD localizes its chrome on the UI locale
 * (like PlanCard), and a pre-baked string would freeze one language into the
 * derivation.
 */
export type TraceNote =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "signal" }
  | {
      readonly kind: "tests";
      readonly summary: string;
      readonly failed: boolean;
    }
  | { readonly kind: "fail"; readonly code: string }
  | { readonly kind: "matches"; readonly n: number };

export interface TraceOp {
  readonly verb: OpDigest["verb"];
  /** The op's argument — the record row's own string, verbatim (D7). */
  readonly arg: string;
  /** "running" = no result row yet and no later op has started. */
  readonly status: "running" | "ok" | "fail";
  readonly note?: TraceNote;
}

/**
 * The card keeps the last N op ROWS only (a long-run dispatch lands
 * hundreds — the owner's question was exactly "does the card grow without
 * stop?"). The counts stay honest over the WHOLE dispatch (`steps`,
 * `writes` are computed before the trim), so the header reads `87 步` while
 * the list shows the recent window — recency, not completeness, same claim
 * the partial-window scan already makes. 24 bounds the DOM; the CSS
 * max-height on the list bounds what is visible (~6 rows, scrollable).
 */
export const TRACE_MAX_ROWS = 24;

export interface TraceContext {
  /** The newest ops of the current dispatch (≤ TRACE_MAX_ROWS), oldest
   *  first. `firstOrdinal` is the 0-based index of `ops[0]` within the
   *  whole dispatch — the card keys rows by ordinal so a sliding window
   *  never replays entrance animations on rows that merely shifted. */
  readonly ops: readonly TraceOp[];
  readonly firstOrdinal: number;
  /** Total op count of the dispatch (the header's `N 步`). */
  readonly steps: number;
  /** Distinct files written (Writing-verb args), over the whole dispatch. */
  readonly writes: number;
  /** True while the newest op has no result yet. */
  readonly running: boolean;
}

/**
 * Why there is no trace in scope — same shape and same rationale as
 * `PlanScope` (plan-context.ts): a caller that RETRACTS on the answer must
 * know whether the dispatch ENDED or the window merely truncated the scan.
 */
export type TraceScope =
  | { readonly kind: "trace"; readonly trace: TraceContext }
  | { readonly kind: "ended" }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

/**
 * The CURRENT dispatch's operation trace, derived from the record's own
 * activity rows (the 操作轨迹 rail card, 2026-08-17).
 *
 * The 极简 contract (ADR 0040) has no todo tool by design, so PlanCard never
 * mounts for its dispatches and the rail said only THAT 板砖 was busy, not
 * WHAT it was doing — while the conversation's op rows scrolled away exactly
 * the way the inline plan strip used to (the reason PlanCard moved to the
 * rail). This is the same solution for the same problem: a pinned projection
 * of state the record already carries. Nothing new is emitted; every string
 * shown is a digest field of a block the user (and Herta) already has (D7).
 *
 * Scan boundaries mirror `planScope` exactly, and for the same reasons:
 *   - herta blocks do NOT stop the scan (a beat splits one run into several
 *     activity groups; the trace is a property of the dispatch);
 *   - a user block stops it (turn boundary) — ops found → trace, none →
 *     absent;
 *   - a terminal marker stops it — ops found ABOVE it belong to a NEWER
 *     chained dispatch → trace; none → ended;
 *   - running off the start of the windowed array concludes nothing: ops in
 *     hand are still shown (a partial trace is honest — it claims recency,
 *     not completeness), but with none the answer is unknown and a live
 *     card should HOLD (outcome-inference rule, audit 2026-07-26).
 *
 * Status attach is serial by construction: the minimal contract's bash runs
 * one command at a time, and result rows (`↳ 退出 …`, `↳ 测试 …`, failure
 * rows) land immediately after their op. A new op starting therefore settles
 * the previous one as "ok" if no result row claimed otherwise. (标准-mode
 * parallel read batches interleave starts — those dispatches normally carry
 * a plan, so PlanCard owns the slot and this trace is not shown.)
 */
export function traceScope(record: readonly TerminalRecordBlock[]): TraceScope {
  const collected: SystemBlock[] = [];
  for (let i = record.length - 1; i >= 0; i -= 1) {
    const block = record[i];
    if (block === undefined) continue;
    if (block.kind === "user") {
      const trace = build(collected);
      return trace.steps > 0 ? { kind: "trace", trace } : { kind: "absent" };
    }
    if (block.kind !== "system") continue;
    if (block.role === "done-marker" || block.role === "noop-marker") {
      const trace = build(collected);
      return trace.steps > 0 ? { kind: "trace", trace } : { kind: "ended" };
    }
    collected.push(block);
  }
  const trace = build(collected);
  return trace.steps > 0 ? { kind: "trace", trace } : { kind: "unknown" };
}

/** Collected newest-first; processed oldest-first. */
function build(collectedNewestFirst: readonly SystemBlock[]): TraceContext {
  const ops: TraceOp[] = [];
  const amendLast = (patch: Partial<TraceOp>): void => {
    const last = ops[ops.length - 1];
    if (last === undefined) return;
    ops[ops.length - 1] = { ...last, ...patch };
  };
  for (let i = collectedNewestFirst.length - 1; i >= 0; i -= 1) {
    const d = collectedNewestFirst[i]?.digest;
    if (d === undefined) continue;
    switch (d.kind) {
      case "op": {
        // Serial completion: the next op starting means the previous one
        // finished; a result row would already have settled it.
        const last = ops[ops.length - 1];
        if (last !== undefined && last.status === "running") {
          amendLast({ status: "ok" });
        }
        ops.push({ verb: d.verb, arg: d.arg, status: "running" });
        break;
      }
      case "text": {
        if (d.exitCode === undefined) break; // generic text row, not a result
        if (d.exitCode === null) {
          amendLast({ status: "fail", note: { kind: "signal" } });
        } else {
          amendLast({
            status: d.exitCode === 0 ? "ok" : "fail",
            note: { kind: "exit", code: d.exitCode },
          });
        }
        break;
      }
      case "tests": {
        const failed = d.status === "failed";
        amendLast({
          status: failed ? "fail" : "ok",
          note: { kind: "tests", summary: d.summary, failed },
        });
        break;
      }
      case "tool-fail":
        amendLast({ status: "fail", note: { kind: "fail", code: d.code } });
        break;
      case "search":
        amendLast({ note: { kind: "matches", n: d.matches } });
        break;
      default:
        break; // todo / bg / excerpt / finding / attachment / skip
    }
  }
  const writes = new Set(
    ops.filter((op) => op.verb === "Writing").map((op) => op.arg),
  ).size;
  const last = ops[ops.length - 1];
  const trimmed =
    ops.length > TRACE_MAX_ROWS ? ops.slice(-TRACE_MAX_ROWS) : ops;
  return {
    ops: trimmed,
    firstOrdinal: ops.length - trimmed.length,
    steps: ops.length,
    writes,
    running: last?.status === "running",
  };
}

/** The held (post-run) view settles every still-running op as done — the
 *  marker landed, so nothing is in flight. Used by the card when the scope
 *  flips to "ended" while the trace is on screen. */
export function settleTrace(trace: TraceContext): TraceContext {
  if (!trace.running) return trace;
  return {
    ...trace,
    running: false,
    ops: trace.ops.map((op) =>
      op.status === "running" ? { ...op, status: "ok" } : op,
    ),
  };
}
