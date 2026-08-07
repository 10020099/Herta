/**
 * Fence-aware speech segmenter (slice 5 — Q1/Q2 of the output-hardening
 * review). Splits one committed `herta` block's text into presentation
 * segments: fenced ``` regions become `code` segments (rendered as a plain
 * monospace sub-block), and the prose between them splits on blank lines
 * into paragraph units (rendered as a stacked-bubble sequence).
 *
 * PURE PRESENTATION over an unchanged record (D7, mirroring
 * `group-record.ts`): one `（我 说）` completion stays ONE record block,
 * one supervisor verdict, one selfCorrection anchor — this module only
 * decides how that single block is drawn.
 *
 * Rules (from the design consensus):
 *   - A ``` line opens a fence; the matching ``` line closes it. An
 *     UNCLOSED fence swallows the rest of the text as one code segment
 *     (mid-stream state during a live reveal — the segment simply grows).
 *   - Prose splits on runs of blank lines (\n\n+). Blank lines INSIDE a
 *     fence never split.
 *   - At most MAX_SEGMENTS units; overflow folds into the last segment
 *     (a wall of paragraphs must not become a wall of bubbles).
 *   - Empty/whitespace-only units are dropped.
 */

export type Segment =
  | { readonly kind: "prose"; readonly text: string }
  | { readonly kind: "code"; readonly text: string; readonly lang?: string };

/** Bubble-stack cap. Chat bubbles read as human messages up to a handful;
 *  past that the stack reads as spam and scrolling suffers. Overflow folds
 *  into the final segment rather than being dropped (never lose text). */
export const MAX_SEGMENTS = 5;

/** A fence line: ``` plus an optional info string (```ts). Leading
 *  whitespace tolerated (models indent fences); trailing content after the
 *  opening backticks is the lang tag. */
const FENCE_LINE = /^\s*```([^`\n]*)\s*$/;

export function segmentSpeech(text: string): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];

  let proseBuf: string[] = [];
  let codeBuf: string[] | null = null;
  let codeLang: string | undefined;

  const flushProse = (): void => {
    const joined = proseBuf.join("\n");
    proseBuf = [];
    // Split the prose run on blank-line boundaries into paragraph units.
    for (const para of joined.split(/\n\s*\n+/)) {
      const trimmed = para.trim();
      if (trimmed.length > 0) segments.push({ kind: "prose", text: trimmed });
    }
  };

  for (const line of lines) {
    const fence = line.match(FENCE_LINE);
    if (codeBuf === null) {
      if (fence !== null) {
        flushProse();
        codeBuf = [];
        const lang = fence[1]?.trim() ?? "";
        codeLang = lang.length > 0 ? lang : undefined;
      } else {
        proseBuf.push(line);
      }
    } else if (fence !== null && (fence[1]?.trim() ?? "") === "") {
      // Closing fence (a bare ``` line — a lang tag reopens, per CommonMark
      // close fences carry no info string).
      const code = codeBuf.join("\n");
      codeBuf = null;
      // Keep even whitespace-only code interiors out; a code segment must
      // have SOMETHING to show.
      if (code.trim().length > 0) {
        segments.push({
          kind: "code",
          text: code,
          ...(codeLang !== undefined ? { lang: codeLang } : {}),
        });
      }
      codeLang = undefined;
    } else {
      codeBuf.push(line);
    }
  }

  // End of text: an unclosed fence swallows the tail as one code segment
  // (live-reveal mid-fence state, or the model never closed it).
  if (codeBuf !== null) {
    const code = codeBuf.join("\n");
    if (code.trim().length > 0) {
      segments.push({
        kind: "code",
        text: code,
        ...(codeLang !== undefined ? { lang: codeLang } : {}),
      });
    }
  } else {
    flushProse();
  }

  // Cap: fold overflow into the LAST kept segment so no text is dropped.
  if (segments.length > MAX_SEGMENTS) {
    const kept = segments.slice(0, MAX_SEGMENTS - 1);
    const folded = segments.slice(MAX_SEGMENTS - 1);
    const foldedText = folded
      .map((s) => (s.kind === "code" ? `\`\`\`\n${s.text}\n\`\`\`` : s.text))
      .join("\n\n");
    kept.push({ kind: "prose", text: foldedText });
    return kept;
  }
  return segments;
}
