import type { TerminalRecordBlock } from "@herta/core";
import { liveDreamRecords } from "./manifest.js";
import { segmentSession } from "./segment-session.js";
import type { DreamConfig, DreamManifest } from "./types.js";

/**
 * Reopen own-dream filter (design 2026-07-07).
 *
 * When a session is reopened after a Dream pass has distilled some of its
 * episodes into 废案, the static prefix would otherwise carry a "past memory"
 * of events that still sit verbatim in the reopened record below it — Herta
 * remembering the ongoing conversation as if from another life. This module
 * decides which dreamed 废案 to withhold from ONE session-open's prefix:
 *
 * - Source episode still verbatim in the prompt window (at/after the recap
 *   boundary, or no recap engaged at all) → EXCLUDE: pure duplication.
 * - Source episode behind the recap boundary → INCLUDE: its detail survives
 *   only as a line of the ≤maxRecapChars recap, so the 废案 is recovered
 *   information, not duplication.
 * - Source episodes from other sessions → INCLUDE (hashes never match this
 *   record's segmentation, so this falls out of the matching rule).
 *
 * Matching is by episode content hash against a deterministic re-segmentation
 * of the current record: appending blocks only ever creates NEW episodes
 * (a dreamable episode is always closed by a ≥episodeGapMs gap, because the
 * Dream trigger requires an idle window longer than that gap), so hashes of
 * previously dreamed episodes are stable across the record's growth.
 *
 * The exclusion is per-prompt only — the 废案 file, its manifest entry, and
 * its retention/reactivation bookkeeping are untouched; other sessions and
 * later opens see it normally.
 */
export interface PromptExclusionInputs {
  readonly manifest: DreamManifest;
  readonly sessionId: string;
  /** The record the session is (re)opening with, as loaded from disk. */
  readonly record: readonly TerminalRecordBlock[];
  /** Sticky compaction boundary for this session: blocks BEFORE this index
   *  reach the prompt only via the recap; blocks at/after it are verbatim.
   *  0 = no recap engaged (the whole record is verbatim). The caller is
   *  responsible for validating a cached boundary the same way the recap
   *  runtime does before passing it in. */
  readonly recapBoundaryIndex: number;
  readonly config: Pick<
    DreamConfig,
    "episodeGapMs" | "maxEpisodeBlocks" | "maxEpisodeMs"
  >;
}

/**
 * Filenames (relative to `.herta/narrative/`) of live dreamed 废案 whose
 * source content is still verbatim in this session-open's prompt window.
 * Empty set when there is nothing to withhold.
 */
export function selectPromptExclusions(
  inputs: PromptExclusionInputs,
): ReadonlySet<string> {
  const { manifest, sessionId, record, recapBoundaryIndex, config } = inputs;
  const excluded = new Set<string>();
  const live = liveDreamRecords(manifest);
  if (live.length === 0 || record.length === 0) return excluded;

  // hash → end index of the episode in the current record. Built once per
  // open; segmentation is pure and linear in the record length.
  const episodeEnd = new Map<string, number>();
  for (const ep of segmentSession(sessionId, record, config)) {
    episodeEnd.set(ep.episodeHash, ep.endIndex);
  }

  for (const rec of live) {
    // Withhold only when EVERY source episode is still verbatim in this
    // window — then the record adds nothing the prompt doesn't already show.
    // A reconsolidated record that also accretes episodes from other sessions
    // (or from behind the recap boundary) stays in: it carries genuine past
    // the record can't, and losing that costs more than partial overlap.
    const allSourcesVerbatim = rec.sourceEpisodes.every((hash) => {
      const end = episodeEnd.get(hash);
      return end !== undefined && end > recapBoundaryIndex;
    });
    if (allSourcesVerbatim && rec.sourceEpisodes.length > 0) {
      excluded.add(rec.file);
    }
  }
  return excluded;
}
