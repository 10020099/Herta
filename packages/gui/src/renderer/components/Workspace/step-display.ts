import type { MessageKey } from "../../i18n/keys.js";
import type { SystemBlock } from "./group-record.js";

/** Localized display verbs for projected op steps, keyed by the digest's
 *  harness-authored verb union. */
const VERB_KEY: Record<string, MessageKey> = {
  Reading: "activity.verb.reading",
  Writing: "activity.verb.writing",
  Running: "activity.verb.running",
  Planning: "activity.verb.planning",
  Inspecting: "activity.verb.inspecting",
  "Saving memory": "activity.verb.savingMemory",
};

/**
 * Display body for one activity step (2026-07-10: the projected chrome —
 * verbs, result labels — is always English regardless of locale). Every
 * branch localizes from the STRUCTURED digest — D7: display-only, the
 * canonical record body keeps its English chrome (that is what Herta's
 * prompt reads, and what icon parsing keys on). Anything without the
 * structured data — records persisted before the digest fields existed,
 * signal/timeout exits, patch previews without a skip digest — renders the
 * canonical body verbatim.
 */
export function stepDisplayBody(
  block: SystemBlock,
  t: (key: MessageKey) => string,
): string {
  const d = block.digest;
  if (d === undefined) return block.body;
  switch (d.kind) {
    case "op": {
      const key = VERB_KEY[d.verb];
      return key !== undefined ? `${t(key)} ${d.arg}`.trim() : block.body;
    }
    case "tests":
      // "↳ tests: 3 passed" → "↳ 测试: 3 passed" (summary is tool output —
      // data, not chrome).
      return `↳ ${t("activity.result.tests")}: ${d.summary}`;
    case "tool-fail":
      // Message rides the digest since 2026-07-10; without it (older
      // records) a digest-only render would DROP it — fall back to the body.
      return d.message !== undefined
        ? `↳ ${d.tool} ${t("activity.result.failed")}: ${d.code}: ${d.message}`
        : block.body;
    case "bg": {
      // "↳ background bg-1: running" → "↳ 后台 bg-1：运行中" etc. A null
      // exitCode on an exited row means signal/kill — never a literal null.
      const state =
        d.state === "running"
          ? t("activity.bg.running")
          : d.state === "stopped"
            ? t("activity.bg.stopped")
            : d.exitCode === null || d.exitCode === undefined
              ? `${t("activity.bg.exited")} (${t("activity.bg.signal")})`
              : `${t("activity.bg.exited")} (${d.exitCode})`;
      return `↳ ${t("activity.bg.label")} ${d.id}: ${state}`;
    }
    case "todo": {
      // Progress row ("todo k/n: <item>", 2026-07-23): which step 板砖 is
      // on — the in-flight item is #completed+1 of a sequential plan. The
      // item text is backend-authored content, verbatim.
      if (!block.body.startsWith("todo list")) {
        return d.current === undefined
          ? `${t("activity.todo.list")} ${d.completed}/${d.total}`
          : `${t("activity.todo.step")} ${Math.min(d.completed + 1, d.total)}/${d.total} · ${d.current}`;
      }
      // Full layout block: localize the header line; the item lines are
      // backend-authored task content and stay verbatim.
      const nl = block.body.indexOf("\n");
      const items = nl >= 0 ? block.body.slice(nl) : "";
      return `${t("activity.todo.list")} (${d.completed}/${d.total}):${items}`;
    }
    case "text":
      // Exit rows carry structured numbers since 2026-07-10; other text
      // digests (and signal/timeout exits) fall back to the body.
      return d.exitCode !== undefined &&
        d.exitCode !== null &&
        d.lineCount !== undefined
        ? `↳ ${t("activity.result.exit")} ${d.exitCode} · ${d.lineCount} ${t(
            "activity.result.lines",
          )}`
        : block.body;
    case "attachment": {
      // Composed wholly from the digest, so the canonical CN body is never
      // parsed (ADR 0018's pattern). The FILENAME stays verbatim in every
      // language — it is the user's own data, not chrome.
      const label = t("activity.attachment.label");
      if (d.unreadable !== undefined) {
        const why =
          d.unreadable === "binary"
            ? t("activity.attachment.unreadable.binary")
            : d.unreadable === "too_large"
              ? t("activity.attachment.unreadable.tooLarge")
              : d.unreadable === "empty"
                ? t("activity.attachment.unreadable.empty")
                : d.unreadable === "denied"
                  ? t("activity.attachment.unreadable.denied")
                  : d.unreadable === "removed"
                    ? t("activity.attachment.unreadable.removed")
                    : t("activity.attachment.unreadable.readError");
        return `${label} ${d.name} · ${why}`;
      }
      const lines = `${d.lines.toLocaleString()} ${t("activity.result.lines")}`;
      const chars = `${d.chars.toLocaleString()} ${t("activity.attachment.chars")}`;
      return `${label} ${d.name} · ${lines} · ${chars}`;
    }
    case "skip":
      // The patch-preview block (the only skip-digest producer): localize
      // its first-line label, keep the files + diff fence verbatim (the
      // collapsible diff body must stay untouched).
      if (block.body.startsWith("patch preview:")) {
        return `${t("activity.step.patchPreview")}:${block.body.slice(
          "patch preview:".length,
        )}`;
      }
      return block.body;
    default:
      return block.body;
  }
}

/**
 * Display text for a block's evidence detail — the pane behind 展开明细 /
 * "show detail".
 *
 * Composed from the STRUCTURED `evidence` sections, for the same reason every
 * other row localizes from its digest: the canonical `evidenceDetail` string
 * is the record, it is what Herta's prompt reads, and per ADR 0018 it stays
 * Chinese in every language — so an English session used to open this pane on
 * `↳ 输出:` / `↳ 摘录` / `↳ 改动文件:`. Only the section LABEL is translated;
 * command output, excerpt bodies, paths, risks and todos are backend-authored
 * data and stay verbatim.
 *
 * Falls back to the canonical string for records persisted before `evidence`
 * existed (and for any block that carries a detail but no sections).
 */
export function stepDisplayDetail(
  block: SystemBlock,
  t: (key: MessageKey) => string,
): string | undefined {
  const sections = block.evidence;
  if (sections === undefined || sections.length === 0) {
    return block.evidenceDetail;
  }
  return sections
    .map((s) => {
      switch (s.kind) {
        case "output":
          return `↳ ${t("evidence.output")}:\n${s.text}`;
        case "excerpt":
          return `↳ ${t("evidence.excerpt")} ${s.path}:${s.from}-${s.to}\n${s.text}`;
        case "files":
          return `↳ ${t("evidence.files")}: ${s.paths.join(", ")}`;
        case "risks":
          return `↳ ${t("evidence.risks")}: ${s.items.join("; ")}`;
        case "todos":
          return `↳ ${t("evidence.todos")}: ${s.items.join("; ")}`;
        case "attachment": {
          // The clipped note is part of the evidence, not decoration: without
          // it a head excerpt reads as the entire document, to the user and
          // to anyone reading this pane over their shoulder.
          const note = s.clipped ? `\n${t("evidence.attachment.clipped")}` : "";
          return `↳ ${t("evidence.attachment")} ${s.name}\n${s.text}${note}`;
        }
        case "error":
          return `↳ ${t("evidence.error")}: ${s.message}`;
        default:
          // A section kind this renderer predates: fall back rather than drop
          // evidence on the floor.
          return block.evidenceDetail ?? "";
      }
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * The latest OPERATION step for the live status line (bug 3, 2026-07-10):
 * result rows ("↳ exit 1 · 0 lines", "↳ tests: …") read as a weird "current
 * activity" while the backend works — the op that produced them stays the
 * honest in-flight label until the next op starts. Result rows still show in
 * the expanded history. Falls back to the last step of any kind (a run whose
 * only rows so far are results), then undefined for an empty list.
 */
export function latestOpStep(
  steps: readonly SystemBlock[],
): SystemBlock | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const b = steps[i];
    if (b === undefined) continue;
    // Todo rows (2026-07-23): a progress row (has `current`) IS the live
    // state — headline it. The multiline layout block and currentless
    // progress rows are not a readable one-liner — skip to an older row.
    if (b.digest?.kind === "todo") {
      if (b.digest.current !== undefined) return b;
      continue;
    }
    // Failures are headline-eligible (2026-07-23): a tool_crashed / failed
    // row IS the current state of the run — hiding it behind the last op
    // made crashes invisible until the history was expanded.
    if (
      b.digest?.kind === "op" ||
      b.digest?.kind === "tool-fail" ||
      !b.body.trimStart().startsWith("↳")
    ) {
      return b;
    }
  }
  return steps[steps.length - 1];
}

/**
 * The newest todo-progress row (digest kind "todo" with `current`) — the
 * step-level context for the live activity line. Undefined when the
 * dispatch has no 任务清单 (or no update has flipped an item yet), in which
 * case the line keeps its op-only form.
 */
export function latestTodoProgressStep(
  steps: readonly SystemBlock[],
): SystemBlock | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const b = steps[i];
    if (b?.digest?.kind === "todo" && b.digest.current !== undefined) return b;
  }
  return undefined;
}
