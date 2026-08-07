import { type MutableRefObject, useEffect, useMemo, useRef } from "react";
import { useActiveSession } from "../../hooks/useActiveSession.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { useRevealedText } from "../Workspace/useRevealedText.js";
import { scanSpeakable } from "./speakable-text.js";
import type { Kicks } from "./wave-engine.js";

/** Sentence-ending punctuation → a long breath (the sink also pauses). */
const HARD_PUNCT = new Set(["。", "！", "？", "…", "—"]);
/** Clause punctuation → a short breath. */
const SOFT_PUNCT = new Set(["，", "、", "；", "：", ",", ";", ":"]);
/** EN sentence enders → a long breath, but ONLY in an EN session — ASCII "."
 *  is far too common in zh prose (paths, versions: "src/main.ts", "0.2") to
 *  treat as a sentence break globally, so this is lang-gated. It mirrors the
 *  sink's EN_SENTENCE_PUNCT breath so the wave settles where the text pauses.
 *  (Clause marks , ; : already live in SOFT_PUNCT, so they work in both.) */
const EN_HARD_PUNCT = new Set([".", "!", "?"]);

export interface SpeechKicksSource {
  /** Return kicks accumulated since the last drain and reset. Called by
   *  the canvas loop once per frame. */
  drainKicks(): Kicks;
}

/**
 * Converts Herta's speech into per-character kick events for the wave
 * engine. Watches the REVEALED text (its own `useRevealedText` instance —
 * same pacing rule as the bubble, so the wave breathes with the visible
 * typewriter) plus `retryText` growth during a veto retract (the paced
 * replay buffers there; the shrink itself contributes no kicks, so a veto
 * reads as the wave quieting). Renderer-local only (SPEC v0.3 §9.3 / D7);
 * the future audio analyser (SPEC §6.2) feeds the same Kicks shape.
 *
 * No timers of its own: growth is accumulated on render (driven by store
 * updates and the reveal's rAF) and drained by AuraVisual's single loop.
 */
export function useSpeechEnvelope(): SpeechKicksSource {
  const { streamingText, retryText, lang } = useActiveSession();
  const reduced = useReducedMotion();
  // Same pacing rule (and language) as the bubble, so the wave breathes with
  // the visible reveal — an EN word-stream must not char-crawl here while the
  // bubble pops words.
  const revealed = useRevealedText(streamingText, reduced, lang);

  const pending = useRef<{ count: number; punctuation: Kicks["punctuation"] }>({
    count: 0,
    punctuation: null,
  });
  const prevRevealedCount = useRef(0);
  const prevRetryCount = useRef(0);

  // Accumulate SPEAKABLE growth on every render — cheap (two short scans)
  // and correct regardless of which state update triggered the render.
  // Code blocks / table rows contribute no kicks (scanSpeakable): the wave
  // rests while Herta "pastes" rather than speaks.
  useEffect(() => {
    const watch = (
      text: string | null,
      prev: MutableRefObject<number>,
    ): void => {
      const scan = scanSpeakable(text ?? "");
      const grown = scan.count - prev.current;
      if (grown > 0) {
        pending.current.count += grown;
        const last = scan.last ?? "";
        if (HARD_PUNCT.has(last) || (lang === "en" && EN_HARD_PUNCT.has(last)))
          pending.current.punctuation = "hard";
        else if (SOFT_PUNCT.has(last)) pending.current.punctuation = "soft";
      }
      // Shrinks / resets / partial-fence reclassification just rebase the
      // counter — never negative kicks.
      prev.current = scan.count;
    };
    watch(revealed, prevRevealedCount);
    watch(retryText, prevRetryCount);
  });

  return useMemo(
    () => ({
      drainKicks: (): Kicks => {
        const k: Kicks = {
          count: pending.current.count,
          punctuation: pending.current.punctuation,
        };
        pending.current.count = 0;
        pending.current.punctuation = null;
        return k;
      },
    }),
    [],
  );
}
