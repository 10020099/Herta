import type { SystemBlock, TerminalRecordBlock } from "@herta/core";

/**
 * Which system blocks belong in a dream episode's evidence spine — and
 * which are live-work chrome that would only hand the worthiness gate
 * noise it then has to reject (consumer audit 2026-07-23).
 *
 * Skipped, by digest kind:
 *  - "bg"   — background-command lifecycle rows: transient run state,
 *             not an outcome.
 *  - "todo" — the plan layout block: working state (same rationale as
 *             the live compaction's Planning/todo skip).
 *  - "patch" / "skip" — patch previews, i.e. the FULL diff body. The
 *             Writing op row (with its `↳ +N −M`) and the done-marker
 *             already carry the outcome; a dream prompt has no use for a
 *             hundred-line diff. The projector has emitted `patch` since
 *             2026-08-25 and the skip list never learned it — every
 *             coding episode carried its diffs into every distillation
 *             call and past the 200-char floor (dream review 2026-09-22,
 *             finding 1). `skip` is the older kind; records persisted
 *             before the digest field existed are matched by body prefix.
 *
 * Everything else — op rows, test results, tool failures, markers,
 * plain text — returns its body verbatim: that is what actually
 * happened, which is exactly what the dream should ground in.
 *
 * Also used by `selectEpisodes` so the char-floor eligibility counts
 * only text the digest would actually contain.
 */
export function dreamRelevantSystemBody(b: SystemBlock): string | null {
  const kind = b.digest?.kind;
  if (kind === "bg" || kind === "todo" || kind === "skip" || kind === "patch") {
    return null;
  }
  if (b.digest === undefined && b.body.startsWith("patch preview")) return null;
  return b.body;
}

/** A path inside the harness's attachment store (ADR 0033), where every
 *  document the 开拓者 handed over is kept — relative or absolute, either
 *  separator. */
const ATTACHMENT_STORE = /\.herta[\\/]+attachments[\\/]/;

export function mentionsAttachmentStore(text: string): boolean {
  return ATTACHMENT_STORE.test(text);
}

/**
 * Whether a block's `evidenceDetail` belongs in the episode alongside its body.
 *
 * The body/evidence split is NOT the same question as the block-level skip
 * above: a block can be worth dreaming while its detail is not. Attachments
 * (ADR 0033) are the case that forced this apart. Their `evidenceDetail` holds
 * the head of a document the 开拓者 uploaded — the one payload in the record
 * that never came from the repo, the backend, or Herta — and dreams distil into
 * a first-person autobiography that persists across sessions. She should
 * remember being handed a spec; the spec's contents are not hers to keep.
 *
 * So the citation in `body` stays (that is what happened) and the detail is
 * dropped. Repo excerpts, search hits and command output are bounded work
 * evidence and have ridden into dreams since ADR 0027 — except where they
 * READ the attachment store (ADR 0069 §5): the fold's own hint sends Herta
 * back to the document through 板砖, and an excerpt of it, a search hit in
 * it or a `cat` of it carried the same text the attachment row withholds.
 * The rule is keyed on where the text came from, not on the row's kind.
 * `afterAttachmentCommand` says the command whose output this row carries
 * named the store — an output row does not carry its command.
 */
export function dreamRelevantEvidenceDetail(
  b: SystemBlock,
  afterAttachmentCommand = false,
): string | null {
  if (b.digest?.kind === "attachment") return null;
  // A document digest's overview (ADR 0043) is the same document's contents
  // one step removed — a model's précis of what the user handed over — and
  // no more hers to keep than the head excerpt is. The row stays: she
  // remembers having 板砖 digest the file.
  if (b.digest?.kind === "digest") return null;
  const detail = b.evidenceDetail ?? null;
  if (detail === null) return null;
  if (b.digest?.kind === "excerpt" && mentionsAttachmentStore(b.digest.path)) {
    return null;
  }
  if (b.digest?.kind === "search") {
    // Hit lines are `path:line: content`: drop the store's, keep the repo's.
    const lines = detail.split("\n");
    const kept = lines.filter((l) => !mentionsAttachmentStore(l));
    const hits = kept.filter(
      (l) => !l.startsWith("↳ 匹配") && !l.startsWith("（另有"),
    );
    return hits.length === 0 ? null : kept.join("\n");
  }
  if (afterAttachmentCommand && b.digest?.kind === "text") return null;
  return detail;
}

export function buildEpisodeDigest(
  blocks: readonly TerminalRecordBlock[],
): string {
  const parts: string[] = [];
  // The latest `Running …` row named the attachment store: the output row
  // that follows carries that command's output (ADR 0069 §5).
  let afterAttachmentCommand = false;
  for (const b of blocks) {
    if (b.kind === "system" && b.digest?.kind === "op") {
      afterAttachmentCommand =
        b.digest.verb === "Running" && mentionsAttachmentStore(b.digest.arg);
    }
    if (b.kind === "user") {
      parts.push(`开拓者：${b.text}`);
    } else if (b.kind === "herta") {
      // A supervisor-vetoed-then-corrected speech block carries the veto
      // reason in `selfCorrection`; surface it as a labeled self-correction
      // beat (a strong no-overclaim / honesty voice signal) before the final
      // corrected line. Mirrors how the live actor keeps it (serialize.ts).
      if (
        b.surface === "speech" &&
        b.selfCorrection !== undefined &&
        b.selfCorrection.length > 0
      ) {
        parts.push(`〔黑塔的自我更正：${b.selfCorrection}〕`);
      }
      parts.push(
        `${b.surface === "thought" ? "我（内心独白）" : "我"}：${b.text}`,
      );
    } else {
      const body = dreamRelevantSystemBody(b);
      if (body === null) continue;
      // Verified backend/system evidence — the outcome spine. Keep it clearly
      // labeled so the model grounds the verdict in what actually happened.
      // The ↳ 待办 roll-up line is dropped: open work items are operational
      // residue, not part of what happened.
      const detail = dreamRelevantEvidenceDetail(b, afterAttachmentCommand);
      const evidence =
        detail === null
          ? ""
          : detail
              .split("\n")
              .filter((l) => !l.startsWith("↳ 待办"))
              .join("\n");
      parts.push(
        `〔${b.label}（已核实）：${body}${evidence.length > 0 ? `\n${evidence}` : ""}〕`,
      );
    }
  }
  return parts.join("\n");
}
