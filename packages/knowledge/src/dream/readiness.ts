import type { TerminalRecord } from "@herta/core";

/** Count 黑塔 turns — speech or thought blocks — in a session record. This is
 *  the voice-density proxy the material gate uses to judge a single session as
 *  "long enough" to distill on its own (user/系统/差分协处理器 blocks don't count). */
export function countHertaTurns(record: TerminalRecord): number {
  let n = 0;
  for (const block of record) {
    if (block.kind === "herta") n++;
  }
  return n;
}

/**
 * True when a session's last-activity timestamp is strictly after the anchor —
 * i.e. the session was modified since the last completed pass. Unparseable
 * timestamps are treated as NOT modified (excluded). `sinceMs` is the ms-epoch
 * of the last completed pass; pass 0 when no pass has ever completed, so every
 * parseable session counts as new.
 */
export function isModifiedSince(
  lastActivityAt: string,
  sinceMs: number,
): boolean {
  const at = Date.parse(lastActivityAt);
  return !Number.isNaN(at) && at > sinceMs;
}

export interface MaterialThresholds {
  /** Fire if at least this many sessions are new since the last completed pass. */
  readonly minNewSessions: number;
  /** ...or if any single new session has at least this many 黑塔 turns. */
  readonly minSessionHertaTurns: number;
}

/**
 * Decide whether enough new material has accumulated to justify a Dream pass.
 *
 * `newSessionRecords` is the set of session records modified since the last
 * completed pass. Returns true when there are enough new sessions OR one of
 * them is long enough on its own (by 黑塔 turn count). The cadence floor
 * (cooldown) is enforced separately by the trigger — this is only the
 * "is there anything worth distilling" half of the gate.
 */
export function hasEnoughMaterial(
  newSessionRecords: readonly TerminalRecord[],
  thresholds: MaterialThresholds,
): boolean {
  if (newSessionRecords.length >= thresholds.minNewSessions) return true;
  for (const record of newSessionRecords) {
    if (countHertaTurns(record) >= thresholds.minSessionHertaTurns) return true;
  }
  return false;
}
