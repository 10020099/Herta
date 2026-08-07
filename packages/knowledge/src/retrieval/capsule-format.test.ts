import { describe, expect, it } from "vitest";
import type { WikiPage } from "../schema.js";
import { formatLoreCapsule } from "./capsule-format.js";
import type { LoreSearchResult } from "./lore-search.js";

const baseResult: LoreSearchResult = {
  chunkId: "c1",
  documentTitle: "天才群星闪耀时",
  documentKind: "mission_dialogue",
  path: "data/plot_html/开拓续闻/001.html",
  url: "https://wiki.example.com/p/1",
  sectionPath: ["剧情内容", "与黑塔交谈"],
  speaker: "黑塔",
  text: "本人远程操纵此处的人偶。",
  score: 100,
  matchedEntities: ["herta.person.prime", "herta.form.doll"],
  evidenceKind: "fts",
};

describe("formatLoreCapsule", () => {
  it("returns a ContextCapsule with type='lore' and retrieved_lore insertion layer", () => {
    const cap = formatLoreCapsule([baseResult], { queryId: "q1" });
    expect(cap.type).toBe("lore");
    expect(cap.insertionLayer).toBe("retrieved_lore");
    expect(cap.deterministic).toBe(true);
    expect(cap.source.trust).toBe("validated");
    expect(cap.source.kind).toBe("built_in");
    expect(cap.activation.mode).toBe("always");
    expect(cap.conflictGroup).toBe("herta_lore_retrieval");
    expect(cap.enabled).toBe(true);
    expect(cap.id).toContain("q1");
  });

  it("renders <retrieved-lore> with a <lore> per result, including citation attrs", () => {
    const cap = formatLoreCapsule([baseResult], { queryId: "q1" });
    expect(cap.content).toContain("<retrieved-lore");
    expect(cap.content).toContain('count="1"');
    expect(cap.content).toContain('source="data/plot_html/开拓续闻/001.html"');
    expect(cap.content).toContain('title="天才群星闪耀时"');
    expect(cap.content).toContain('section="剧情内容 > 与黑塔交谈"');
    expect(cap.content).toContain('speaker="黑塔"');
    expect(cap.content).toContain("herta.person.prime,herta.form.doll");
    expect(cap.content).toContain("本人远程操纵此处的人偶");
  });

  it("returns an empty count=0 capsule when results is empty", () => {
    const cap = formatLoreCapsule([], { queryId: "q-empty" });
    expect(cap.content).toContain('count="0"');
    expect(cap.tokenBudget.maxTokens).toBeGreaterThan(0);
  });

  it("escapes XML-special characters in text and titles", () => {
    const cap = formatLoreCapsule(
      [
        {
          ...baseResult,
          text: "<script>alert(1)</script>",
          documentTitle: 'A & B "x"',
        },
      ],
      { queryId: "q1" },
    );
    expect(cap.content).not.toContain("<script>");
    expect(cap.content).toContain("&lt;script&gt;");
    expect(cap.content).toContain("A &amp; B &quot;x&quot;");
  });

  it("sets a token budget capped at 800", () => {
    const cap = formatLoreCapsule([baseResult], { queryId: "q1" });
    expect(cap.tokenBudget.maxTokens).toBeLessThanOrEqual(800);
    expect(cap.tokenBudget.overflow).toBe("drop");
  });

  it("prepends a disambiguation block when 2+ candidates are provided", () => {
    const cap = formatLoreCapsule([baseResult], {
      queryId: "q1",
      disambiguation: {
        alias: "黑塔",
        candidates: [
          {
            entityId: "herta.person.prime",
            canonicalName: "大黑塔",
            type: "person",
          },
          {
            entityId: "herta.form.doll",
            canonicalName: "小黑塔",
            type: "manifestation",
          },
        ],
      },
    });
    expect(cap.content).toContain('<canon-disambiguation alias="黑塔">');
    expect(cap.content).toContain("<retrieved-lore");
    const disambIdx = cap.content.indexOf("<canon-disambiguation");
    const loreIdx = cap.content.indexOf("<retrieved-lore");
    expect(disambIdx).toBeGreaterThanOrEqual(0);
    expect(disambIdx).toBeLessThan(loreIdx);
  });

  it("omits disambiguation when only 1 candidate is provided", () => {
    const cap = formatLoreCapsule([baseResult], {
      queryId: "q1",
      disambiguation: {
        alias: "天才俱乐部",
        candidates: [
          {
            entityId: "faction.genius_society",
            canonicalName: "天才俱乐部",
            type: "faction",
          },
        ],
      },
    });
    expect(cap.content).not.toContain("<canon-disambiguation");
    expect(cap.content).toContain("<retrieved-lore");
  });

  it("preserves back-compat: no disambiguation option means no block", () => {
    const cap = formatLoreCapsule([baseResult], { queryId: "q1" });
    expect(cap.content).not.toContain("<canon-disambiguation");
    expect(cap.content).toContain("<retrieved-lore");
  });

  it("includes an <entity-wikis> block when wikiPages is non-empty", () => {
    const page: WikiPage = {
      entityId: "herta.person.prime",
      entityType: "person",
      canonicalName: "大黑塔",
      description: "Genius Society #83.",
      aliases: [],
      relationships: [],
      attributes: [],
      voiceEvidence: [],
      uncertainClaims: [],
      claimIds: [],
      sourceChunkIds: [],
      generatedAt: "2026-05-08T00:00:00.000Z",
    };
    const cap = formatLoreCapsule([baseResult], {
      queryId: "q1",
      wikiPages: [page],
    });
    expect(cap.content).toContain('<entity-wikis count="1">');
    expect(cap.content).toContain('<entity-wiki id="herta.person.prime"');
    expect(cap.content).toContain("Genius Society #83.");
    // Ordering: wiki block precedes retrieved-lore block.
    const wikiIdx = cap.content.indexOf("<entity-wikis");
    const loreIdx = cap.content.indexOf("<retrieved-lore");
    expect(wikiIdx).toBeGreaterThanOrEqual(0);
    expect(wikiIdx).toBeLessThan(loreIdx);
  });

  it("omits the <entity-wikis> block when wikiPages is undefined or empty", () => {
    const noOpt = formatLoreCapsule([baseResult], { queryId: "q1" });
    expect(noOpt.content).not.toContain("<entity-wikis");
    const emptyArr = formatLoreCapsule([baseResult], {
      queryId: "q1",
      wikiPages: [],
    });
    expect(emptyArr.content).not.toContain("<entity-wikis");
  });
});
