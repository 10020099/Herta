import { createHash } from "node:crypto";
import type { TerminalRecordBlock } from "@herta/core";
import type { Episode } from "./types.js";

export interface SegmentOptions {
  readonly episodeGapMs: number;
  readonly maxEpisodeBlocks: number;
  readonly maxEpisodeMs: number;
  /**
   * The verdict cut's cutover (ADR 0069 §4), ms epoch. A done/noop-marker
   * stamped at or after it no longer ends its episode: the cut moves to the
   * next user block, so Herta's verdict on the run — the speech right after
   * the marker — stays in the episode that holds the run's evidence. A
   * marker stamped before it, or unstamped, cuts where it always did, so
   * every episode dreamed before the cutover keeps its hash. The dream
   * manifest records the cutover the first time a pass runs with this rule
   * (`DreamManifest.verdictCutSince`); every segmenter that must agree with
   * the ledger reads it from there. Absent → the marker cut everywhere.
   */
  readonly verdictCutSinceMs?: number;
}

/**
 * Trailing-silence settling (ADR 0024): the session's FINAL episode has no
 * later block to settle it, but a silence of more than `episodeGapMs` after
 * its last stamped block is the same topic boundary the segmenter inserts
 * BETWEEN blocks — applied to the silence after the record's end. Without
 * this, every markerless (typically non-coding) session is one permanently
 * unsettled trailing episode and structurally invisible to the dream digest
 * — the bias that kept both E2E grief sessions out of the corpus while
 * done-marker-bounded commissions dreamed freely.
 *
 * Resume safety: if the session resumes after such a gap, the between-block
 * gap rule inserts a boundary at the same spot, so the resumed content forms
 * a NEW episode; the settled tail's blocks — and therefore its episodeHash —
 * are unchanged, and the manifest dedup keeps it single-dreamed.
 *
 * The silence is measured from the tail's last STAMPED block (the caller
 * walks back past unstamped ones); only a tail with no stamped block at all
 * cannot prove silence and stays unsettled (ADR 0024, amended 2026-09-23).
 */
export function isTailSettled(
  lastBlockAtMs: number | undefined,
  nowMs: number,
  episodeGapMs: number,
): boolean {
  if (lastBlockAtMs === undefined) return false;
  return nowMs - lastBlockAtMs > episodeGapMs;
}

export function episodeHash(blocks: readonly TerminalRecordBlock[]): string {
  const normalized = blocks.map((b) => {
    const text = b.kind === "system" ? b.body : b.text;
    const tag =
      b.kind === "herta" ? b.surface : b.kind === "system" ? b.label : "user";
    return [b.kind, tag, text];
  });
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** An episode is settled (dreamable) when a later block exists after its end. */
export function isSettled(end: number, recordLength: number): boolean {
  return end < recordLength;
}

/** Returns the parsed ms timestamp for a block, or undefined if absent/unparseable. */
function parseAt(b: TerminalRecordBlock): number | undefined {
  if (b.at === undefined) return undefined;
  const t = Date.parse(b.at);
  return Number.isFinite(t) ? t : undefined;
}

function isMarker(b: TerminalRecordBlock): boolean {
  return (
    b.kind === "system" &&
    (b.role === "done-marker" || b.role === "noop-marker")
  );
}

/** A marker past the cutover defers its cut to the next user block
 *  (ADR 0069 §4); see `SegmentOptions.verdictCutSinceMs`. */
function defersToVerdict(
  marker: TerminalRecordBlock,
  opts: SegmentOptions,
): boolean {
  if (opts.verdictCutSinceMs === undefined) return false;
  const at = parseAt(marker);
  return at !== undefined && at >= opts.verdictCutSinceMs;
}

/**
 * True between record[i-1] and record[i]: a topic boundary starts at i.
 *
 * Priority order:
 *   (a) idle gap        — both blocks timestamped and gap > episodeGapMs
 *   (b) done/noop-marker — structural settled point (a marker past the
 *       verdict cutover defers to the next user block — the caller's rule)
 *   (c) duration cap    — episode wall-clock span exceeds maxEpisodeMs
 *   (d) per-turn fallback — herta→user when timestamps are unavailable
 */
function isBoundary(
  prev: TerminalRecordBlock,
  cur: TerminalRecordBlock,
  episodeStartMs: number | undefined,
  opts: SegmentOptions,
): boolean {
  const prevMs = parseAt(prev);
  const curMs = parseAt(cur);

  // (a) Idle gap (only when both blocks carry a parseable `at`).
  if (prevMs !== undefined && curMs !== undefined) {
    if (curMs - prevMs > opts.episodeGapMs) return true;
  }

  // (b) Structural done/noop-marker — before the verdict cutover only.
  if (isMarker(prev) && !defersToVerdict(prev, opts)) {
    return true;
  }

  // (c) Duration cap: episode has run too long wall-clock even without idle gaps.
  if (episodeStartMs !== undefined && curMs !== undefined) {
    if (curMs - episodeStartMs > opts.maxEpisodeMs) return true;
  }

  // (d) Per-turn fallback — only when timestamps are unavailable at this boundary.
  if (
    (prevMs === undefined || curMs === undefined) &&
    prev.kind === "herta" &&
    cur.kind === "user"
  ) {
    return true;
  }

  return false;
}

export function segmentSession(
  sessionId: string,
  record: readonly TerminalRecordBlock[],
  opts: SegmentOptions,
  /** Pass-time clock for trailing-silence settling (ADR 0024). Callers that
   *  only care about internal boundaries may omit it — the tail episode then
   *  stays unsettled exactly as before. */
  nowMs?: number,
): Episode[] {
  const episodes: Episode[] = [];
  let start = 0;
  // Track the wall-clock start of the current episode (first parseable `at`
  // at/after `start`). Reset on each flush.
  const firstBlock = record[0];
  let episodeStartMs: number | undefined =
    firstBlock !== undefined ? parseAt(firstBlock) : undefined;

  const flush = (end: number): void => {
    if (end <= start) return;
    const blocks = record.slice(start, end);
    // A later block settles the episode; the record's FINAL episode settles
    // via trailing silence instead (ADR 0024): a gap of more than
    // episodeGapMs between its last stamped block and pass-time `nowMs` is
    // the same boundary the segmenter inserts between blocks.
    let settled = isSettled(end, record.length);
    if (!settled && nowMs !== undefined) {
      let lastAt: number | undefined;
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        lastAt = b === undefined ? undefined : parseAt(b);
        if (lastAt !== undefined) break;
      }
      settled = isTailSettled(lastAt, nowMs, opts.episodeGapMs);
    }
    episodes.push({
      sessionId,
      episodeHash: episodeHash(blocks),
      blocks,
      startIndex: start,
      endIndex: end,
      settled,
    });
    start = end;
    // Reset episode start to the first parseable timestamp at/after the new start.
    const nextBlock = record[start];
    episodeStartMs = nextBlock !== undefined ? parseAt(nextBlock) : undefined;
    // If the new start block is unstamped, episodeStartMs will be adopted from
    // the first stamped block encountered in the loop below.
  };

  // A marker past the verdict cutover was seen in the current episode: the
  // episode ends at the next user block instead, after Herta's verdict on
  // the run (ADR 0069 §4). The review found the old cut stranding it: the
  // run's evidence closed one episode, and the verdict opened the next as
  // an ungrounded claim over a digest with no evidence in it.
  let verdictPending = false;
  for (let i = 1; i < record.length; i++) {
    const cur = record[i];
    const prev = record[i - 1];
    if (cur === undefined || prev === undefined) continue;

    // Adopt first stamped block within the episode if start was unstamped.
    if (episodeStartMs === undefined) {
      const t = parseAt(cur);
      if (t !== undefined) episodeStartMs = t;
    }

    if (isMarker(prev) && defersToVerdict(prev, opts)) verdictPending = true;

    if (
      isBoundary(prev, cur, episodeStartMs, opts) ||
      (verdictPending && cur.kind === "user") ||
      i - start >= opts.maxEpisodeBlocks
    ) {
      flush(i);
      verdictPending = false;
    }
  }
  flush(record.length);
  return episodes;
}
