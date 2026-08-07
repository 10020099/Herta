import { describe, expect, it } from "vitest";
import {
  type EntityCandidate,
  formatDisambiguationBlock,
} from "./disambiguate.js";

describe("formatDisambiguationBlock", () => {
  it("returns empty string when 0 candidates", () => {
    expect(formatDisambiguationBlock("黑塔", [])).toBe("");
  });

  it("returns empty string when 1 candidate (not ambiguous)", () => {
    const candidates: EntityCandidate[] = [
      {
        entityId: "faction.genius_society",
        canonicalName: "天才俱乐部",
        type: "faction",
      },
    ];
    expect(formatDisambiguationBlock("天才俱乐部", candidates)).toBe("");
  });

  it("renders sorted block when 2+ candidates (person before place)", () => {
    const candidates: EntityCandidate[] = [
      {
        entityId: "herta.place.space_station",
        canonicalName: "空间站「黑塔」",
        type: "place",
      },
      {
        entityId: "herta.person.prime",
        canonicalName: "大黑塔",
        type: "person",
      },
    ];
    const out = formatDisambiguationBlock("黑塔", candidates);
    expect(out).toContain('<canon-disambiguation alias="黑塔">');
    expect(out).toContain("</canon-disambiguation>");
    const personIdx = out.indexOf("herta.person.prime");
    const placeIdx = out.indexOf("herta.place.space_station");
    expect(personIdx).toBeLessThan(placeIdx);
  });

  it("escapes special XML characters in alias and canonical name", () => {
    const candidates: EntityCandidate[] = [
      { entityId: "a", canonicalName: "<one>", type: "x" },
      { entityId: "b", canonicalName: "&two", type: "y" },
    ];
    const out = formatDisambiguationBlock('"quoted"', candidates);
    expect(out).toContain('alias="&quot;quoted&quot;"');
    expect(out).toContain('canonical="&lt;one&gt;"');
    expect(out).toContain('canonical="&amp;two"');
  });
});
