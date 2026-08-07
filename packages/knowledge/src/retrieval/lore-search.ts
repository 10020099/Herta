import type { CanonDocumentKind } from "../schema.js";
import type { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";

export interface LoreSearchQuery {
  query: string;
  entityIds?: ReadonlyArray<string>;
  kinds?: ReadonlyArray<CanonDocumentKind>;
  mode?: "canon" | "voice" | "exact" | "graph";
  limit?: number;
  matchedAlias?: string;
}

export interface LoreSearchResult {
  chunkId: string;
  documentTitle: string;
  documentKind: string;
  path: string;
  url?: string;
  sectionPath: string[];
  speaker?: string;
  text: string;
  score: number;
  matchedEntities: ReadonlyArray<string>;
  evidenceKind: "exact" | "fts" | "entity" | "graph" | "vector";
}

const DEFAULT_LIMIT = 10;

interface FtsRow {
  chunkId: string;
  rank: number;
}

export function searchLore(
  store: SqliteKnowledgeStore,
  query: LoreSearchQuery,
): LoreSearchResult[] {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const fetchCount = Math.max(limit * 4, 20);

  // Try FTS first; fall back to LIKE-on-chunks if FTS returns nothing.
  // FTS5 unicode61 tokenizer treats CJK runs as single tokens, so substring
  // queries on Chinese text require a LIKE-based scan.
  let ftsHits = store.searchFts(query.query, fetchCount);
  if (ftsHits.length === 0) {
    const likeParam = `%${query.query}%`;
    const likeRows = store.rawAll<FtsRow>(
      `SELECT c.id AS chunkId, 0.0 AS rank
       FROM chunks c
       WHERE c.text LIKE ? OR c.section_path LIKE ? OR c.speaker LIKE ?
       LIMIT ?`,
      likeParam,
      likeParam,
      likeParam,
      fetchCount,
    );
    ftsHits = likeRows;
  }

  const results: LoreSearchResult[] = [];
  for (const hit of ftsHits) {
    const cwd = store.getChunkWithDocument(hit.chunkId);
    if (cwd === undefined) continue;
    if (
      query.kinds !== undefined &&
      !query.kinds.includes(cwd.document.kind as CanonDocumentKind)
    ) {
      continue;
    }
    const mentions = store.rawAll<{
      referent: string;
      embodiment: string | null;
    }>(
      "SELECT referent_entity_id AS referent, embodiment_entity_id AS embodiment FROM entity_mentions WHERE chunk_id = ?",
      hit.chunkId,
    );
    const matchedEntities = new Set<string>();
    for (const m of mentions) {
      matchedEntities.add(m.referent);
      if (m.embodiment !== null) matchedEntities.add(m.embodiment);
    }
    if (query.entityIds !== undefined && query.entityIds.length > 0) {
      const wanted = new Set(query.entityIds);
      let any = false;
      for (const id of matchedEntities) {
        if (wanted.has(id)) {
          any = true;
          break;
        }
      }
      if (!any) continue;
    }
    results.push({
      chunkId: hit.chunkId,
      documentTitle: cwd.document.title,
      documentKind: cwd.document.kind,
      path: cwd.document.path,
      url: cwd.document.url,
      sectionPath: cwd.chunk.sectionPath,
      speaker: cwd.chunk.speaker,
      text: cwd.chunk.text,
      score: -hit.rank, // bm25 returns lower-is-better; negate so higher-is-better.
      matchedEntities: Array.from(matchedEntities),
      evidenceKind: "fts",
    });
  }
  rerank(results, query.mode ?? "canon", store);
  return results.slice(0, limit);
}

function rerank(
  results: LoreSearchResult[],
  mode: "canon" | "voice" | "exact" | "graph",
  store: SqliteKnowledgeStore,
): void {
  // Perf (arch audit 2026-07-15): compute each candidate's mode score
  // ONCE before sorting. The previous comparator called `modeScore` per
  // COMPARISON, re-running the voice-flag DB query O(n log n) times per
  // voice-mode search. Ordering is identical — the comparator consumes
  // the same per-candidate scores, just precomputed.
  const scores = new Map<LoreSearchResult, number>();
  for (const r of results) {
    scores.set(r, modeScore(r, mode, store));
  }
  results.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
}

function modeScore(
  r: LoreSearchResult,
  mode: "canon" | "voice" | "exact" | "graph",
  store: SqliteKnowledgeStore,
): number {
  let score = r.score;
  if (mode === "voice") {
    const voiceFlag = store.rawAll<{ v: number }>(
      "SELECT is_herta_voice_evidence AS v FROM chunks WHERE id = ?",
      r.chunkId,
    );
    if (voiceFlag[0]?.v === 1) score += 100;
    if (
      r.documentKind === "mission_dialogue" ||
      r.documentKind === "simulated_universe"
    )
      score += 25;
    if (r.documentKind === "book_readable") score += 10;
  } else {
    if (r.documentKind === "character_profile") score += 50;
    if (r.documentKind === "world_lore") score += 30;
    if (r.documentKind === "book_readable") score += 15;
  }
  return score;
}
