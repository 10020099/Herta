import { stripDisplayUnsafe } from "@herta/core";
import {
  BRANCH_OPEN_TAG,
  STOP_SPEECH_CLOSE,
  STOP_THOUGHT_CLOSE,
} from "./thought-hint.js";

/**
 * Gate for 废案/记录 bodies loaded off disk into the static prefix (audit BL3).
 *
 * These files come from the workspace's `.herta` narrative dir — written by
 * the Dream system, but also an ordinary directory in whatever repo the user
 * pointed Herta at. They were previously filtered only by a leading-token
 * test on the FILENAME and then concatenated verbatim into the head of every
 * completion, AND interpolated into `renderFeianGrounding`, which tells the
 * supervisor those fragments are 【有出处】 — sourced. So a file dropped into a
 * cloned repo could forge narrative context and widen the supervisor's gate.
 *
 * The ceiling is low: the actor holds an empty tool registry, so nothing here
 * reaches a tool call, and D4 is intact — no persona text decides whether an
 * action is allowed. But "forged context that counts as sourced" is worth
 * closing on its own.
 *
 * The check lives here rather than reusing `validateFeian` because
 * `validateFeian` is in `@herta/knowledge`, which DEPENDS on `@herta/herta` —
 * importing it back would close a package cycle (see CLAUDE.md). What matters
 * at this boundary is structural anyway: the full generation-time validator
 * enforces authoring quality on text a model just produced, while this asks
 * only whether a body can escape the block it is being pasted into.
 */

/** Fences the completion grammar uses to delimit turns. A few-shot body that
 *  contains one can close the block it sits in and start speaking as if it
 *  were record — the prefix is a raw string handed to a completion endpoint,
 *  so there is no structural layer to stop it. */
const STRUCTURAL_TOKENS: readonly string[] = [
  BRANCH_OPEN_TAG,
  STOP_SPEECH_CLOSE,
  STOP_THOUGHT_CLOSE,
  // Record-projection labels. `→ 差分协处理器` is the canonical backend label
  // (D7); a body carrying one would read as a backend result Herta can cite.
  "→ 系统",
  "→ 差分协处理器",
];

/** Length past which a single few-shot stops being a few-shot. The real bound
 *  is the prompt budget: the static prefix is cache-stable and paid for on
 *  every single completion, so one oversized file is a permanent tax. */
const MAX_BODY_CHARS = 8000;

export interface FewShotCheck {
  readonly ok: boolean;
  /** Why it was dropped — logged, never shown to the user. */
  readonly reason?: string;
  /** The sanitized body. Only meaningful when `ok`. */
  readonly body: string;
}

/**
 * Sanitize and structurally validate one disk-loaded few-shot body.
 *
 * `stripDisplayUnsafe` runs FIRST and its output is what gets checked, so a
 * marker smuggled through a zero-width or bidi character cannot slip past the
 * token scan and then reassemble in the prompt.
 */
export function checkFewShot(name: string, raw: string): FewShotCheck {
  const body = stripDisplayUnsafe(raw);

  if (body.trim().length === 0) {
    return { ok: false, reason: "empty", body };
  }
  if (body.length > MAX_BODY_CHARS) {
    return {
      ok: false,
      reason: `too long (${body.length} > ${MAX_BODY_CHARS} chars)`,
      body,
    };
  }
  for (const token of STRUCTURAL_TOKENS) {
    if (body.includes(token)) {
      return { ok: false, reason: `structural token in body: ${token}`, body };
    }
  }
  // The filename filter that used to be the whole gate. Repeated against the
  // CONTENT: a file may be named `### 废案_03：…` and contain anything at all,
  // and the header is what makes the body legible as one of Herta's own
  // discarded drafts rather than free-floating text.
  const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  if (!/^###\s*(废案|记录)/.test(firstLine.trim())) {
    return {
      ok: false,
      reason: `body has no 废案/记录 header (${name})`,
      body,
    };
  }
  return { ok: true, body };
}
