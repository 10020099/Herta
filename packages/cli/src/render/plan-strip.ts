import type { SystemBlock, SystemBlockDigest, TodoStatus } from "@herta/core";
import type { PromptLang } from "@herta/herta";

/**
 * The CLI's rendering of a dispatch's 任务清单 (ADR 0025 todo list).
 *
 * This module is pure composition — what a plan line SAYS. The decision of
 * WHEN to print one lives in `NarrativeRenderer` (it needs cross-block state:
 * which dispatch we are in, whether the shape changed, whether a beat has
 * split the run since the last line).
 *
 * ── Why the CLI's strip is not the GUI's strip ──────────────────────────────
 * The GUI (`plan-context.ts` + `ActivityBlock.tsx`, 2026-07-26) repaints a
 * live checklist under the active group's status line: a fixed region, redrawn
 * from props on every frame, free to show the whole plan continuously.
 *
 * A terminal has no such region. Everything written is permanent scrollback,
 * so "repaint the checklist on every todo update" is not a strip, it is a
 * flood — an n-item plan updated n times would print n² rows. So the CLI
 * splits the same information in two by frequency:
 *
 *   - the CHECKLIST (`planChecklist`) prints when the plan's SHAPE changes —
 *     first projection of a dispatch, or a step added/dropped. That is the
 *     moment the reader's mental picture actually went stale.
 *   - the STEP LINE (`planStepLine`) prints on every other update, and again
 *     as a one-line re-anchor when a Herta beat has split the run — one line,
 *     the same wording, so a continuation never resumes with the plan
 *     invisible somewhere far up the scrollback.
 *
 * Display-only (D7), like `system-localize.ts`: the record keeps the canonical
 * English-chrome body 板砖 authored (`todo list (6):` / `todo 2/6: …`) — that
 * is what Herta's prompt, the JSONL transcript, and compaction read. Only the
 * TTY rendering localizes, and only on the SESSION language (ADR 0018).
 * Unlike `system-localize.ts` this one is not EN-only: the projected todo
 * chrome is English in BOTH languages, so a zh session localizes here too
 * (the GUI has localized it on its own side since 2026-07-23).
 */

/** The todo member of the system-block digest union (no name-import needed). */
export type TodoDigest = Extract<SystemBlockDigest, { kind: "todo" }>;

/** The todo digest of a system block, or null for every other block. */
export function todoDigestOf(block: SystemBlock): TodoDigest | null {
  const digest = block.digest;
  return digest?.kind === "todo" ? digest : null;
}

interface PlanWords {
  /** The plan noun — heads the checklist, and the countless step line. */
  readonly list: string;
  /** The step noun — heads "步骤 3/6 · <item>". */
  readonly step: string;
  /** Tail row for items past the row cap. */
  readonly more: (n: number) => string;
}

/**
 * Session-language wording. Deliberately the SAME strings the GUI uses
 * (`activity.todo.list` / `activity.todo.step` / `activity.plan.more`), so the
 * two frontends name the same thing the same way.
 */
const PLAN_WORDS: Record<PromptLang, PlanWords> = {
  zh: { list: "任务清单", step: "步骤", more: (n) => `还有 ${n} 项` },
  en: { list: "todo list", step: "Step", more: (n) => `+${n} more` },
};

/**
 * Per-status row marks. A `Record` over the backend's own `TodoStatus`, so a
 * new backend status is a compile error here rather than a row that silently
 * renders as pending.
 *
 * All three are East-Asian-AMBIGUOUS width, i.e. one column on a terminal
 * configured ambiguous-narrow (the assumption the retract math already makes —
 * see `charWidth` in narrative-renderer.ts). Nothing here feeds retract math
 * anyway: system-block bodies are never streamed or erased.
 */
const MARK: Record<TodoStatus, string> = {
  completed: "✓",
  in_progress: "▸",
  pending: "·",
};

/**
 * Checklist rows printed before the `…` tail.
 *
 * Higher than the GUI's 8 on purpose. The GUI caps to protect a fixed strip
 * competing with the conversation for viewport; a terminal just scrolls, and
 * the checklist prints only on a shape change — so capping at the GUI's number
 * would DROP items the CLI shows in full today (the projected layout body is
 * unbounded) for no gain. This cap exists only so a pathological 200-item plan
 * cannot own the screen.
 */
export const PLAN_MAX_ROWS = 20;

/**
 * One item as one row. Item text is backend-authored and rendered verbatim
 * (D7) except for embedded newlines, which are folded to spaces: the strip's
 * contract is one row per item, and a multi-line item would otherwise emit
 * unmarked orphan rows that read like separate steps.
 */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * The compact form: `步骤 3/6 · 修 cursor reset`.
 *
 * The step number is `completed + 1` — the item being worked in a sequential
 * plan — clamped to `total` (identical to the GUI's live line). With nothing
 * in flight there is no honest step number, so the line falls back to the
 * counts alone: `任务清单 3/6`.
 *
 * `current` rides the progress rows only — the LAYOUT block deliberately omits
 * it, because its `[~]` mark already showed the in-flight item (backend-bridge
 * `buildTodoLayoutBlock`). That is fine for a body rendered in place and wrong
 * for a line restated later, so the in-flight item falls back to the one
 * `items` marks `in_progress`. Without it, a dispatch whose only projection so
 * far IS the layout would re-anchor as a bare count and name no step at all.
 */
export function planStepLine(digest: TodoDigest, lang: PromptLang): string {
  const words = PLAN_WORDS[lang];
  const current =
    digest.current ??
    digest.items?.find((item) => item.status === "in_progress")?.content;
  if (current === undefined) {
    return `${words.list} ${digest.completed}/${digest.total}`;
  }
  const step = Math.min(digest.completed + 1, digest.total);
  return `${words.step} ${step}/${digest.total} · ${oneLine(current)}`;
}

/**
 * The full form: a localized header plus one marked row per item.
 *
 *     任务清单 (1/3):
 *     ✓ 定位 bug
 *     ▸ 修 cursor reset
 *     · 加回归测试
 *
 * Composed from the digest's `items` — never by slicing the block's body —
 * because `todo_write` is full-list replacement (ADR 0025): the newest
 * projection's list is the only one that still describes the live plan, and a
 * progress row's one-line body carries no list at all.
 *
 * Returns null when `items` is absent: a record persisted before the field
 * existed (2026-07-26) has an UNKNOWN list, not an empty one, and the caller
 * must fall back rather than draw a plan with no steps in it.
 */
export function planChecklist(
  digest: TodoDigest,
  lang: PromptLang,
): string[] | null {
  const items = digest.items;
  if (items === undefined) return null;
  const words = PLAN_WORDS[lang];
  const rows = items
    .slice(0, PLAN_MAX_ROWS)
    .map((item) => `${MARK[item.status]} ${oneLine(item.content)}`);
  const hidden = items.length - rows.length;
  return [
    `${words.list} (${digest.completed}/${digest.total}):`,
    ...rows,
    ...(hidden > 0 ? [`… ${words.more(hidden)}`] : []),
  ];
}
