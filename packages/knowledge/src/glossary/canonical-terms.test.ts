import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CANONICAL_TERMS, canonicalTermFor } from "./canonical-terms.js";
import {
  loadTextMap,
  TEXTMAP_CN_FILENAME,
  TEXTMAP_EN_FILENAME,
} from "./textmap-glossary.js";

describe("CANONICAL_TERMS", () => {
  it("has unique CN keys, non-empty EN values, and evidence hashes", () => {
    const seen = new Set<string>();
    for (const t of CANONICAL_TERMS) {
      expect(seen.has(t.cn), `duplicate cn: ${t.cn}`).toBe(false);
      seen.add(t.cn);
      expect(t.en.length).toBeGreaterThan(0);
      expect(t.evidenceHash).toMatch(/^\d+$/);
    }
  });

  it("canonicalTermFor finds exact CN entries only", () => {
    expect(canonicalTermFor("大黑塔")?.en).toBe("The Herta");
    expect(canonicalTermFor("大黑塔本人")).toBeUndefined();
  });

  // Evidence audit — runs only where the (gitignored) TextMap corpus is
  // present: every evidenceHash must exist in BOTH maps, its CN line must
  // contain the term, and its EN line must contain the translation (case-
  // insensitive; "the cosmos" is witnessed by a "Cosmos" line). CI has no
  // corpus and skips; a local run with a refreshed corpus re-audits all.
  const repoRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
  );
  const textmapDir = join(repoRoot, "data", "textmap");
  it.skipIf(!existsSync(join(textmapDir, TEXTMAP_CN_FILENAME)))(
    "every evidence hash witnesses its translation in the real TextMaps",
    () => {
      const cn = loadTextMap(join(textmapDir, TEXTMAP_CN_FILENAME));
      const en = loadTextMap(join(textmapDir, TEXTMAP_EN_FILENAME));
      for (const t of CANONICAL_TERMS) {
        const cnLine = cn[t.evidenceHash];
        const enLine = en[t.evidenceHash];
        expect(
          cnLine,
          `hash ${t.evidenceHash} missing in CN map`,
        ).toBeDefined();
        expect(
          enLine,
          `hash ${t.evidenceHash} missing in EN map`,
        ).toBeDefined();
        expect(cnLine, `CN line for ${t.cn}`).toContain(t.cn);
        expect(
          (enLine ?? "").toLowerCase(),
          `EN line for ${t.cn} should witness "${t.en}"`,
        ).toContain(t.en.toLowerCase().replace(/^the /, ""));
      }
    },
    // Parses ~100MB of TextMap JSON; slow under full-suite worker load.
    30_000,
  );
});
