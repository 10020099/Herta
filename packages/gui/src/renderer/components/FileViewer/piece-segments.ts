import { Lexer } from "marked";

/**
 * Where the viewer's page splits into pieces (ADR 0078 §2): the document's
 * own structure, at the size the owner chose (大块). Pure — line ranges
 * only; the views turn them into rectangles.
 */

/** 1-based, inclusive line range. */
export interface LineRange {
  readonly from: number;
  readonly to: number;
}

/** A markdown section: its lines, and its heading's text when it has one. */
export interface MarkdownSection extends LineRange {
  readonly title?: string;
}

/**
 * Code as pieces: each run of non-blank lines together with the blank lines
 * after it — roughly a function or a block. Blank lines before the first
 * run belong to it. An empty file is one empty piece.
 */
export function codePieces(lines: readonly string[]): LineRange[] {
  if (lines.length === 0) return [];
  const pieces: LineRange[] = [];
  let start = 1;
  let seenText = false;
  for (let i = 0; i < lines.length; i++) {
    const blank = (lines[i] ?? "").trim().length === 0;
    if (!blank && seenText && (lines[i - 1] ?? "").trim().length === 0) {
      // A text line after blank ones opens the next piece.
      pieces.push({ from: start, to: i });
      start = i + 1;
    }
    if (!blank) seenText = true;
  }
  pieces.push({ from: start, to: lines.length });
  return pieces;
}

/**
 * Markdown as sections: each top-level heading with the blocks up to the
 * next one, and the preamble before the first heading as its own section
 * when it holds anything but blank lines. Line ranges come from the lexer's
 * own tokens, so fences, setext headings and the like are read as `marked`
 * renders them.
 */
export function markdownSections(source: string): MarkdownSection[] {
  const tokens = new Lexer({ gfm: true }).lex(source);
  const totalLines = source.length === 0 ? 0 : source.split("\n").length;
  const starts: { line: number; title?: string }[] = [];
  let line = 1;
  let preambleHasText = false;
  for (const tok of tokens) {
    if (tok.type === "heading") {
      const title = (tok as { text?: unknown }).text;
      starts.push({
        line,
        ...(typeof title === "string" ? { title } : {}),
      });
    } else if (starts.length === 0 && tok.type !== "space") {
      preambleHasText = true;
    }
    line += countNewlines(tok.raw);
  }
  const sections: MarkdownSection[] = [];
  const first = starts[0]?.line ?? totalLines + 1;
  if (preambleHasText && first > 1) {
    sections.push({ from: 1, to: Math.max(1, first - 1) });
  }
  starts.forEach((s, i) => {
    const next = starts[i + 1]?.line ?? totalLines + 1;
    sections.push({
      from: s.line,
      to: Math.max(s.line, next - 1),
      ...(s.title !== undefined ? { title: s.title } : {}),
    });
  });
  if (sections.length === 0 && totalLines > 0) {
    sections.push({ from: 1, to: totalLines });
  }
  return sections;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n += 1;
  return n;
}
