import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROMPT_ASSETS, PROMPT_ASSETS_EN } from "./prompt-assets.generated.js";
import { materializeSeedFeian } from "./seed-feian.js";

describe("materializeSeedFeian (M-prompts-1)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "herta-seed-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const narrativeDir = () => join(root, ".herta", "narrative");

  it("writes all compiled seeds into a fresh workspace (creating the dir)", async () => {
    await materializeSeedFeian(root);
    const files = readdirSync(narrativeDir());
    for (const name of Object.keys(PROMPT_ASSETS.feianSeeds)) {
      expect(files).toContain(name);
    }
    expect(Object.keys(PROMPT_ASSETS.feianSeeds).length).toBe(8);
  });

  it("is idempotent — a second call changes nothing", async () => {
    await materializeSeedFeian(root);
    const before = readdirSync(narrativeDir()).sort();
    await materializeSeedFeian(root);
    expect(readdirSync(narrativeDir()).sort()).toEqual(before);
  });

  it("adds missing seeds to a LIVING workspace, but never resurrects archived ones (2026-07-19)", async () => {
    // A workspace whose memory lifecycle has begun: one dream-era 废案 live,
    // one seed legitimately cap-evicted into the dream archive. A newly-
    // shipped seed must still arrive; the evicted one must stay evicted.
    mkdirSync(narrativeDir(), { recursive: true });
    writeFileSync(
      join(narrativeDir(), "### 废案_12：某个梦.txt"),
      "### 废案_12：某个梦\n正文。\n\n---\n\n（我 说）\n嗯。\n（/我 说）\n",
      "utf-8",
    );
    const seedNames = Object.keys(PROMPT_ASSETS.feianSeeds);
    const evicted = seedNames[3] as string; // an evictable seed example
    const archiveDir = join(root, ".herta", "dream", "archive");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, evicted), "archived body", "utf-8");

    await materializeSeedFeian(root);
    const files = readdirSync(narrativeDir());
    // The dream-era page is untouched, every non-archived seed arrived...
    expect(files).toContain("### 废案_12：某个梦.txt");
    for (const name of seedNames) {
      if (name === evicted) continue;
      expect(files).toContain(name);
    }
    // ...and the evicted seed was NOT resurrected.
    expect(files).not.toContain(evicted);
  });

  it('lang: "en" materializes the EN seeds into narrative-en, leaving the zh dir untouched', async () => {
    // Per-language corpora (EN-dream slice): EN seeds its OWN
    // `.herta/narrative-en` dir, wholly isolated from the zh `.herta/narrative`
    // — no more shared-dir mixing, so EN now grows real on-disk memory.
    await materializeSeedFeian(root, "en");
    const enDir = join(root, ".herta", "narrative-en");
    const files = readdirSync(enDir);
    for (const name of Object.keys(PROMPT_ASSETS_EN.feianSeeds)) {
      expect(files).toContain(name);
    }
    expect(existsSync(narrativeDir())).toBe(false); // zh dir never created
  });

  it("seeding one language never touches the other's corpus (separate dirs)", async () => {
    await materializeSeedFeian(root, "zh");
    const [name] = Object.keys(PROMPT_ASSETS.feianSeeds);
    const before = readFileSync(join(narrativeDir(), name as string), "utf-8");
    await materializeSeedFeian(root, "en"); // writes to narrative-en, not narrative
    const after = readFileSync(join(narrativeDir(), name as string), "utf-8");
    expect(after).toBe(before); // zh seeds untouched — no mixing
  });
});
