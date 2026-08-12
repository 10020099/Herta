/**
 * Deterministic "is this actually dialogue?" guard for committed speech.
 *
 * The supervisor is an LLM judge, so every path that skips it — the
 * veto respeak (§6.4, "commits the ladder's result unconditionally
 * without a second supervisor pass"), the same-state empty-speech
 * retry, a supervisor deadline/provider error fail-softing to OK, and
 * an install with `config.supervisor.enabled = false` — commits
 * whatever the model produced. A degenerate completion that emits the
 * TEMPLATE SLOT instead of filling it (`{需要说的话}`) therefore reaches
 * the user verbatim. That was a real report, 2026-08-12.
 *
 * This needs no model to recognise, so it runs at the commit boundary
 * and covers all four paths at zero latency and zero tokens.
 *
 * DELIBERATELY NARROW. It fires only when the WHOLE line is a slot
 * token, because the cost of a false positive is suppressing real
 * speech. Specifically it must NOT catch:
 *   - "把 `{}` 改成 `[]`" — she talks about code; braces INSIDE a
 *     sentence are ordinary content.
 *   - "……" — the 被烦版 silence reply is BY DESIGN (mood lab
 *     2026-07-17); a punctuation-only line is not this bug.
 *   - "（他没听懂。）" — a parenthetical-only line is narration, which
 *     is the supervisor's rule, not a template slot. Different defect,
 *     different owner.
 */

/** Zero-width and bidi characters that could otherwise smuggle a slot
 *  past the whole-string match. Same class the dream user-line gate
 *  normalises away. */
// Alternation rather than a character class: a class containing ZWJ can
// match a joined character sequence (biome noMisleadingCharacterClass).
const INVISIBLE_RE = /(?:\s|​|‌|‍|⁠|﻿)+/g;

/** Trailing sentence punctuation to ignore — a model that emits
 *  `{需要说的话}。` produced a slot, not a sentence. */
const TRAILING_PUNCT_RE = /[。．.、，,；;：:！!？?~～\-—]+$/;

/**
 * Whole-string template-slot shapes. Each requires that the delimiters
 * do not recur inside, so a long line that merely BEGINS with `{` and
 * ENDS with `}` is not swept up.
 */
const SLOT_RES: readonly RegExp[] = [
  /^\$?\{{1,2}[^{}]*\}{1,2}$/, // {x} {{x}} ${x}
  /^｛{1,2}[^｛｝]*｝{1,2}$/, // fullwidth braces
  /^<{1,2}[^<>]*>{1,2}$/, // <x> <<x>>
  /^\[{1,2}[^[\]]*\]{1,2}$/, // [x] [[x]]
  /^［{1,2}[^［］]*］{1,2}$/, // fullwidth brackets
  /^%[^%\s]+%$/, // %x%
];

/**
 * True when `text` is nothing but a template slot — the model emitting
 * the placeholder rather than filling it.
 *
 * An EMPTY slot (`{}`, `<>`) counts: it is equally not dialogue, and
 * treating it as usable would let `{}` through the same hole.
 */
export function isPlaceholderOnly(text: string): boolean {
  const bare = text.replace(INVISIBLE_RE, "").replace(TRAILING_PUNCT_RE, "");
  if (bare.length === 0) return false; // empty is the caller's other branch
  return SLOT_RES.some((re) => re.test(bare));
}

/**
 * The commit-boundary predicate: speech that must not reach the user.
 *
 * Folds emptiness and slot-only into ONE test so the existing recovery
 * machinery covers both. A slot-only completion is the same class of
 * failure as an empty one — the model produced no content — so it gets
 * the same treatment: the rising-temperature retry ladder, and if that
 * exhausts, the turn ends quietly rather than committing the garbage.
 */
export function isUnusableBlock(text: string): boolean {
  return text.trim().length === 0 || isPlaceholderOnly(text);
}

/**
 * WHY an attempt was rejected — which retry ladder should correct it.
 * Applies to BOTH surfaces: speech and thought fail the same two ways.
 *
 * The two failures need different accusations. The empty ladder says
 * "闭合得太快 / 不能空白", which is simply FALSE when the model emitted a
 * placeholder: it did not close early, it wrote something. Telling it the
 * wrong thing means the retry recovers by re-rolling rather than by
 * correcting, which is the same mistake the ADR 0036 refine loop avoids by
 * feeding each gate's actual finding back into the prompt.
 */
export type RetryCause = "empty" | "slot";

/** The cause, or `undefined` when the text is usable and no retry is due. */
export function retryCause(text: string): RetryCause | undefined {
  if (text.trim().length === 0) return "empty";
  if (isPlaceholderOnly(text)) return "slot";
  return undefined;
}
