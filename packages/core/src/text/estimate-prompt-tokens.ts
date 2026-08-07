/**
 * CJK-aware prompt-token estimator. Every non-ASCII codepoint counts
 * ~1 token/char; ASCII runs count ÷4. Promoted from the actor's recap
 * subsystem (session-recap.ts, L4 non-ASCII floor fix) to core for
 * ADR 0025 slice 2 so the backend's context budget uses the same
 * arithmetic as the actor's compaction thresholds.
 *
 * History of the calibration (from the recap fix): originally only the
 * BMP CJK ranges got the 1-token treatment, and Hangul/Cyrillic/Arabic/
 * emoji/CJK-Ext-B fell into the ÷4 ASCII run — an up-to-4× UNDERcount,
 * the dangerous direction for a threshold that decides when trimming
 * must engage (the real prompt could blow past the model window while
 * the estimate still read under high-water). Charging every non-ASCII
 * codepoint 1 is slightly conservative for scripts DeepSeek tokenizes
 * multi-char (Latin-adjacent diacritics) and slightly generous for
 * scripts at >1 token/char (some emoji, Ext-B) — but the error is
 * bounded and mostly in the safe direction.
 */
export function estimatePromptTokens(text: string): number {
  let tokens = 0;
  let asciiRun = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0x7f) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
      tokens += 1;
    } else {
      asciiRun += 1;
    }
  }
  return tokens + Math.ceil(asciiRun / 4);
}
