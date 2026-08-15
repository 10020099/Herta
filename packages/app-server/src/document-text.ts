import { extname } from "node:path";
import { strFromU8, unzipSync } from "fflate";

/**
 * Text extraction for the two document formats people actually hand over
 * (ADR 0038): PDF and Word `.docx`. Both fell through `looksBinary` before
 * this — stored, cited, and unreadable by every tool that would be pointed at
 * them. The ingest calls `sniffDocumentFormat` first and, for a recognized
 * format, stores the EXTRACTED TEXT as the attachment (ADR 0038 §1); nothing
 * downstream learns a new file type.
 *
 * Boundaries this module keeps on purpose:
 * - It never touches the record. It returns text or a reason; `attachments.ts`
 *   turns either into a block that says what happened (ADR 0033 §5).
 * - pdfjs is loaded lazily and only here (§3): the GUI main bundle keeps it as
 *   its own chunk, and app startup never parses 3 MB of PDF engine.
 * - The docx walk is our own ~80 lines over fflate rather than a Word library:
 *   byte-equal to mammoth on real files, without its ten transitive packages.
 */

export type DocumentFormat = "pdf" | "docx";

/** Where the ingest should send a file, decided by extension AND magic bytes.
 *  `none` means "not ours — take the ordinary text path"; `unsupported` means
 *  a document format we recognize and cannot decode, which deserves a better
 *  answer than `非文本文件`. */
export type DocumentSniff =
  | { readonly kind: DocumentFormat }
  | { readonly kind: "unsupported" }
  | { readonly kind: "none" };

export type ExtractedDocument =
  | {
      readonly ok: true;
      readonly text: string;
      /** PDF only. */
      readonly pages?: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "empty"
        | "encrypted"
        | "too_many_pages"
        | "unsupported"
        | "parse_error";
      /** PDF only, when the document opened far enough to count. */
      readonly pages?: number;
    };

/**
 * Page ceiling for PDF extraction (ADR 0038 §4). Refused WHOLE above it, on
 * ADR 0033's own no-silent-prefix rule; the number is a main-process time
 * bound (≈10–15 s at the measured ~10–20 ms/page), and a book-length PDF is
 * the edge, not the use.
 */
export const MAX_PDF_PAGES = 1000;

/** Legacy binary Office and the sibling OOXML formats this slice does not
 *  decode. Listed by extension so a `.doc` gets `暂不支持` rather than
 *  `非文本文件` — the second is true and useless. */
const UNSUPPORTED_DOCUMENT_EXTS: ReadonlySet<string> = new Set([
  ".doc",
  ".xls",
  ".ppt",
  ".xlsx",
  ".pptx",
]);

const PDF_MAGIC = "%PDF-";
/** The PDF spec allows the header anywhere in the first 1024 bytes; pdfjs
 *  tolerates leading junk up to that, so the sniff matches it. */
const PDF_MAGIC_WINDOW = 1024;
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;
/** OLE compound file — a legacy `.doc`, or an encrypted OOXML package (which
 *  is stored as an OLE container). Either way not a zip we can read. */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, Math.min(bytes.length, PDF_MAGIC_WINDOW));
  // latin1 so every byte maps to one char and indexOf is a byte search.
  return strFromU8(window, true).includes(PDF_MAGIC);
}

/**
 * Extension AND magic (ADR 0038 §2). Extension alone would send a renamed
 * binary into a parser; magic alone would treat every zip as Word. A `.pdf`
 * without the header, or a `.docx` that is neither zip nor OLE, falls to
 * `none` — the text path then does what it always did with those bytes.
 */
export function sniffDocumentFormat(
  displayName: string,
  bytes: Uint8Array,
): DocumentSniff {
  const ext = extname(displayName).toLowerCase();
  if (ext === ".pdf") {
    return hasPdfHeader(bytes) ? { kind: "pdf" } : { kind: "none" };
  }
  if (ext === ".docx") {
    if (startsWith(bytes, ZIP_MAGIC)) return { kind: "docx" };
    if (startsWith(bytes, OLE_MAGIC)) return { kind: "unsupported" };
    return { kind: "none" };
  }
  if (UNSUPPORTED_DOCUMENT_EXTS.has(ext)) return { kind: "unsupported" };
  return { kind: "none" };
}

export async function extractDocumentText(
  format: DocumentFormat,
  bytes: Uint8Array,
  opts: { readonly maxPages?: number } = {},
): Promise<ExtractedDocument> {
  return format === "pdf"
    ? extractPdfText(bytes, opts)
    : extractDocxText(bytes);
}

// ───── PDF ─────

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjsPromise: Promise<PdfJs> | undefined;

/**
 * Lazy, once. The worker handler is imported STATICALLY (a literal specifier
 * rollup can bundle) and registered on `globalThis.pdfjsWorker`, which pdfjs's
 * Node "fake worker" consults before it would `import()` a variable
 * `workerSrc` — the path a bundler cannot follow (ADR 0038 §3). Registering it
 * ourselves rather than relying on the worker module's own top-level side
 * effect keeps this deterministic under any tree-shaking setting.
 */
async function loadPdfJs(): Promise<PdfJs> {
  if (pdfjsPromise === undefined) {
    pdfjsPromise = (async () => {
      installRenderingGlobalStubs();
      const [worker, lib] = await Promise.all([
        import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
        import("pdfjs-dist/legacy/build/pdf.mjs"),
      ]);
      (
        globalThis as { pdfjsWorker?: { WorkerMessageHandler: unknown } }
      ).pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler };
      return lib;
    })();
    // A failed load must not be cached as the answer for the rest of the
    // process — the next attach retries the import.
    pdfjsPromise.catch(() => {
      pdfjsPromise = undefined;
    });
  }
  return pdfjsPromise;
}

/**
 * pdfjs 6's display build evaluates `new DOMMatrix()` at MODULE SCOPE (a
 * rendering constant), so importing it under Node throws `ReferenceError`
 * unless something has defined the global; and it warns at import when
 * `Path2D` is missing. pdfjs would polyfill both from its optional native
 * `@napi-rs/canvas` — which is exactly the dependency ADR 0038 §3 excludes,
 * because the packaged app ships no node_modules and could never have loaded
 * it: with canvas present in dev only, PDF attach would have worked on every
 * developer machine and thrown in every installed copy.
 *
 * Text extraction never touches a matrix or a path; `getTextContent` runs in
 * the worker half. So the stubs are deliberately inert: they exist to let the
 * module evaluate. If a rendering path is ever added here, this is the first
 * thing to replace — a method call on either will throw, be caught, and
 * surface as `parse_error`, not as wrong output. Installed only when absent,
 * so a real DOM (a jsdom test, a renderer) is never shadowed.
 */
function installRenderingGlobalStubs(): void {
  const g = globalThis as { DOMMatrix?: unknown; Path2D?: unknown };
  // A bare class: JS constructors accept (and ignore) any arguments, so the
  // init value every pdfjs call site passes is simply dropped.
  if (g.DOMMatrix === undefined) g.DOMMatrix = class DOMMatrixStub {};
  if (g.Path2D === undefined) g.Path2D = class Path2DStub {};
}

async function extractPdfText(
  bytes: Uint8Array,
  opts: { readonly maxPages?: number },
): Promise<ExtractedDocument> {
  const maxPages = opts.maxPages ?? MAX_PDF_PAGES;
  // The engine load sits INSIDE the try: the ingest's contract is never to
  // throw (a throw is a file that vanished without a trace), so a failed
  // import must come back as a stated failure like any other.
  let task: ReturnType<PdfJs["getDocument"]> | undefined;
  try {
    const pdfjs = await loadPdfJs();
    // Own copy: pdfjs may transfer/detach the buffer it is handed, and the
    // caller still needs the original bytes for the content hash.
    const data = new Uint8Array(bytes);
    task = pdfjs.getDocument({
      data,
      // Text only. No font faces and no system font lookup — what a renderer
      // wants and an extractor does not.
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    });
    const doc = await task.promise;
    const pages = doc.numPages;
    if (pages > maxPages) return { ok: false, reason: "too_many_pages", pages };
    const out: string[] = [];
    for (let p = 1; p <= pages; p += 1) {
      const page = await doc.getPage(p);
      try {
        const content = await page.getTextContent();
        out.push(linesOfTextContent(content.items));
      } finally {
        page.cleanup();
      }
    }
    const text = out.join("\n\n");
    if (text.trim().length === 0) return { ok: false, reason: "empty", pages };
    return { ok: true, text, pages };
  } catch (err) {
    // pdfjs raises a distinct exception for a password-protected file; the
    // rest (InvalidPDF, malformed xref, truncated stream) is "could not parse".
    if (isNamedError(err, "PasswordException")) {
      return { ok: false, reason: "encrypted" };
    }
    return { ok: false, reason: "parse_error" };
  } finally {
    // Frees the fake worker's document state; without it each attach leaks
    // the parsed object graph for the process lifetime.
    if (task !== undefined) await task.destroy().catch(() => undefined);
  }
}

/** pdfjs hands back a flat item list per page; `hasEOL` marks where the
 *  layout engine saw a line end, and it emits explicit whitespace items for
 *  gaps, so joining `str`s and breaking on `hasEOL` reproduces reading order
 *  well enough for a text file. */
function linesOfTextContent(items: ReadonlyArray<unknown>): string {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    // The list mixes TextItem with marked-content markers (no `str`).
    if (typeof item !== "object" || item === null || !("str" in item)) continue;
    const { str, hasEOL } = item as { str: unknown; hasEOL?: unknown };
    if (typeof str !== "string") continue;
    line += str;
    if (hasEOL === true) {
      lines.push(line);
      line = "";
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.join("\n");
}

function isNamedError(err: unknown, name: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === name
  );
}

// ───── DOCX ─────

const DOCX_MAIN_PART = "word/document.xml";

/**
 * A `.docx` is a zip; the body text lives in `word/document.xml` as `w:t`
 * runs inside `w:p` paragraphs. Only that one entry is inflated — images,
 * fonts and the rest of the package are skipped by fflate's filter without
 * decompression. The walk emits: a newline per paragraph, a tab per `w:tab`
 * and per table-cell boundary, a newline per explicit break. Field codes
 * (`w:instrText`), tracked deletions (`w:delText`) and every other element
 * are ignored — a reader wants the visible text, nothing else.
 */
function extractDocxText(bytes: Uint8Array): ExtractedDocument {
  let xml: string;
  try {
    const parts = unzipSync(bytes, {
      filter: (file) => file.name === DOCX_MAIN_PART,
    });
    const main = parts[DOCX_MAIN_PART];
    // A zip without the Word main part is some other OOXML (or any zip) that
    // happens to be named .docx.
    if (main === undefined) return { ok: false, reason: "unsupported" };
    xml = strFromU8(main);
  } catch {
    return { ok: false, reason: "parse_error" };
  }
  const text = textOfWordprocessingXml(xml);
  if (text.trim().length === 0) return { ok: false, reason: "empty" };
  return { ok: true, text };
}

/** Structural tags the walk reacts to. `w:t` opens/closes a text run; the
 *  others are pure emitters. Matched by name followed by whitespace, `/` or
 *  `>` so `w:tab` cannot match `w:table`… (nor `w:t` match `w:tab`). */
const WORD_TAG =
  /<(\/?)(w:t|w:tab|w:br|w:cr|w:p|w:tc|w:noBreakHyphen)(?=[\s/>])([^>]*)>/g;

export function textOfWordprocessingXml(xml: string): string {
  const paragraphs: string[] = [];
  let para = "";
  let inText = false;
  let textStart = 0;
  WORD_TAG.lastIndex = 0;
  let m: RegExpExecArray | null = WORD_TAG.exec(xml);
  while (m !== null) {
    const closing = m[1] === "/";
    const tag = m[2];
    const selfClosing = (m[3] ?? "").trimEnd().endsWith("/");
    if (tag === "w:t") {
      if (closing) {
        if (inText) {
          para += decodeXmlEntities(xml.slice(textStart, m.index));
          inText = false;
        }
      } else if (!selfClosing) {
        inText = true;
        textStart = m.index + m[0].length;
      }
    } else if (!closing) {
      // Emitters — a closing form is not meaningful for these, and w:tab /
      // w:br / w:cr are self-closing in practice.
      if (tag === "w:tab") para += "\t";
      else if (tag === "w:br" || tag === "w:cr") para += "\n";
      else if (tag === "w:noBreakHyphen") para += "-";
    } else if (tag === "w:p") {
      paragraphs.push(para);
      para = "";
    } else if (tag === "w:tc") {
      para += "\t";
    }
    m = WORD_TAG.exec(xml);
  }
  if (para.length > 0) paragraphs.push(para);
  return paragraphs.join("\n");
}

/** The five XML entities plus numeric references — all that `w:t` content
 *  can legally carry. `&amp;` last, so `&amp;lt;` decodes to `&lt;` and not
 *  to `<`. An out-of-range code point (a corrupt file) becomes nothing rather
 *  than a throw out of the middle of a walk. */
function decodeXmlEntities(s: string): string {
  const cp = (n: number): string =>
    Number.isInteger(n) && n >= 0 && n <= 0x10ffff
      ? String.fromCodePoint(n)
      : "";
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      cp(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => cp(Number(dec)))
    .replace(/&amp;/g, "&");
}
