import { Marked } from "marked";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useT } from "../../../i18n/LocaleProvider.js";
import {
  type MaskPiece,
  PieceMask,
  type PieceQuoting,
  quotesFromRuns,
} from "../PieceQuote.js";
import { markdownSections } from "../piece-segments.js";
import { sanitizedFragment, setSanitizedHtml } from "./dom-html.js";

/**
 * Markdown as the page (ADR 0054 §4): `marked` (GFM) → DOMPurify → DOM,
 * then two passes over the fences — ```mermaid becomes a diagram (lazy
 * chunk, strict security level) and every other fence gets highlight.js
 * tokens when its language is known. Both passes are async and keyed to
 * the content they were started for, so a file switched mid-render never
 * paints into the wrong document.
 */
const marked = new Marked({ gfm: true, breaks: false, async: false });

/** Fences above this many are left plain — a generated dump with hundreds
 *  of code blocks is not a page anyone reads token by token. */
const MAX_HIGHLIGHTED_FENCES = 200;
const MAX_DIAGRAMS = 40;

function fenceLanguage(code: HTMLElement): string | null {
  const cls = [...code.classList].find((c) => c.startsWith("language-"));
  return cls === undefined ? null : cls.slice("language-".length);
}

export function MarkdownView({
  content,
  truncated,
  piece,
}: {
  readonly content: string;
  readonly truncated: boolean;
  /** Piece quoting (ADR 0078); absent where the panel offers none. */
  readonly piece?: PieceQuoting | undefined;
}): JSX.Element {
  const t = useT();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const diagramFailedLabel = t("viewer.diagramFailed");
  const lines = useMemo(() => content.split("\n"), [content]);

  // The pieces (ADR 0078 §2): the source's sections, laid over the page's
  // top-level blocks — a section starts at its heading, and its seam sits
  // halfway through the gap before it. A page whose headings do not match
  // the source's one for one is one piece.
  const measurePieces = useCallback((): readonly MaskPiece[] => {
    const host = hostRef.current;
    const doc = bodyRef.current;
    if (host === null || doc === null) return [];
    const sections = markdownSections(content);
    const blocks = Array.from(doc.children) as HTMLElement[];
    const headings = blocks.filter((b) => /^H[1-6]$/.test(b.tagName));
    const titled = sections.filter((s) => s.title !== undefined);
    const total = host.offsetHeight;
    if (sections.length === 0) return [];
    if (headings.length !== titled.length) {
      return [{ top: 0, height: total, from: 1, to: lines.length }];
    }
    const preamble = sections.length > titled.length;
    const starts = [...(preamble ? [blocks[0]] : []), ...headings];
    const tops = starts.map((el, i) => {
      if (i === 0 || el === undefined) return 0;
      const prev = el.previousElementSibling as HTMLElement | null;
      const gapTop =
        prev === null ? el.offsetTop : prev.offsetTop + prev.offsetHeight;
      return (gapTop + el.offsetTop) / 2;
    });
    return sections.map((s, i) => {
      const top = tops[i] ?? 0;
      const bottom = tops[i + 1] ?? total;
      return {
        top,
        height: bottom - top,
        from: s.from,
        to: s.to,
        ...(s.title !== undefined ? { title: s.title } : {}),
      };
    });
  }, [content, lines]);
  const quotePieces = useCallback(
    (runs: readonly (readonly MaskPiece[])[]): void => {
      if (piece === undefined) return;
      piece.onQuote(quotesFromRuns(runs, lines, piece.path, piece.lang, "md"));
    },
    [piece, lines],
  );

  useEffect(() => {
    const root = bodyRef.current;
    if (root === null) return;
    let alive = true;
    const html = marked.parse(content) as string;
    const frag = sanitizedFragment(html);
    root.replaceChildren(frag);

    // Fences: diagrams first (they replace the block), then tokens.
    const fences = [...root.querySelectorAll<HTMLElement>("pre > code")];
    const diagrams = fences
      .filter((c) => fenceLanguage(c) === "mermaid")
      .slice(0, MAX_DIAGRAMS);
    const others = fences
      .filter((c) => fenceLanguage(c) !== "mermaid")
      .slice(0, MAX_HIGHLIGHTED_FENCES);

    if (diagrams.length > 0) {
      void import("./mermaid-render.js").then(
        async ({ renderMermaid }) => {
          for (const code of diagrams) {
            if (!alive) return;
            const pre = code.parentElement;
            if (pre === null) continue;
            const source = code.textContent ?? "";
            try {
              const svg = await renderMermaid(source);
              if (!alive) return;
              const figure = document.createElement("figure");
              figure.className = "file-viewer__diagram";
              figure.append(svg);
              pre.replaceWith(figure);
            } catch {
              if (!alive) return;
              // The source stays visible, labeled honestly — never a blank
              // hole where a diagram was promised.
              const note = document.createElement("p");
              note.className = "file-viewer__diagram-failed";
              note.textContent = diagramFailedLabel;
              pre.before(note);
            }
          }
        },
        () => undefined,
      );
    }

    if (others.length > 0) {
      void import("./highlight.js").then(
        (h) => {
          if (!alive) return;
          for (const code of others) {
            const lang = fenceLanguage(code);
            if (lang === null) continue;
            const html = h.highlightToHtml(code.textContent ?? "", lang);
            if (html !== null) setSanitizedHtml(code, html);
          }
        },
        () => undefined,
      );
    }

    return () => {
      alive = false;
    };
  }, [content, diagramFailedLabel]);

  return (
    <div className="file-viewer__body">
      <div ref={scrollerRef} className="file-viewer__scroll">
        <div ref={hostRef} className="file-viewer__doc-host">
          <div ref={bodyRef} className="file-viewer__doc" />
          {piece !== undefined && (
            <PieceMask
              enabled={piece.enabled}
              hostRef={hostRef}
              scrollerRef={scrollerRef}
              measure={measurePieces}
              onQuote={quotePieces}
              resetKey={content}
            />
          )}
        </div>
      </div>
      {truncated && (
        <p className="file-viewer__notice">{t("viewer.truncatedNote")}</p>
      )}
    </div>
  );
}
