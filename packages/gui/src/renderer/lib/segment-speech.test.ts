import { describe, expect, it } from "vitest";
import { MAX_SEGMENTS, segmentSpeech } from "./segment-speech.js";

describe("segmentSpeech — prose paragraph splits", () => {
  it("single paragraph → one prose segment", () => {
    expect(segmentSpeech("就一句话。")).toEqual([
      { kind: "prose", text: "就一句话。" },
    ]);
  });

  it("blank-line paragraphs → stacked prose segments", () => {
    expect(segmentSpeech("第一段。\n\n第二段。\n\n第三段。")).toEqual([
      { kind: "prose", text: "第一段。" },
      { kind: "prose", text: "第二段。" },
      { kind: "prose", text: "第三段。" },
    ]);
  });

  it("single newlines stay INSIDE one paragraph (pre-wrap owns them)", () => {
    expect(segmentSpeech("一行\n又一行")).toEqual([
      { kind: "prose", text: "一行\n又一行" },
    ]);
  });

  it("blank lines with stray spaces still split; extras collapse", () => {
    expect(segmentSpeech("a\n \n\nb")).toEqual([
      { kind: "prose", text: "a" },
      { kind: "prose", text: "b" },
    ]);
  });

  it("drops empty input and trailing blank runs", () => {
    expect(segmentSpeech("")).toEqual([]);
    expect(segmentSpeech("   \n\n  ")).toEqual([]);
    expect(segmentSpeech("尾巴。\n\n\n")).toEqual([
      { kind: "prose", text: "尾巴。" },
    ]);
  });

  it("preserves a @板砖 mention within its paragraph", () => {
    expect(segmentSpeech("这个交给 @板砖。\n\n我先睡了。")).toEqual([
      { kind: "prose", text: "这个交给 @板砖。" },
      { kind: "prose", text: "我先睡了。" },
    ]);
  });
});

describe("segmentSpeech — fences", () => {
  it("closed fence → prose, code, prose", () => {
    expect(
      segmentSpeech("看这段：\n```ts\nconst x = 1;\n```\n就这样。"),
    ).toEqual([
      { kind: "prose", text: "看这段：" },
      { kind: "code", text: "const x = 1;", lang: "ts" },
      { kind: "prose", text: "就这样。" },
    ]);
  });

  it("fence without a lang tag omits lang", () => {
    expect(segmentSpeech("```\nplain\n```")).toEqual([
      { kind: "code", text: "plain" },
    ]);
  });

  it("blank lines INSIDE a fence never split", () => {
    expect(segmentSpeech("```\nline1\n\nline2\n```")).toEqual([
      { kind: "code", text: "line1\n\nline2" },
    ]);
  });

  it("an UNCLOSED fence swallows the tail as one code segment", () => {
    expect(segmentSpeech("先说两句。\n```py\nprint(1)\nprint(2)")).toEqual([
      { kind: "prose", text: "先说两句。" },
      { kind: "code", text: "print(1)\nprint(2)", lang: "py" },
    ]);
  });

  it("an empty fence interior is dropped", () => {
    expect(segmentSpeech("前。\n```\n\n```\n后。")).toEqual([
      { kind: "prose", text: "前。" },
      { kind: "prose", text: "后。" },
    ]);
  });

  it("a lang-tagged ``` line inside a fence does NOT close it", () => {
    expect(segmentSpeech("```\nouter\n```ts\nstill inside\n```")).toEqual([
      { kind: "code", text: "outer\n```ts\nstill inside" },
    ]);
  });
});

describe("segmentSpeech — cap", () => {
  it(`folds overflow into the last segment at ${MAX_SEGMENTS}`, () => {
    const paras = Array.from({ length: 8 }, (_, i) => `第${i + 1}段。`);
    const out = segmentSpeech(paras.join("\n\n"));
    expect(out).toHaveLength(MAX_SEGMENTS);
    // The final segment carries everything from the fold point on — no
    // text is dropped.
    const tail = out[MAX_SEGMENTS - 1];
    expect(tail?.kind).toBe("prose");
    for (let i = MAX_SEGMENTS; i <= 8; i++) {
      expect(tail?.text).toContain(`第${i}段。`);
    }
    // Earlier segments intact.
    expect(out[0]).toEqual({ kind: "prose", text: "第1段。" });
  });

  it("a folded code segment keeps its fence markers so the text still reads as code", () => {
    const paras = [
      ...Array.from({ length: 5 }, (_, i) => `p${i + 1}`),
      "```\ncode tail\n```",
    ];
    const out = segmentSpeech(paras.join("\n\n"));
    expect(out).toHaveLength(MAX_SEGMENTS);
    expect(out[MAX_SEGMENTS - 1]?.text).toContain("```\ncode tail\n```");
  });
});
