import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dreamDirFor, narrativeDirFor } from "@herta/core";
import { promptAssetsFor } from "./prompt-assets.js";
import type { PromptLang } from "./prompt-lang.js";

/**
 * Materialize the canonical seed 废案 into a workspace's live narrative
 * dir (M-prompts-1, 2026-07-05).
 *
 * Two-tier prompt storage: identity/instruction prompts ship compiled
 * (`PROMPT_ASSETS`), but the 废案 corpus is LIVING MEMORY — the Dream
 * system writes new 废案 into `<workspace>/.herta/narrative/` and
 * cap-eviction archives them — so the live set must stay file-based.
 * This bootstrap gives a FRESH workspace its starting memory: the
 * compiled seed files are written verbatim, once.
 *
 * Materialization is PER FILE, guarded against resurrection (2026-07-19,
 * seed-07 rollout): a seed is written only when it is absent from the
 * live narrative dir AND absent from the dream archive. A bare per-file
 * existence check would RESURRECT seeds the cap-eviction legitimately
 * archived (seed-examples-first, M-feian-1); the old any-废案-present
 * guard avoided that but also meant a NEWLY-SHIPPED seed could never
 * reach an existing workspace — the archive check keeps both properties:
 * evicted seeds stay evicted, new seeds arrive everywhere.
 *
 * Best-effort per file (a failed write logs and continues); the static
 * prefix tolerates a partial corpus.
 *
 * `lang` (slice 4) selects WHICH bundle's seeds materialize AND the
 * per-language narrative dir they land in (`narrative` for zh,
 * `narrative-en` for en) — the two corpora are isolated on disk, so seeding
 * one never touches the other (EN-dream slice). Default "zh", byte-identical.
 * An existing workspace keeps whatever is on disk — the any-废案-present guard
 * fires before the bundle is even consulted, so a language change never
 * re-seeds or mixes corpora mid-lifecycle.
 */
export async function materializeSeedFeian(
  workspaceRoot: string,
  lang: PromptLang = "zh",
): Promise<void> {
  // Per-language dir: EN seeds land in `.herta/narrative-en`, wholly separate
  // from the zh corpus in `.herta/narrative` (which only zh reads/writes). The
  // earlier "EN never materializes" guard existed only because a SINGLE shared
  // dir would have mixed languages — parallel dirs remove that hazard.
  const dir = narrativeDirFor(workspaceRoot, lang);
  const listDir = async (d: string): Promise<string[]> => {
    try {
      return await readdir(d);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT") throw err;
      return [];
    }
  };
  const live = new Set(await listDir(dir));
  // Evicted-seed graveyard: cap-eviction and forgetting move 废案 files
  // into the dream archive. A seed present there was legitimately retired
  // from THIS workspace's memory lifecycle — never resurrect it.
  const archived = new Set(
    await listDir(join(dreamDirFor(workspaceRoot, lang), "archive")),
  );

  const seeds = promptAssetsFor(lang).feianSeeds;
  const missing = Object.entries(seeds).filter(
    ([filename]) => !live.has(filename) && !archived.has(filename),
  );
  if (missing.length === 0) return;

  await mkdir(dir, { recursive: true });
  for (const [filename, body] of missing) {
    try {
      await writeFile(join(dir, filename), body, "utf-8");
    } catch (err) {
      console.warn(
        `materializeSeedFeian: failed to write ${filename}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
