import {
  estimatePromptTokens,
  type TerminalRecord,
  type TerminalRecordBlock,
} from "@herta/core";
import type { PromptLang } from "./prompt-lang.js";

/** User-selectable automatic-compaction thresholds for the 1M-token actor window. */
export type CompactionLevel =
  | "minimal"
  | "low"
  | "standard"
  | "balanced"
  | "max";

export const DEFAULT_COMPACTION_LEVEL: CompactionLevel = "standard";

export interface CompactionConfig {
  readonly enabled: boolean;
  readonly contextWindowTokens: number;
  readonly bufferFraction: number;
  readonly recentWindowTokens: number;
  readonly minRecentTurns: number;
  readonly maxRecentWindowTokens: number;
  readonly maxRecapChars: number;
  /** Head excerpt of HertaBio injected into the summarizer prompt as a
   *  first-person voice/style anchor (0 disables). The bootstrap slices
   *  HertaBio.txt to this length. */
  readonly maxBioChars: number;
  readonly rederiveEveryNAdvances: number;
  readonly maxConsecutiveRecapFailures: number;
  /** Half-open probe cadence for the recap circuit breaker. While the
   *  breaker is open (`consecutiveFailures >= maxConsecutiveRecapFailures`),
   *  every Nth skipped summarizer opportunity lets ONE probe attempt
   *  through; a success closes the breaker and rolls the whole gap span, a
   *  failure re-opens it for another N skips. Without the probe an open
   *  breaker could never reset (reset only happens on a success the open
   *  breaker prevents), freezing the recap while the boundary keeps
   *  advancing — silent, progressive amnesia. */
  readonly breakerProbeEveryNSkips: number;
  /** Ceiling on the raw-turns input handed to the summarizer in ONE call
   *  (estimator units). Guards the re-derive scaling wall (spec §4): a
   *  re-derive feeds the whole compacted span, which grows without bound —
   *  past the summarizer's own window it can only fail, and those failures
   *  would trip the circuit breaker and freeze rolls that still work. Over
   *  this budget a re-derive downgrades to a roll (prior recap as backstory),
   *  and any aged span is tail-truncated to fit (elided head noted). Sized
   *  well under the 1M router window to leave room for system prompt +
   *  guide + prior recap + output. */
  readonly maxSummarizerInputTokens: number;
}

// The five levels deliberately make the 1M-token actor window a user choice.
// `bufferFraction` remains the internal representation because the recap
// boundary code is expressed in free-window space; the exported threshold is
// what the GUI labels and what users reason about.
const COMPACTION_LEVELS: Readonly<
  Record<
    CompactionLevel,
    { thresholdTokens: number; maxSummarizerInputTokens: number }
  >
> = {
  minimal: { thresholdTokens: 200_000, maxSummarizerInputTokens: 600_000 },
  low: { thresholdTokens: 400_000, maxSummarizerInputTokens: 600_000 },
  standard: { thresholdTokens: 600_000, maxSummarizerInputTokens: 600_000 },
  balanced: { thresholdTokens: 700_000, maxSummarizerInputTokens: 690_000 },
  max: { thresholdTokens: 872_000, maxSummarizerInputTokens: 800_000 },
};

const BASE_COMPACTION_CONFIG: Omit<
  CompactionConfig,
  "bufferFraction" | "maxSummarizerInputTokens"
> = {
  enabled: true,
  contextWindowTokens: 1_000_000,
  recentWindowTokens: 60_000, // ~60K recent kept verbatim
  minRecentTurns: 4,
  maxRecentWindowTokens: 100_000, // hard cap on the verbatim tail
  maxRecapChars: 6_000, // recap of the summarized older span
  maxBioChars: 1_000, // HertaBio head excerpt (序 + the self-intro line) as a voice anchor
  rederiveEveryNAdvances: 6,
  maxConsecutiveRecapFailures: 3,
  breakerProbeEveryNSkips: 3,
};

/** Return a concrete recap configuration for one of the five UI levels. */
export function compactionConfigForLevel(
  level: CompactionLevel = DEFAULT_COMPACTION_LEVEL,
): CompactionConfig {
  const strategy = COMPACTION_LEVELS[level];
  return {
    ...BASE_COMPACTION_CONFIG,
    bufferFraction:
      1 - strategy.thresholdTokens / BASE_COMPACTION_CONFIG.contextWindowTokens,
    maxSummarizerInputTokens: strategy.maxSummarizerInputTokens,
  };
}

/** The standard 600K strategy is the backwards-compatible application default. */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig =
  compactionConfigForLevel(DEFAULT_COMPACTION_LEVEL);

export function compactThreshold(cfg: CompactionConfig): number {
  // Decimal free-space fractions (for example 0.8) can turn an exact 200K
  // threshold into 199999.99999999997 in IEEE-754; strategy thresholds are
  // contractual integers, so round to the nearest token rather than flooring.
  return Math.round(cfg.contextWindowTokens * (1 - cfg.bufferFraction));
}

// Promoted to @herta/core (ADR 0025 slice 2) so the backend's context
// budget shares the same arithmetic; re-exported here so every existing
// recap-side importer keeps working unchanged.
export { estimatePromptTokens };

function blockText(b: TerminalRecordBlock): string {
  if (b.kind === "user") return b.text;
  if (b.kind === "herta") return b.text;
  return b.body + (b.evidenceDetail ?? "");
}

/** Estimated tokens of the raw blocks in `[start, end)`. Raw text (no
 *  thought-filter / diff-compression), so it slightly over-counts vs the
 *  prompt view — the conservative direction for every consumer. */
export function recordSpanTokens(
  record: TerminalRecord,
  start: number,
  end: number,
): number {
  let t = 0;
  for (let i = start; i < end; i++) {
    const b = record[i];
    if (b !== undefined) t += estimatePromptTokens(blockText(b));
  }
  return t;
}

/** Keep the NEWEST blocks that fit `budget` estimator-tokens (always at least
 *  the last block, so the result is non-empty for non-empty input). Bounds the
 *  summarizer's raw-turns input deterministically; `droppedBlocks` is how many
 *  head blocks were elided (the caller notes the elision in the payload). */
export function tailWithinTokenBudget(
  blocks: readonly TerminalRecordBlock[],
  budget: number,
): { blocks: TerminalRecordBlock[]; droppedBlocks: number } {
  let tokens = 0;
  let start = blocks.length;
  while (start > 0) {
    const b = blocks[start - 1];
    const t = b === undefined ? 0 : estimatePromptTokens(blockText(b));
    if (start < blocks.length && tokens + t > budget) break;
    tokens += t;
    start--;
  }
  return { blocks: blocks.slice(start), droppedBlocks: start };
}

export function selectBoundary(
  record: TerminalRecord,
  cfg: CompactionConfig,
): number {
  const userIdx: number[] = [];
  record.forEach((b, i) => {
    if (b.kind === "user") userIdx.push(i);
  });
  if (userIdx.length === 0) return 0;

  let tokens = 0;
  let kept = 0;
  let boundary = userIdx[0] ?? 0;
  for (let k = userIdx.length - 1; k >= 0; k--) {
    const start = userIdx[k] ?? 0;
    const end =
      k + 1 < userIdx.length
        ? (userIdx[k + 1] ?? record.length)
        : record.length;
    const turnTokens = recordSpanTokens(record, start, end);
    // Floor of 1 kept turn even when minRecentTurns is 0: the boundary must
    // point at a user block, so the smallest meaningful verbatim tail is the
    // single newest turn. Without the floor, a newest turn that alone exceeds
    // maxRecentWindowTokens breaks on the FIRST iteration with kept=0, leaving
    // boundary at its seed → returns 0 (give up) even as the head grows —
    // a non-monotonicity the recap roll path assumes away (recap-boundary
    // fuzz L3, 2026-07-09). Keeping ≥1 turn advances the boundary instead.
    if (
      kept >= Math.max(1, cfg.minRecentTurns) &&
      tokens + turnTokens > cfg.maxRecentWindowTokens
    )
      break;
    tokens += turnTokens;
    kept += 1;
    boundary = start;
    if (kept >= cfg.minRecentTurns && tokens >= cfg.recentWindowTokens) break;
  }
  return boundary <= (userIdx[0] ?? 0) ? 0 : boundary;
}

export interface RecapCache {
  readonly boundaryIndex: number;
  readonly recapText: string;
  /** Interaction language the recap prose was authored in. A cache whose
   *  lang differs from the session's is discarded on read (one re-derive) —
   *  replaying a zh recap into an en session (or vice versa) would splice
   *  wrong-language "memory" into every prompt. Replaces the old `model`
   *  field, which was written but never read (both bootstraps passed the
   *  constant "router", so the implied staleness check was a no-op — a
   *  false promise better deleted than kept). Legacy sidecars without the
   *  field read as "zh": every pre-lang cache was written by a zh session. */
  readonly lang: PromptLang;
  readonly advancesSinceRederive: number;
}

export type RecapAction =
  | { kind: "reuse" }
  | { kind: "roll"; agedFrom: number; agedTo: number }
  | { kind: "rederive"; upTo: number };

export function decideRecap(
  cache: RecapCache | null,
  newBoundary: number,
  forced: boolean,
  cfg: CompactionConfig,
): RecapAction {
  if (cache === null) return { kind: "rederive", upTo: newBoundary };
  if (forced) return { kind: "rederive", upTo: newBoundary };
  if (newBoundary === cache.boundaryIndex) return { kind: "reuse" };
  if (cache.advancesSinceRederive >= cfg.rederiveEveryNAdvances) {
    return { kind: "rederive", upTo: newBoundary };
  }
  return { kind: "roll", agedFrom: cache.boundaryIndex, agedTo: newBoundary };
}
