import type {
  SystemBlock,
  SystemBlockDigest,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
import { COMPACTION_TEXT } from "./compaction-text.js";
import type { PromptLang } from "./prompt-lang.js";

/**
 * Render a single system block into one digest line per the
 * template table in spec §4.1. Returns null when the block hits
 * a skip rule (Planning / patch.preview).
 *
 * Used by `buildCompactionBody` to produce the per-line content
 * of a compacted `→ 系统  [历史已压缩 · 板砖]` summary. Exported for
 * unit testability.
 *
 * `lang` reaches only the handful of lines that are harness prose
 * (the no-output marker, the excerpt's elision note) — see
 * `compaction-text.ts` for why those localize and the operation verbs
 * around them do not. Defaults to `zh`.
 *
 * Two-tier (M-projection-3, 2026-07-04): blocks written since the
 * structured `digest` field exists render from that data; the legacy
 * body-regex path below survives ONLY for records persisted before it
 * (and for bridge-built marker blocks, which carry `role` instead).
 * The regexes had already rotted twice against reworded bodies —
 * summarizeInput's human-form args broke the `{"path":…}` patterns,
 * and the tests line moved label + format — degrading silently to the
 * 60-char fallback; the structured field ends that failure mode for
 * all new records.
 *
 * See docs/superpowers/specs/2026-05-24-narrative-compaction-design.md §4.1.
 */
export function digestSystemBlock(
  block: SystemBlock,
  lang: PromptLang = "zh",
): string | null {
  if (block.digest !== undefined)
    return renderStructuredDigest(block.digest, lang);
  const body = block.body;

  if (block.label === "差分协处理器") {
    // Reading {"path":"X", ...}
    const readMatch = body.match(/^Reading\s+\{[^}]*"path"\s*:\s*"([^"]+)"/);
    if (readMatch !== null) return `Reading ${readMatch[1]}`;

    // Writing {"path":"X", ...}
    const writeMatch = body.match(/^Writing\s+\{[^}]*"path"\s*:\s*"([^"]+)"/);
    if (writeMatch !== null) return `Writing ${writeMatch[1]}`;

    // Running {"argv":["a","b","c", ...]}
    const runMatch = body.match(/^Running\s+\{[^}]*"argv"\s*:\s*\[([^\]]+)\]/);
    if (runMatch !== null) {
      const argv = (runMatch[1] ?? "")
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .join(" ");
      return `Running \`${argv}\``;
    }

    // Planning — skip per spec §4.1
    if (body.startsWith("Planning")) return null;

    // B1 no-op marker — role:"noop-marker" (body-prefix fallback for
    // pre-role persisted records).
    if (block.role === "noop-marker" || body.startsWith("无产出")) {
      return COMPACTION_TEXT[lang].noOutput;
    }

    // Fallback — first non-empty line, truncated to 60 chars.
    return fallbackDigest(body);
  }

  if (block.label === "系统") {
    // patch preview — skip per spec §4.1 (Writing covers it)
    if (body.startsWith("patch preview")) return null;

    // ↳ tests: N passed, M failed
    const testsMatch = body.match(
      /↳\s+tests:\s*(\d+)\s+passed,\s*(\d+)\s+failed/,
    );
    if (testsMatch !== null) {
      const passed = Number.parseInt(testsMatch[1] ?? "0", 10);
      const failed = Number.parseInt(testsMatch[2] ?? "0", 10);
      if (failed === 0) return `Tests: ${passed}/${passed} passed`;
      return `Tests: ${passed} passed, ${failed} failed`;
    }

    // ↳ <tool> failed: <code>: <message>
    const failMatch = body.match(/↳\s+(\w+)\s+failed:\s*(\w+):/);
    if (failMatch !== null) {
      return `${failMatch[1]} failed (${failMatch[2]})`;
    }

    return fallbackDigest(body);
  }

  return null;
}

function fallbackDigest(body: string): string {
  const firstNonEmpty =
    body.split("\n").find((line) => line.trim().length > 0) ?? "";
  // Mark the cut. This was a silent mid-word truncation: a 200-char body
  // arrived in the prompt as its first 60 characters with nothing to say
  // the sentence had been amputated, which reads as a complete (and
  // sometimes reversed) statement. `…` is language-neutral, so no prose
  // table needed, and the ellipsis takes the 60th slot rather than adding
  // a 61st so the digest's length budget is unchanged.
  if (firstNonEmpty.length <= 60) return firstNonEmpty;
  return `${firstNonEmpty.slice(0, 59)}…`;
}

/**
 * Render a digest line from the structured field (spec §4.1 template
 * table, data-driven). Mirrors the legacy body-regex renderings where
 * they were still reachable; the tests line renders from status +
 * summary because `TestRunSummary` carries no pass/fail counts (the
 * legacy "N passed, M failed" pattern never matched real projected
 * bodies — detectTestRun's summary is "exit 0, 3.21s").
 */
function renderStructuredDigest(
  d: SystemBlockDigest,
  lang: PromptLang,
): string | null {
  switch (d.kind) {
    case "op": {
      if (d.verb === "Planning") return null; // skip per spec §4.1
      if (d.verb === "Running") return `Running \`${d.arg}\``;
      return `${d.verb} ${d.arg}`.trim();
    }
    case "tests":
      return d.status === "passed"
        ? `Tests passed (${d.summary})`
        : `Tests ${d.status} (${d.summary})`;
    case "tool-fail":
      return `${d.tool} failed (${d.code})`;
    case "skip":
      return null;
    case "bg":
      // One line per lifecycle row; the consecutive-state suppression in the
      // bridge already keeps these sparse.
      return `background ${d.id}: ${d.state}`;
    case "todo":
      // The plan layout AND the "todo k/n" progress rows are working state,
      // not operations — same skip rationale as the Planning op rows they
      // replaced (spec §4.1).
      return null;
    case "excerpt":
      // The CITATION survives compaction, the excerpt does not (ADR 0027):
      // the content rode `evidenceDetail`, which this summary never carries,
      // so a later turn keeps knowing she was shown that span without
      // re-paying its tokens every turn thereafter.
      //
      // The elision is stated, not left implicit. Every other bullet here
      // digests a block that never had a body to lose — `Reading foo.ts` is
      // the WHOLE of what that block ever said. This one is the exception:
      // Herta really did read those lines last turn, and a bare citation
      // formatted exactly like its neighbours invites her to keep quoting
      // from a span that is no longer in front of her — the same
      // fabricated-receipt failure supervisor rule 9 exists to catch, except
      // sourced from the harness rather than from her. Saying `正文已略去`
      // costs four characters and makes "I was shown this" and "I can still
      // read this" two distinguishable states.
      return `Excerpt ${d.path}:${d.from}-${d.to} · ${COMPACTION_TEXT[lang].excerptElided}`;
    case "text":
      return fallbackDigest(d.text);
  }
}

/**
 * Build the compaction summary body from a list of source system
 * blocks. Applies the template table via `digestSystemBlock`, drops
 * entries that hit a skip rule (Planning / patch.preview), runs the
 * consecutive-same-verb coalesce (`Reading a` + `Reading b` →
 * `Reading a, b`), and assembles the result with the
 * `[历史已压缩 · 板砖]` header.
 *
 * Returns the empty string when every input block hit a skip rule —
 * the caller (`compactRecordForPrompt`) treats this as "no
 * compaction possible" and passes the original run through verbatim
 * rather than emitting a meaningless header with no bullets.
 *
 * See docs/superpowers/specs/2026-05-24-narrative-compaction-design.md §4.3 / §4.4.
 */
export function buildCompactionBody(
  blocks: readonly SystemBlock[],
  lang: PromptLang = "zh",
): string {
  // 1. Map blocks through the template; drop skipped entries.
  const lines: string[] = [];
  for (const block of blocks) {
    const digest = digestSystemBlock(block, lang);
    if (digest !== null) lines.push(digest);
  }
  if (lines.length === 0) return "";

  // 2. Consecutive-same-verb coalesce. Only Reading and Writing
  //    coalesce (those are the verbs that commonly run in batches);
  //    Running / Tests / failed entries stay one-per-bullet.
  const coalesced: string[] = [];
  for (const line of lines) {
    const verb = matchCoalesceVerb(line);
    const last = coalesced[coalesced.length - 1];
    if (verb !== null && last !== undefined) {
      const lastVerb = matchCoalesceVerb(last);
      if (lastVerb !== null && lastVerb.verb === verb.verb) {
        coalesced[coalesced.length - 1] =
          `${lastVerb.verb} ${lastVerb.rest}, ${verb.rest}`;
        continue;
      }
    }
    coalesced.push(line);
  }

  // 3. Assemble with header.
  const header = COMPACTION_TEXT[lang].header;
  const bullets = coalesced.map((l) => `- ${l}`).join("\n");
  return `${header}\n${bullets}`;
}

function matchCoalesceVerb(
  line: string,
): { verb: "Reading" | "Writing"; rest: string } | null {
  const m = line.match(/^(Reading|Writing)\s+(.+)$/);
  if (m === null) return null;
  const verb = m[1] as "Reading" | "Writing";
  const rest = m[2] ?? "";
  return { verb, rest };
}

/**
 * Options for `compactRecordForPrompt`.
 *
 * `minRunSize` — minimum contiguous system blocks required to
 * trigger compaction. Runs shorter than this pass through verbatim.
 * Default 2 (collapses any pair of adjacent system blocks).
 *
 * `lang` — session interaction language, selecting the harness prose in
 * `compaction-text.ts` (header, no-output marker, excerpt elision note).
 * Default `zh`; the operation verbs are canonical and never localize.
 */
export interface CompactOptions {
  readonly minRunSize?: number;
  readonly lang?: PromptLang;
}

/**
 * Walks the record and replaces each run of ≥`minRunSize` contiguous
 * system blocks with one synthetic compaction summary block. Pure,
 * deterministic, does not mutate the input.
 *
 * Compaction is asymmetric: main turns / supervisor / router opt in
 * (default behavior); in-turn beats opt out via the serializer's
 * `compactBridgeOutput: false` option so the beat sees the full
 * board output of the invocation that just fired it.
 *
 * Per-`@板砖`-invocation collapse is the design intent; this
 * function approximates it as per-contiguous-system-run collapse.
 * When an in-turn beat fires between system blocks of the same
 * invocation, the run splits — each pre-beat / post-beat run gets
 * its own summary, preserving the beat as a narrative anchor in
 * between (spec §3).
 *
 * See docs/superpowers/specs/2026-05-24-narrative-compaction-design.md §7.
 */
export function compactRecordForPrompt(
  record: TerminalRecord,
  opts?: CompactOptions,
): TerminalRecord {
  const minRunSize = opts?.minRunSize ?? 2;
  const lang = opts?.lang ?? "zh";

  // Done-marker two-state lifecycle: find the last done-marker; the verdict
  // is "spoken" if any herta block appears after it. In State 1 (verdict turn,
  // none after) the done-marker is passed through verbatim so its evidenceDetail
  // roll-up reaches Herta's prompt; in State 2 (verdict spoken) it folds into
  // the summary by body like any system block, dropping the redundant roll-up.
  //
  // Backward-walk-and-stop (arch audit 2026-07-15): the decision depends only
  // on the record TAIL, so walk backward from the end and stop at the first
  // herta block (some herta block then follows every done-marker → State 2,
  // no pass-through) or the first done-marker (it is the LAST one and no
  // herta block follows it → State 1, pass it through). Blocks before the
  // stop point provably cannot change the outcome; this replaces the previous
  // two full-record forward scans and yields the identical passThroughIdx —
  // the serialized projection is byte-for-byte unchanged (equivalence pinned
  // against a naive reference in serialize.test.ts).
  let passThroughIdx = -1;
  for (let k = record.length - 1; k >= 0; k--) {
    const b = record[k];
    if (b === undefined) continue;
    // Only SPEECH counts as "the verdict was spoken" (audit 2026-07-24,
    // 1.10). A bare `kind === "herta"` also matched a （我 想）— and on the
    // mood-routed path that is the NORMAL post-dispatch shape: committing the
    // @板砖 speech resets the consecutive-thought counter, so the next
    // iteration is forced back to thought, committing one AFTER the
    // done-marker. Current-turn thoughts survive the prompt filter while no
    // speech follows, so they reached here and flipped the marker into
    // State 2 — folding it into the compaction summary and dropping its
    // evidenceDetail. The prompt that lost `↳ 改动文件 / 风险 / 待办` was
    // therefore precisely the one generating Herta's SYNTHESIS speech: she
    // reported the run without naming which files changed or what was still
    // open, and ADR 0025's unfinished-todo inheritance was cut at that point.
    if (b.kind === "herta" && b.surface === "speech") break;
    if (b.kind === "system" && b.role === "done-marker") {
      passThroughIdx = k;
      break;
    }
  }

  const output: TerminalRecordBlock[] = [];
  let i = 0;
  while (i < record.length) {
    const current = record[i];
    if (current === undefined) {
      i += 1;
      continue;
    }
    if (current.kind === "system") {
      // Find the end of the contiguous system run.
      let j = i + 1;
      while (j < record.length && record[j]?.kind === "system") {
        j += 1;
      }
      // If the pass-through done-marker is inside this run, exclude it from
      // the compacted summary and emit it verbatim after.
      const hasPassThrough = passThroughIdx >= i && passThroughIdx < j;
      const compactEnd = hasPassThrough ? passThroughIdx : j;
      const runLength = compactEnd - i;

      if (runLength >= minRunSize) {
        const runBlocks = record.slice(i, compactEnd) as readonly SystemBlock[];
        const body = buildCompactionBody(runBlocks, lang);
        if (body.length > 0) {
          output.push({ kind: "system", label: "系统", body });
        } else {
          // All entries in the run hit a skip rule — pass them
          // through verbatim rather than emitting an empty-header
          // summary (spec §4.4).
          for (const b of runBlocks) output.push(b);
        }
      } else {
        // Run shorter than minRunSize — pass through verbatim.
        for (let k = i; k < compactEnd; k++) {
          const b = record[k];
          if (b !== undefined) output.push(b);
        }
      }
      // Emit the pass-through done-marker verbatim (State 1).
      if (hasPassThrough) {
        const dm = record[passThroughIdx];
        if (dm !== undefined) output.push(dm);
      }
      // Advance past what we just emitted. On a pass-through, resume right
      // AFTER the done-marker so the remaining system blocks in this run
      // (if any) are re-collapsed as their own run rather than dropped.
      i = hasPassThrough ? passThroughIdx + 1 : j;
    } else {
      output.push(current);
      i += 1;
    }
  }
  return output;
}
