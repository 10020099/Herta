import type { TerminalRecordBlock } from "@herta/app-server";
import type { SystemBlock } from "./group-record.js";

/** The todo member of the system-block digest union (no name-import needed). */
type TodoDigest = Extract<NonNullable<SystemBlock["digest"]>, { kind: "todo" }>;

/** One row of the projected plan (derived from the block, no name-import). */
export type TodoDigestItem = NonNullable<TodoDigest["items"]>[number];

/**
 * The current dispatch's plan as of its NEWEST todo projection.
 *
 * `total` / `completed` / `current` mirror that digest's counts verbatim.
 * `items` is always an array so a caller can map it unconditionally — but an
 * empty array is ambiguous on its own, so `itemsKnown` says which emptiness it
 * is: `false` means the source digest predates the `items` field (a record
 * persisted before 2026-07-26), i.e. the list is UNKNOWN and the caller should
 * fall back to the counts; `true` with a zero-length array means the plan
 * genuinely holds no rows. Callers must not infer "no plan" from
 * `items.length === 0`.
 */
export interface PlanContext {
  readonly total: number;
  readonly completed: number;
  /** The in-flight item's text, absent when nothing is in progress. */
  readonly current?: string;
  readonly items: readonly TodoDigestItem[];
  readonly itemsKnown: boolean;
}

function toPlanContext(d: TodoDigest): PlanContext {
  return {
    total: d.total,
    completed: d.completed,
    ...(d.current !== undefined ? { current: d.current } : {}),
    items: d.items ?? [],
    itemsKnown: d.items !== undefined,
  };
}

/**
 * The plan state in scope for the CURRENT dispatch, or null when none is.
 *
 * `todo_write` is full-list replacement (ADR 0025), so the only honest source
 * of live plan state is the newest todo projection — an older layout block
 * describes a list that may no longer exist. This scans BACKWARD from the end
 * of the record (the live activity group is always last) and returns the first
 * todo digest it finds, subject to two rules:
 *
 *   - A herta block does NOT stop the scan. That is the entire point of this
 *     helper: an in-turn beat splits one backend run into separate activity
 *     groups, and `ActivityBlock` only ever sees its OWN blocks — so the
 *     continuation group has no todo projection of its own and would forget
 *     the plan. The record is one shared timeline (D7); the plan is a property
 *     of the dispatch, not of the group that happens to render it.
 *   - A user block, or a system block with role "done-marker" / "noop-marker",
 *     DOES stop the scan. Those are dispatch boundaries: a user block starts a
 *     new turn, and a terminal marker means the run whose plan this was has
 *     already finished. A consequence worth knowing before wiring: the moment
 *     a dispatch's own marker lands, this returns null again for that group —
 *     the plan strip is live status, and a completed run's header summary
 *     replaces it.
 *
 * `items` rides the newest digest, but a digest persisted before that field
 * existed carries none. Such a block still yields counts (with
 * `itemsKnown: false`) rather than null, so the caller decides what to render
 * instead of the plan silently vanishing on an old session. If an older
 * in-scope digest DOES carry items while the newest does not, the older one
 * wins outright — counts and rows always come from ONE block, never merged
 * across two, so the returned state is always internally consistent even when
 * it is a beat stale.
 *
 * Known limitation, deliberately not solved here: `Conversation` renders a
 * WINDOW of a long record (`recordStart` / `RECORD_TAIL_BLOCKS`), so a plan
 * whose projection has scrolled out of the window is simply not in the array
 * this receives. It yields null and the strip does not render. Paging the
 * older blocks back in to hunt for it would trade a missing strip for a
 * record fetch on every frame.
 *
 * Pure presentation — reads the record, never touches it (D7).
 */
export function planContext(
  record: readonly TerminalRecordBlock[],
): PlanContext | null {
  const scope = planScope(record);
  return scope.kind === "plan" ? scope.plan : null;
}

/**
 * Why there is no plan in scope — the distinction `planContext`'s bare `null`
 * cannot make, and a caller that RETRACTS on it must (audit 2026-07-26).
 *
 * `Conversation` trims the live window back to the 200-block tail once it runs
 * 60 past it, so a long dispatch can push its own todo projection out of the
 * array this function is handed. Reading that as "the dispatch ended" is the
 * outcome-inference anti-pattern exactly: the plan card would slide away
 * mid-run because the RENDERER dropped some rows, not because 板砖 finished.
 *
 *   - "plan"    — found one; use it.
 *   - "ended"   — the scan hit this dispatch's terminal marker. Definitive.
 *   - "absent"  — the scan hit a user block first: this turn has no plan.
 *                 Definitive.
 *   - "unknown" — the scan ran off the START of the array without hitting
 *                 either boundary. The window truncated it, so nothing can be
 *                 concluded; a live card should HOLD rather than act.
 */
export type PlanScope =
  | { readonly kind: "plan"; readonly plan: PlanContext }
  | { readonly kind: "ended" }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

export function planScope(record: readonly TerminalRecordBlock[]): PlanScope {
  let newest: TodoDigest | null = null;
  for (let i = record.length - 1; i >= 0; i -= 1) {
    const block = record[i];
    if (block === undefined) continue;
    if (block.kind === "user") {
      return newest === null
        ? { kind: "absent" }
        : { kind: "plan", plan: toPlanContext(newest) };
    }
    if (block.kind !== "system") continue;
    if (block.role === "done-marker" || block.role === "noop-marker") {
      return newest === null
        ? { kind: "ended" }
        : { kind: "plan", plan: toPlanContext(newest) };
    }
    const digest = block.digest;
    if (digest?.kind !== "todo") continue;
    // First one carrying items wins immediately; otherwise remember the
    // newest and keep looking for one that does.
    if (digest.items !== undefined) {
      return { kind: "plan", plan: toPlanContext(digest) };
    }
    if (newest === null) newest = digest;
  }
  // Ran off the start of the array: no boundary was ever reached.
  return newest === null
    ? { kind: "unknown" }
    : { kind: "plan", plan: toPlanContext(newest) };
}
