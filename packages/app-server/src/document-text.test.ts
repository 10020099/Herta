import { describe, expect, it } from "vitest";
import {
  extractDocumentText,
  MAX_PDF_PAGES,
  sniffDocumentFormat,
  textOfWordprocessingXml,
} from "./document-text.js";
import {
  docxParagraphs,
  makeDocx,
  makeNonWordZip,
  makeOleBytes,
  makePdf,
} from "./testing/document-fixtures.js";

describe("sniffDocumentFormat — extension AND magic (ADR 0038 §2)", () => {
  it(".pdf with the %PDF- header is pdf", () => {
    expect(sniffDocumentFormat("report.pdf", makePdf([["x"]]))).toEqual({
      kind: "pdf",
    });
    // Case-insensitive extension.
    expect(sniffDocumentFormat("REPORT.PDF", makePdf([["x"]]))).toEqual({
      kind: "pdf",
    });
  });

  it("tolerates leading junk before the header, as pdfjs does, within 1024 bytes", () => {
    const junk = Buffer.concat([Buffer.alloc(200, 0x20), makePdf([["x"]])]);
    expect(sniffDocumentFormat("a.pdf", junk)).toEqual({ kind: "pdf" });
    const tooFar = Buffer.concat([Buffer.alloc(2000, 0x20), makePdf([["x"]])]);
    expect(sniffDocumentFormat("a.pdf", tooFar)).toEqual({ kind: "none" });
  });

  it(".pdf without the header is not ours — falls to the text path", () => {
    expect(
      sniffDocumentFormat("notes.pdf", Buffer.from("just text\n", "utf8")),
    ).toEqual({ kind: "none" });
  });

  it(".docx with the zip signature is docx; with the OLE signature it is unsupported; otherwise none", () => {
    expect(sniffDocumentFormat("spec.docx", makeDocx(""))).toEqual({
      kind: "docx",
    });
    expect(sniffDocumentFormat("spec.docx", makeOleBytes())).toEqual({
      kind: "unsupported",
    });
    expect(sniffDocumentFormat("spec.docx", Buffer.from("plain"))).toEqual({
      kind: "none",
    });
  });

  it("legacy Office and sibling OOXML extensions are unsupported regardless of bytes", () => {
    for (const name of [
      "a.doc",
      "a.xls",
      "a.ppt",
      "a.xlsx",
      "a.pptx",
      "A.DOC",
    ]) {
      expect(sniffDocumentFormat(name, Buffer.from("anything"))).toEqual({
        kind: "unsupported",
      });
    }
  });

  it("everything else is none — the ordinary text path decides", () => {
    for (const name of ["a.md", "a.txt", "a.csv", "a", ".pdfx", "a.pdf.bak"]) {
      expect(sniffDocumentFormat(name, makePdf([["x"]]))).toEqual({
        kind: "none",
      });
    }
  });
});

describe("extractDocumentText — pdf", () => {
  it("loads pdfjs with neither a DOM nor the native canvas present — the packaged app's exact conditions", async () => {
    // pdfjs 6 evaluates `new DOMMatrix()` at module scope and would polyfill
    // it from @napi-rs/canvas; that package is excluded from the workspace
    // (root pnpm override) precisely so this test runs under the same
    // conditions as the installed app, where no node_modules exist. If either
    // stub in installRenderingGlobalStubs is removed, this is the test that
    // fails — not the first user to attach a PDF.
    expect(
      (globalThis as { navigator?: { userAgent?: string } }).navigator
        ?.userAgent ?? "",
    ).not.toMatch(/jsdom/i);
    let canvasResolvable = true;
    try {
      const { createRequire } = await import("node:module");
      createRequire(import.meta.url).resolve("@napi-rs/canvas");
    } catch {
      canvasResolvable = false;
    }
    expect(canvasResolvable).toBe(false);
    const r = await extractDocumentText("pdf", makePdf([["still works"]]));
    expect(r).toEqual({ ok: true, text: "still works", pages: 1 });
  });

  it("extracts text with line breaks and a page count", async () => {
    const r = await extractDocumentText(
      "pdf",
      makePdf([["Hello (world)", "Second line"], ["Page two"]]),
    );
    expect(r).toEqual({
      ok: true,
      text: "Hello (world)\nSecond line\n\nPage two",
      pages: 2,
    });
  });

  it("a page with no text content is `empty` — the scanned-PDF case ADR 0033 §5 warned about", async () => {
    const r = await extractDocumentText("pdf", makePdf([[], []]));
    expect(r).toEqual({ ok: false, reason: "empty", pages: 2 });
  });

  it("a password-protected file is `encrypted`, not a generic parse error", async () => {
    const r = await extractDocumentText(
      "pdf",
      makePdf([["secret"]], { encrypt: true }),
    );
    expect(r).toEqual({ ok: false, reason: "encrypted" });
  });

  it("garbage that passed the sniff is `parse_error`", async () => {
    const r = await extractDocumentText(
      "pdf",
      Buffer.from("%PDF-1.4\nthis is not a pdf body\n", "latin1"),
    );
    expect(r).toEqual({ ok: false, reason: "parse_error" });
  });

  it("over the page cap is refused whole with the page count (ADR 0038 §4)", async () => {
    const twelve = makePdf(Array.from({ length: 12 }, (_, i) => [`p${i + 1}`]));
    const r = await extractDocumentText("pdf", twelve, { maxPages: 10 });
    expect(r).toEqual({ ok: false, reason: "too_many_pages", pages: 12 });
    // At the cap exactly, it goes through.
    const ok = await extractDocumentText("pdf", twelve, { maxPages: 12 });
    expect(ok.ok).toBe(true);
    expect(MAX_PDF_PAGES).toBe(1000);
  });

  it("does not consume the caller's buffer (the ingest still hashes it)", async () => {
    const bytes = makePdf([["keep me"]]);
    const before = Buffer.from(bytes);
    await extractDocumentText("pdf", bytes);
    expect(bytes.equals(before)).toBe(true);
    expect(bytes.byteLength).toBe(before.byteLength);
  });

  it("Latin-1 text through WinAnsi decodes to the right characters", async () => {
    const r = await extractDocumentText("pdf", makePdf([["caf\xe9 na\xefve"]]));
    expect(r).toEqual({ ok: true, text: "café naïve", pages: 1 });
  });
});

describe("extractDocumentText — docx", () => {
  it("extracts paragraphs as lines and decodes entities", async () => {
    const r = await extractDocumentText(
      "docx",
      makeDocx(docxParagraphs(["Hello", "第二段 & <more>", 'quoted "x"'])),
    );
    expect(r).toEqual({
      ok: true,
      text: 'Hello\n第二段 & <more>\nquoted "x"',
    });
  });

  it("an empty document is `empty`", async () => {
    expect(await extractDocumentText("docx", makeDocx(""))).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(
      await extractDocumentText("docx", makeDocx(docxParagraphs(["  ", ""]))),
    ).toEqual({ ok: false, reason: "empty" });
  });

  it("a zip without word/document.xml is `unsupported` (an .xlsx renamed .docx)", async () => {
    expect(await extractDocumentText("docx", makeNonWordZip())).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });

  it("a corrupt zip is `parse_error`", async () => {
    const broken = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(40, 0xff),
    ]);
    expect(await extractDocumentText("docx", broken)).toEqual({
      ok: false,
      reason: "parse_error",
    });
  });
});

describe("textOfWordprocessingXml — the walk", () => {
  it("emits tabs for w:tab and cell boundaries, newlines for w:br/w:cr, hyphen for w:noBreakHyphen", () => {
    const xml =
      "<w:p><w:r><w:t>a</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>" +
      "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>r1c1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>r1c2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
      "<w:p><w:r><w:t>non</w:t><w:noBreakHyphen/><w:t>breaking</w:t></w:r></w:p>";
    expect(textOfWordprocessingXml(xml)).toBe(
      "a\tb\nc\nr1c1\n\tr1c2\n\tnon-breaking",
    );
  });

  it("does not confuse w:t with w:tab/w:tbl/w:tc, nor w:p with w:pPr/w:pStyle", () => {
    const xml =
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">Title </w:t></w:r></w:p>' +
      "<w:tbl><w:tblPr/><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>";
    expect(textOfWordprocessingXml(xml)).toBe("Title \ncell\n\t");
  });

  it("ignores field codes, tracked deletions and every non-w:t element", () => {
    const xml =
      "<w:p><w:r><w:instrText>PAGE</w:instrText></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:t>kept</w:t></w:r></w:p>";
    expect(textOfWordprocessingXml(xml)).toBe("kept");
  });

  it("decodes numeric references and refuses out-of-range code points", () => {
    const xml =
      "<w:p><w:r><w:t>&#x4E2D;&#25991;&amp;lt;&#x110000;</w:t></w:r></w:p>";
    expect(textOfWordprocessingXml(xml)).toBe("中文&lt;");
  });

  it("a self-closing w:t emits nothing and does not swallow what follows", () => {
    const xml = "<w:p><w:r><w:t/></w:r><w:r><w:t>after</w:t></w:r></w:p>";
    expect(textOfWordprocessingXml(xml)).toBe("after");
  });
});
