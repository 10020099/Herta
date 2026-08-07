import { describe, expect, it } from "vitest";
import type { WikiPage } from "../schema.js";
import { renderWikiPage } from "./render-wiki-page.js";

const emptyPage: WikiPage = {
  entityId: "herta.person.prime",
  entityType: "person",
  canonicalName: "大黑塔",
  aliases: [],
  relationships: [],
  attributes: [],
  voiceEvidence: [],
  uncertainClaims: [],
  claimIds: [],
  sourceChunkIds: [],
  generatedAt: "2026-05-08T00:00:00.000Z",
};

describe("renderWikiPage", () => {
  it("renders all sections when populated", () => {
    const page: WikiPage = {
      ...emptyPage,
      description: "Genius Society #83. The real (prime) Herta.",
      aliases: [
        { alias: "大黑塔", lang: "zh", priority: 100 },
        { alias: "Herta (prime)", lang: "en", priority: 50 },
      ],
      relationships: [
        {
          claimId: "claim:r1",
          predicate: "member_of",
          targetEntityId: "faction.genius_society",
          targetCanonicalName: "天才俱乐部",
          confidence: 0.95,
          method: "deterministic",
          evidenceChunkIds: ["c1", "c2"],
        },
      ],
      attributes: [
        {
          claimId: "claim:a1",
          predicate: "member_number",
          value: "#83",
          confidence: 0.9,
          method: "llm",
          evidenceChunkIds: ["c3"],
        },
      ],
      voiceEvidence: [
        {
          chunkId: "c10",
          documentTitle: "天才群星闪耀时",
          sectionPath: ["剧情内容", "与黑塔交谈"],
          text: "本人远程操纵此处的人偶。",
        },
      ],
      uncertainClaims: [
        {
          claimId: "claim:u1",
          predicate: "associated_with",
          targetEntityId: "project.simulated_universe",
          targetCanonicalName: "模拟宇宙",
          confidence: 0.4,
          method: "llm",
          reason: "low confidence",
        },
      ],
    };
    const out = renderWikiPage(page);
    expect(out).toContain('<entity-wiki id="herta.person.prime"');
    expect(out).toContain('type="person"');
    expect(out).toContain('canonical="大黑塔"');
    expect(out).toContain("<description>");
    expect(out).toContain('<aliases count="2">');
    expect(out).toContain('<alias lang="zh" priority="100">大黑塔</alias>');
    expect(out).toContain('<relationships count="1">');
    expect(out).toContain('predicate="member_of"');
    expect(out).toContain('target="天才俱乐部"');
    expect(out).toContain('target-id="faction.genius_society"');
    expect(out).toContain('<attributes count="1">');
    expect(out).toContain('predicate="member_number"');
    expect(out).toContain('value="#83"');
    expect(out).toContain('<voice-evidence count="1">');
    expect(out).toContain("本人远程操纵此处的人偶");
    expect(out).toContain('<uncertain-claims count="1">');
    expect(out).toContain('reason="low confidence"');
    expect(out).toContain("</entity-wiki>");
  });

  it("skips empty sections cleanly", () => {
    const out = renderWikiPage(emptyPage);
    expect(out).toContain('<entity-wiki id="herta.person.prime"');
    expect(out).toContain("</entity-wiki>");
    expect(out).not.toContain("<aliases");
    expect(out).not.toContain("<relationships");
    expect(out).not.toContain("<attributes");
    expect(out).not.toContain("<voice-evidence");
    expect(out).not.toContain("<uncertain-claims");
    expect(out).not.toContain("<description>");
    expect(out).not.toContain('count="0"');
  });

  it("includes claim ids and chunk ids in evidence attributes", () => {
    const page: WikiPage = {
      ...emptyPage,
      relationships: [
        {
          claimId: "claim:rel-xyz",
          predicate: "owns",
          targetEntityId: "herta.place.space_station",
          targetCanonicalName: "空间站「黑塔」",
          confidence: 1.0,
          method: "deterministic",
          evidenceChunkIds: ["chunk:42", "chunk:43"],
        },
      ],
      attributes: [
        {
          claimId: "claim:attr-abc",
          predicate: "member_number",
          value: "#83",
          confidence: 1.0,
          method: "deterministic",
          evidenceChunkIds: ["chunk:7"],
        },
      ],
    };
    const out = renderWikiPage(page);
    expect(out).toContain('claim-id="claim:rel-xyz"');
    expect(out).toContain("[evidence chunkIds: chunk:42, chunk:43]");
    expect(out).toContain('claim-id="claim:attr-abc"');
    expect(out).toContain("[evidence chunkIds: chunk:7]");
  });

  it("caps voice-evidence at 3 chunks and notes the truncation", () => {
    const page: WikiPage = {
      ...emptyPage,
      voiceEvidence: [
        {
          chunkId: "v1",
          documentTitle: "T1",
          sectionPath: ["A"],
          text: "one",
        },
        {
          chunkId: "v2",
          documentTitle: "T2",
          sectionPath: ["B"],
          text: "two",
        },
        {
          chunkId: "v3",
          documentTitle: "T3",
          sectionPath: ["C"],
          text: "three",
        },
        {
          chunkId: "v4",
          documentTitle: "T4",
          sectionPath: ["D"],
          text: "four",
        },
        {
          chunkId: "v5",
          documentTitle: "T5",
          sectionPath: ["E"],
          text: "five",
        },
      ],
    };
    const out = renderWikiPage(page);
    expect(out).toContain('<voice-evidence count="3" truncated="2">');
    expect(out).toContain('id="v1"');
    expect(out).toContain('id="v2"');
    expect(out).toContain('id="v3"');
    expect(out).not.toContain('id="v4"');
    expect(out).not.toContain('id="v5"');
  });

  it("escapes XML-unsafe characters in alias, description, and text", () => {
    const page: WikiPage = {
      ...emptyPage,
      description: 'A & B "x" <tag>',
      aliases: [{ alias: '<bad>&"alias"', lang: "zh", priority: 10 }],
      voiceEvidence: [
        {
          chunkId: "vx",
          documentTitle: 'Doc & "Co"',
          sectionPath: ["S<1>"],
          text: "<script>alert(1)</script>",
        },
      ],
    };
    const out = renderWikiPage(page);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&lt;bad&gt;");
    expect(out).toContain("&amp;");
    expect(out).toContain("A &amp; B");
    // Document title attr is escaped
    expect(out).toContain('source="Doc &amp; &quot;Co&quot;"');
    expect(out).toContain('section="S&lt;1&gt;"');
  });
});
