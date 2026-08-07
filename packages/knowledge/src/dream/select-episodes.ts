import { dreamRelevantSystemBody } from "./digest.js";
import type { Episode } from "./types.js";

export interface SelectOptions {
  readonly minHertaBlocks: number;
  readonly minEpisodeChars: number;
}

export function selectEpisodes(
  episodes: readonly Episode[],
  opts: SelectOptions,
): Episode[] {
  return episodes.filter((e) => {
    if (!e.settled) return false;
    const hertaSpeech = e.blocks.filter(
      (b) => b.kind === "herta" && b.surface !== "thought",
    ).length;
    const hertaVoice = e.blocks.filter((b) => b.kind === "herta").length;
    if (hertaVoice < opts.minHertaBlocks || hertaSpeech < 1) return false;
    // Count only text the episode digest would actually contain — live-work
    // chrome (bg rows, todo layouts, patch-preview diffs) must not push a
    // thin episode over the floor (consumer audit 2026-07-23).
    const chars = e.blocks.reduce(
      (n, b) =>
        n +
        (b.kind === "system" ? (dreamRelevantSystemBody(b) ?? "") : b.text)
          .length,
      0,
    );
    return chars >= opts.minEpisodeChars;
    // NOTE: no @板砖 / edited-file / coding-outcome requirement — non-coding
    // episodes are first-class. The LLM worthiness gate (run-dream-pass) is
    // the real discriminator.
  });
}
