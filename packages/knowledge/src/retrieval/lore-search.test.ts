import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HERTA_PERSON_PRIME } from "../schema.js";
import {
  mkTempKnowledgeDb,
  type TempDb,
} from "../testing/mk-temp-knowledge-db.js";
import { searchLore } from "./lore-search.js";

describe("searchLore", () => {
  let h: TempDb;
  beforeEach(() => {
    h = mkTempKnowledgeDb();
    h.store.upsertDocument({
      id: "d1",
      kind: "mission_dialogue",
      title: "Mission",
      path: "data/plot_html/m.html",
      sourceHash: "h",
      createdAt: new Date().toISOString(),
    });
    h.store.upsertDocument({
      id: "d2",
      kind: "world_lore",
      title: "Lore",
      path: "data/星海纪闻/l.html",
      sourceHash: "h",
      createdAt: new Date().toISOString(),
    });
    h.store.insertChunk({
      id: "c-voice",
      documentId: "d1",
      ordinal: 0,
      sectionPath: ["剧情内容", "与黑塔交谈"],
      speaker: "黑塔",
      text: "你以为这种事我会感兴趣？",
      textHash: "h1",
      tokenEstimate: 5,
      isDialogue: true,
      isHertaVoiceEvidence: true,
      isCanonFactCandidate: false,
      qualityScore: 0.8,
    });
    h.store.insertChunk({
      id: "c-fact",
      documentId: "d2",
      ordinal: 0,
      sectionPath: ["简介"],
      text: "黑塔是天才俱乐部成员。",
      textHash: "h2",
      tokenEstimate: 5,
      isDialogue: false,
      isHertaVoiceEvidence: false,
      isCanonFactCandidate: true,
      qualityScore: 0.5,
    });
    h.store.insertMention({
      id: "m1",
      chunkId: "c-voice",
      surface: "黑塔",
      referentEntityId: HERTA_PERSON_PRIME,
      speakerEntityId: HERTA_PERSON_PRIME,
      confidence: 0.85,
      method: "deterministic",
    });
  });
  afterEach(() => h.cleanup());

  it("returns FTS hits with chunk metadata", () => {
    const out = searchLore(h.store, { query: "天才俱乐部", limit: 10 });
    expect(out.length).toBeGreaterThanOrEqual(1);
    const hit = out.find((r) => r.chunkId === "c-fact");
    expect(hit?.text).toContain("天才俱乐部");
    expect(hit?.documentTitle).toBe("Lore");
    expect(hit?.evidenceKind).toBe("fts");
  });

  it("voice mode prioritizes herta-voice-evidence chunks over general lore", () => {
    h.store.insertChunk({
      id: "c-voice2",
      documentId: "d1",
      ordinal: 1,
      sectionPath: [],
      text: "天才俱乐部什么都不算。",
      textHash: "h3",
      tokenEstimate: 5,
      isDialogue: true,
      isHertaVoiceEvidence: true,
      isCanonFactCandidate: false,
      qualityScore: 0.7,
    });
    const out = searchLore(h.store, {
      query: "天才俱乐部",
      mode: "voice",
      limit: 5,
    });
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0]?.evidenceKind).toBeDefined();
    const indexOfVoice = out.findIndex((r) => r.chunkId === "c-voice2");
    const indexOfFact = out.findIndex((r) => r.chunkId === "c-fact");
    expect(indexOfVoice).toBeGreaterThanOrEqual(0);
    if (indexOfFact >= 0) {
      expect(indexOfVoice).toBeLessThan(indexOfFact);
    }
  });

  it("voice-mode rerank orders many candidates by precomputed score (comparator hoist, audit 2026-07-15)", () => {
    // Four matching chunks with distinct score profiles so the sort has
    // to order >2 candidates. All hit the LIKE fallback (CJK substring),
    // so base scores tie at 0 and the ordering is purely bonus-driven:
    //   voice + mission_dialogue (125) > voice + world_lore (100)
    //   > book_readable (10) > plain world_lore (0).
    // The scores are now computed once per candidate BEFORE the sort;
    // this pins the ordering the per-comparison DB queries used to give.
    h.store.upsertDocument({
      id: "d3",
      kind: "book_readable",
      title: "Book",
      path: "data/book/b.html",
      sourceHash: "h",
      createdAt: new Date().toISOString(),
    });
    const mk = (
      id: string,
      documentId: string,
      isVoice: boolean,
      ordinal: number,
    ) => {
      h.store.insertChunk({
        id,
        documentId,
        ordinal,
        sectionPath: [],
        text: `评分排序测试 ${id}`,
        textHash: `hh-${id}`,
        tokenEstimate: 5,
        isDialogue: isVoice,
        isHertaVoiceEvidence: isVoice,
        isCanonFactCandidate: !isVoice,
        qualityScore: 0.5,
      });
    };
    // Inserted in a shuffled order relative to the expected ranking.
    mk("rank-plain", "d2", false, 10); // world_lore, no voice → 0
    mk("rank-top", "d1", true, 10); // mission_dialogue + voice → 125
    mk("rank-book", "d3", false, 10); // book_readable → 10
    mk("rank-voice", "d2", true, 11); // world_lore + voice → 100
    const out = searchLore(h.store, {
      query: "评分排序测试",
      mode: "voice",
      limit: 10,
    });
    const ids = out.map((r) => r.chunkId);
    expect(ids).toEqual(["rank-top", "rank-voice", "rank-book", "rank-plain"]);
  });

  it("entity-filter restricts results to chunks with matching mentions", () => {
    const out = searchLore(h.store, {
      query: "黑塔",
      entityIds: [HERTA_PERSON_PRIME],
      limit: 10,
    });
    expect(
      out.every((r) => r.matchedEntities.includes(HERTA_PERSON_PRIME)),
    ).toBe(true);
    expect(out.find((r) => r.chunkId === "c-voice")).toBeDefined();
  });

  it("respects limit", () => {
    const out = searchLore(h.store, { query: "黑塔", limit: 1 });
    expect(out).toHaveLength(1);
  });

  it("returns empty for queries with no matches", () => {
    const out = searchLore(h.store, {
      query: "完全不存在的查询字符串",
      limit: 10,
    });
    expect(out).toEqual([]);
  });
});
