import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WikiPage } from "../schema.js";
import {
  mkTempKnowledgeDb,
  type TempDb,
} from "../testing/mk-temp-knowledge-db.js";
import { LoreRetriever } from "./lore-retriever.js";

function mkWikiPage(
  partial: Partial<WikiPage> & { entityId: string },
): WikiPage {
  return {
    entityType: "person",
    canonicalName: partial.entityId,
    aliases: [],
    relationships: [],
    attributes: [],
    voiceEvidence: [],
    uncertainClaims: [],
    claimIds: [],
    sourceChunkIds: [],
    generatedAt: "2026-05-08T00:00:00.000Z",
    ...partial,
  };
}

describe("LoreRetriever", () => {
  let h: TempDb;
  beforeEach(() => {
    h = mkTempKnowledgeDb();
    h.store.upsertDocument({
      id: "d1",
      kind: "world_lore",
      title: "Lore",
      path: "data/星海纪闻/x.html",
      sourceHash: "h",
      createdAt: new Date().toISOString(),
    });
    h.store.insertChunk({
      id: "c1",
      documentId: "d1",
      ordinal: 0,
      sectionPath: ["简介"],
      text: "黑塔本人是天才俱乐部成员。",
      textHash: "h1",
      tokenEstimate: 5,
      isDialogue: false,
      isHertaVoiceEvidence: false,
      isCanonFactCandidate: true,
      qualityScore: 0.5,
    });
  });
  afterEach(() => h.cleanup());

  it("retrieves matching results and emits a lore capsule", () => {
    const retriever = new LoreRetriever({ store: h.store });
    const cap = retriever.retrieve({ query: "天才俱乐部", limit: 5 });
    expect(cap.type).toBe("lore");
    expect(cap.content).toContain("天才俱乐部");
    expect(cap.content).toContain('count="1"');
  });

  it("emits an empty capsule when no results", () => {
    const retriever = new LoreRetriever({ store: h.store });
    const cap = retriever.retrieve({ query: "完全无关的查询", limit: 5 });
    expect(cap.content).toContain('count="0"');
  });

  it("forwards matchedAlias to the formatter and includes a disambiguation block", () => {
    const h = mkTempKnowledgeDb();
    try {
      const retriever = new LoreRetriever({ store: h.store });
      const cap = retriever.retrieve({
        query: "黑塔",
        mode: "canon",
        matchedAlias: "黑塔",
      });
      expect(cap.content).toContain('<canon-disambiguation alias="黑塔">');
    } finally {
      h.cleanup();
    }
  });

  it("omits disambiguation block when matchedAlias is undefined", () => {
    const h = mkTempKnowledgeDb();
    try {
      const retriever = new LoreRetriever({ store: h.store });
      const cap = retriever.retrieve({ query: "anything", mode: "canon" });
      expect(cap.content).not.toContain("<canon-disambiguation");
    } finally {
      h.cleanup();
    }
  });

  it("includes wiki pages for candidates of an ambiguous matchedAlias", () => {
    h.store.upsertWikiPage(
      mkWikiPage({
        entityId: "herta.person.prime",
        canonicalName: "大黑塔",
        description: "Genius Society #83.",
      }),
    );
    h.store.upsertWikiPage(
      mkWikiPage({
        entityId: "herta.form.doll",
        entityType: "manifestation",
        canonicalName: "小黑塔",
      }),
    );
    const retriever = new LoreRetriever({ store: h.store });
    const cap = retriever.retrieve({
      query: "黑塔",
      mode: "canon",
      matchedAlias: "黑塔",
    });
    expect(cap.content).toContain('<entity-wikis count="');
    expect(cap.content).toContain('id="herta.person.prime"');
    expect(cap.content).toContain('id="herta.form.doll"');
    expect(cap.content).toContain("Genius Society #83.");
    // Block ordering: disambiguation -> wikis -> retrieved-lore.
    const disambIdx = cap.content.indexOf("<canon-disambiguation");
    const wikiIdx = cap.content.indexOf("<entity-wikis");
    const loreIdx = cap.content.indexOf("<retrieved-lore");
    expect(disambIdx).toBeGreaterThanOrEqual(0);
    expect(disambIdx).toBeLessThan(wikiIdx);
    expect(wikiIdx).toBeLessThan(loreIdx);
  });

  it("includes the wiki page for a non-ambiguous matchedAlias", () => {
    h.store.upsertWikiPage(
      mkWikiPage({
        entityId: "person.screwllum",
        canonicalName: "螺丝咕姆",
        description: "Screwllum, Genius Society member.",
      }),
    );
    const retriever = new LoreRetriever({ store: h.store });
    const cap = retriever.retrieve({
      query: "螺丝咕姆",
      mode: "canon",
      matchedAlias: "螺丝咕姆",
    });
    expect(cap.content).toContain('<entity-wikis count="1">');
    expect(cap.content).toContain('id="person.screwllum"');
    expect(cap.content).toContain("Screwllum, Genius Society member.");
  });

  it("renders no entity-wikis block when neither matchedAlias nor entityIds is set", () => {
    h.store.upsertWikiPage(
      mkWikiPage({
        entityId: "herta.person.prime",
        canonicalName: "大黑塔",
      }),
    );
    const retriever = new LoreRetriever({ store: h.store });
    const cap = retriever.retrieve({ query: "anything", mode: "canon" });
    expect(cap.content).not.toContain("<entity-wikis");
  });

  it("skips ambiguous-sentinel entity ids when fetching wiki pages", () => {
    // Defensively upsert a wiki page for the sentinel; retriever must still
    // skip it. resolveAmbiguousAlias also filters, so this guards the
    // entityIds-supplied path.
    h.store.upsertWikiPage(
      mkWikiPage({
        entityId: "herta.name.ambiguous",
        entityType: "ambiguous",
        canonicalName: "黑塔",
      }),
    );
    const retriever = new LoreRetriever({ store: h.store });
    const cap = retriever.retrieve({
      query: "anything",
      mode: "canon",
      entityIds: ["herta.name.ambiguous"],
    });
    expect(cap.content).not.toContain("<entity-wikis");
    expect(cap.content).not.toContain('id="herta.name.ambiguous"');
  });

  it("uses entityIds to fetch wiki pages when matchedAlias is unset", () => {
    h.store.upsertWikiPage(
      mkWikiPage({
        entityId: "person.screwllum",
        canonicalName: "螺丝咕姆",
        description: "Screwllum, Genius Society member.",
      }),
    );
    const retriever = new LoreRetriever({ store: h.store });
    const cap = retriever.retrieve({
      query: "anything",
      mode: "canon",
      entityIds: ["person.screwllum"],
    });
    expect(cap.content).toContain('<entity-wikis count="1">');
    expect(cap.content).toContain('id="person.screwllum"');
  });
});
