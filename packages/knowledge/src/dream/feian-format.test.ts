import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  countFeianFiles,
  extractNarrativeOpening,
  feianFileIndex,
  nextFeianIndex,
  parseFeianHeader,
  pickEvictableSeedFile,
  validateFeian,
} from "./feian-format.js";

// Resolve the TRACKED canonical seed corpus (packages/herta/prompts/
// feian-seeds — the source materializeSeedFeian copies into workspaces) by
// walking up to the repo root, so the fixture is hermetic: it passes in a
// fresh clone and CI, not just on a machine whose live `.herta/narrative`
// happens to be populated.
function findNarrativeRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth++) {
    const candidate = join(dir, "packages", "herta", "prompts", "feian-seeds");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(
    "feian-format.test: could not locate packages/herta/prompts/feian-seeds above the test file",
  );
}

const GOOD = [
  "### 废案_07：午后的噪声",
  "",
  "阮·梅难得主动联系我。",
  "",
  "---",
  "",
  "（开拓者 说）",
  "在吗",
  "（/开拓者 说）",
  "",
  "（我 说）",
  "在。说吧。",
  "（/我 说）",
].join("\n");

describe("validateFeian — accepts", () => {
  it("a well-formed numbered 废案", () => {
    expect(validateFeian(GOOD)).toEqual({ ok: true });
  });

  it("the legacy unnumbered header form", () => {
    expect(validateFeian(GOOD.replace("### 废案_07：", "### 废案："))).toEqual({
      ok: true,
    });
  });
});

describe("validateFeian — rejects", () => {
  const expectErr = (text: string, needle: string) => {
    const r = validateFeian(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain(needle);
  };

  it("a non-废案 first line", () =>
    expectErr(GOOD.replace("### 废案_07：午后的噪声", "## wrong"), "header"));
  it("an unbalanced fence", () =>
    expectErr(GOOD.replace("（/我 说）", ""), "unbalanced"));
  it("a missing （我 说）block", () =>
    expectErr(
      GOOD.replace("（我 说）\n在。说吧。\n（/我 说）", ""),
      "（我 说）",
    ));
  it("a missing --- separator", () =>
    expectErr(GOOD.replace("---", ""), "separator"));
  it("a leaked English structural marker", () =>
    expectErr(`${GOOD}\nVerdict: done`, "marker"));
  it("a western digit-run in the TITLE (one-off log)", () =>
    expectErr(GOOD.replace("午后的噪声", "修复 PR 3492"), "title"));
  it("an ISO date in the TITLE", () =>
    expectErr(GOOD.replace("午后的噪声", "2026-06-18 的复盘"), "title"));
  it("a file-extension token in the TITLE", () =>
    expectErr(GOOD.replace("午后的噪声", "改 foo.ts"), "title"));
  it("a zero-width codepoint anywhere", () =>
    expectErr(
      GOOD.replace("在。", `在${String.fromCharCode(0x200b)}。`),
      "codepoint",
    ));
  it("an LRM (0x200e) invisible directional mark in the body", () =>
    expectErr(
      GOOD.replace("在。", `在${String.fromCharCode(0x200e)}。`),
      "codepoint",
    ));
});

describe("validateFeian — exemptions", () => {
  it("allows CJK numerals and the （其N）series suffix in the title", () => {
    expect(
      validateFeian(
        GOOD.replace("午后的噪声", "远程办公的一百种无聊方式（其七）"),
      ).ok,
    ).toBe(true);
  });
  it("allows file paths in the BODY (transcript half)", () => {
    expect(
      validateFeian(GOOD.replace("在。说吧。", "看了 src/foo.ts，没问题。")).ok,
    ).toBe(true);
  });
  it("allows a single-slash word title like 'Unix/Windows 的对比'", () => {
    expect(
      validateFeian(GOOD.replace("午后的噪声", "Unix/Windows 的对比")).ok,
    ).toBe(true);
  });
});

describe("validateFeian — title path rejection", () => {
  const expectErr = (text: string, needle: string) => {
    const r = validateFeian(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain(needle);
  };

  it("rejects a title containing /etc/passwd", () =>
    expectErr(GOOD.replace("午后的噪声", "/etc/passwd 漏洞"), "title"));
  it("rejects a title containing a Windows drive path C:/Users/x", () =>
    expectErr(GOOD.replace("午后的噪声", "C:/Users/x 路径"), "title"));
});

describe("validateFeian — real seed corpus", () => {
  it("accepts all real seed files as fixtures", () => {
    const root = findNarrativeRoot();
    const files = readdirSync(root).filter((f) =>
      /^### 废案_\d{2,}：.+\.txt$/.test(f),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(root, f), "utf8");
      expect(validateFeian(text), `seed: ${f}`).toEqual({ ok: true });
    }
  });
});

describe("parseFeianHeader", () => {
  it("parses a numbered header", () =>
    expect(parseFeianHeader("### 废案_07：午后")).toEqual({
      nn: 7,
      title: "午后",
    }));
  it("parses a legacy unnumbered header", () =>
    expect(parseFeianHeader("### 废案：午后")).toEqual({ title: "午后" }));
  it("returns null for a non-header", () =>
    expect(parseFeianHeader("## nope")).toBeNull());
});

describe("extractNarrativeOpening", () => {
  it("extracts the narrative paragraphs between the header and the first ---", () => {
    const text = [
      "### 废案_07：午后的噪声",
      "",
      "阮·梅难得主动联系我。今天天气很好。",
      "",
      "---",
      "",
      "（我 说）",
      "在。说吧。",
      "（/我 说）",
    ].join("\n");
    expect(extractNarrativeOpening(text)).toBe(
      "阮·梅难得主动联系我。今天天气很好。",
    );
  });

  it("caps the opening at maxChars and appends …", () => {
    const long = "A".repeat(400);
    const text = `### 废案_00：标题\n\n${long}\n\n---\n\n（我 说）\nx\n（/我 说）`;
    const result = extractNarrativeOpening(text, 50);
    expect(result).toBe(`${"A".repeat(50)}…`);
    expect(result.length).toBe(51); // 50 chars + ellipsis character
  });

  it("returns empty string when header is immediately followed by ---", () => {
    const text = [
      "### 废案_00：无叙事",
      "",
      "---",
      "",
      "（我 说）",
      "嗯。",
      "（/我 说）",
    ].join("\n");
    expect(extractNarrativeOpening(text)).toBe("");
  });

  it("skips leading blank lines before the header", () => {
    const text =
      "\n\n### 废案_07：标题\n\n开篇叙事。\n\n---\n\n（我 说）\nx\n（/我 说）";
    expect(extractNarrativeOpening(text)).toBe("开篇叙事。");
  });

  it("returns the whole post-header body when there is no --- separator", () => {
    // validateFeian rejects such text upstream; this documents graceful behavior.
    const text = "### 废案_00：标题\n\n只有叙事，没有分隔符。";
    expect(extractNarrativeOpening(text)).toBe("只有叙事，没有分隔符。");
  });
});

describe("nextFeianIndex", () => {
  it("returns max numbered NN + 1", () =>
    expect(
      nextFeianIndex([
        "### 废案_00：a.txt",
        "### 废案_06：b.txt",
        "### 废案：legacy.txt",
        "### 记录_03：c.txt",
      ]),
    ).toBe(7));
  it("returns 0 for an empty corpus", () => expect(nextFeianIndex([])).toBe(0));
});

describe("feianFileIndex", () => {
  it("parses the NN from a numbered filename", () => {
    expect(feianFileIndex("### 废案_06：种子.txt")).toBe(6);
    expect(feianFileIndex("### 废案_12：梦.txt")).toBe(12);
  });
  it("returns null for legacy unnumbered and non-废案 names", () => {
    expect(feianFileIndex("### 废案：legacy.txt")).toBeNull();
    expect(feianFileIndex("### 记录_03：c.txt")).toBeNull();
    expect(feianFileIndex("EnvSet.txt")).toBeNull();
  });
});

describe("countFeianFiles", () => {
  it("counts numbered + legacy 废案 .txt files, ignoring everything else", () => {
    expect(
      countFeianFiles([
        "### 废案_00：a.txt",
        "### 废案_06：b.txt",
        "### 废案：legacy.txt",
        "### 记录_03：c.txt",
        "EnvSet.txt",
        "HertaBio.txt",
        "openings",
      ]),
    ).toBe(3);
  });
});

describe("pickEvictableSeedFile (M-feian-1)", () => {
  const SEEDS = [
    "### 废案_00：锚点.txt",
    "### 废案_01：别人甲.txt",
    "### 废案_02：别人乙.txt",
    "### 废案_03：种子丙.txt",
    "### 废案_04：种子丁.txt",
    "### 废案_05：种子戊.txt",
    "### 废案_06：种子己.txt",
    "### 废案_07：梦一.txt",
  ];
  const noDreams = new Set<string>();

  it("picks the highest-NN seed in the evictable band first (06 → 03)", () => {
    expect(pickEvictableSeedFile(SEEDS, noDreams, 2, 6)).toBe(
      "### 废案_06：种子己.txt",
    );
    const without06 = SEEDS.filter((f) => !f.startsWith("### 废案_06"));
    expect(pickEvictableSeedFile(without06, noDreams, 2, 6)).toBe(
      "### 废案_05：种子戊.txt",
    );
  });

  it("never returns protected anchors (≤ protectedMaxNN), files above the band, or legacy names", () => {
    const onlyProtected = [
      "### 废案_00：锚点.txt",
      "### 废案_01：别人甲.txt",
      "### 废案_02：别人乙.txt",
      "### 废案：legacy.txt",
      "### 废案_30：手写新篇.txt", // hand-authored above the band — D7 stance holds
    ];
    expect(
      pickEvictableSeedFile(onlyProtected, noDreams, 2, 6),
    ).toBeUndefined();
  });

  it("skips a live dream record even when its NN reuses a band number", () => {
    // After 06 is evicted, nextFeianIndex can hand NN 06 to a NEW dream —
    // the manifest guard must keep it out of seed eviction.
    const files = ["### 废案_03：种子丙.txt", "### 废案_06：梦二.txt"];
    const live = new Set(["### 废案_06：梦二.txt"]);
    expect(pickEvictableSeedFile(files, live, 2, 6)).toBe(
      "### 废案_03：种子丙.txt",
    );
  });
});
