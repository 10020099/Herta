import { describe, expect, it } from "vitest";
import { codePieces, markdownSections } from "./piece-segments.js";

describe("codePieces (ADR 0078 §2)", () => {
  it("a run of lines and the blank lines after it is one piece", () => {
    const lines = [
      "export function add(a, b) {",
      "  return a + b;",
      "}",
      "",
      "export function sub(a, b) {",
      "  return a - b;",
      "}",
      "",
      "",
      "export const pi = 3.14;",
    ];
    expect(codePieces(lines)).toEqual([
      { from: 1, to: 4 },
      { from: 5, to: 9 },
      { from: 10, to: 10 },
    ]);
  });

  it("blank lines before the first run belong to it; a file with no blank line is one piece", () => {
    expect(codePieces(["", "", "a", "b"])).toEqual([{ from: 1, to: 4 }]);
    expect(codePieces(["a", "b", "c"])).toEqual([{ from: 1, to: 3 }]);
    expect(codePieces([])).toEqual([]);
  });

  it("a trailing newline's empty line stays with the last piece", () => {
    expect(codePieces("a\n\nb\n".split("\n"))).toEqual([
      { from: 1, to: 2 },
      { from: 3, to: 4 },
    ]);
  });
});

describe("markdownSections (ADR 0078 §2)", () => {
  it("each heading opens a section up to the next; the preamble is its own", () => {
    const src = [
      "Intro line.",
      "",
      "# calc",
      "",
      "One paragraph.",
      "",
      "## 用法",
      "",
      "- add",
      "- sub",
      "",
    ].join("\n");
    expect(markdownSections(src)).toEqual([
      { from: 1, to: 2 },
      { from: 3, to: 6, title: "calc" },
      { from: 7, to: 11, title: "用法" },
    ]);
  });

  it("a heading inside a fence is code, not a section", () => {
    const src = [
      "# one",
      "",
      "```md",
      "# not a heading",
      "```",
      "",
      "# two",
      "x",
    ].join("\n");
    expect(markdownSections(src).map((s) => s.title)).toEqual(["one", "two"]);
  });

  it("a setext heading counts; no heading at all is one section", () => {
    expect(
      markdownSections("Title\n=====\n\ntext\n").map((s) => [s.from, s.title]),
    ).toEqual([[1, "Title"]]);
    expect(markdownSections("just text\nmore\n")).toEqual([{ from: 1, to: 3 }]);
  });
});
