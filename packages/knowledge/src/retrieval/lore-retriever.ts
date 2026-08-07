import { createHash } from "node:crypto";
import type { ContextCapsule } from "@herta/core";
import type { WikiPage } from "../schema.js";
import type { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";
import { formatLoreCapsule } from "./capsule-format.js";
import {
  type LoreSearchQuery,
  type LoreSearchResult,
  searchLore,
} from "./lore-search.js";

export interface LoreRetrieverOptions {
  store: SqliteKnowledgeStore;
  /** Optional capsule token budget cap, default 800. */
  maxTokens?: number;
  /** Optional override for the source URI in capsule metadata. */
  dbUri?: string;
}

export class LoreRetriever {
  private readonly store: SqliteKnowledgeStore;
  private readonly maxTokens?: number;
  private readonly dbUri?: string;

  constructor(opts: LoreRetrieverOptions) {
    this.store = opts.store;
    this.maxTokens = opts.maxTokens;
    this.dbUri = opts.dbUri;
  }

  /** Returns the raw search results without capsule wrapping. */
  search(query: LoreSearchQuery): LoreSearchResult[] {
    return searchLore(this.store, query);
  }

  /** Returns a ContextCapsule wrapping the search results. */
  retrieve(query: LoreSearchQuery): ContextCapsule {
    const results = this.search(query);
    const queryId = createHash("sha1")
      .update(JSON.stringify(query))
      .digest("hex")
      .slice(0, 12);

    // Determine which entity IDs are relevant for wiki-page lookup. The
    // matchedAlias path is the primary one — that's how runtime lore queries
    // arrive. The explicit entityIds path is for callers that already know
    // the resolution.
    const candidateEntityIds = this.findCandidateEntityIds(query);

    const wikiPages: WikiPage[] = [];
    for (const id of candidateEntityIds) {
      // Defensive: skip any ambiguous-sentinel ids. resolveAmbiguousAlias
      // already filters these for ambiguous aliases, but a caller-supplied
      // entityIds list might contain one.
      if (id.endsWith(".ambiguous")) continue;
      const wiki = this.store.getWikiPage(id);
      if (wiki !== undefined) wikiPages.push(wiki);
    }

    const candidates =
      query.matchedAlias !== undefined
        ? this.store.resolveAmbiguousAlias(query.matchedAlias)
        : [];

    return formatLoreCapsule(results, {
      queryId,
      maxTokens: this.maxTokens,
      dbUri: this.dbUri,
      disambiguation:
        query.matchedAlias !== undefined
          ? { alias: query.matchedAlias, candidates }
          : undefined,
      wikiPages,
    });
  }

  /**
   * Returns the set of entity IDs whose wiki pages should be attached to the
   * capsule. Resolution order:
   *   1. If `matchedAlias` is set, use the alias resolver (handles both
   *      ambiguous and non-ambiguous aliases — non-ambiguous yields one
   *      candidate, ambiguous yields all referents).
   *   2. Otherwise, if `entityIds` is provided, use it verbatim.
   *   3. Otherwise, return an empty list.
   */
  private findCandidateEntityIds(query: LoreSearchQuery): string[] {
    if (query.matchedAlias !== undefined) {
      const candidates = this.store.resolveAmbiguousAlias(query.matchedAlias);
      return candidates.map((c) => c.entityId);
    }
    if (query.entityIds !== undefined && query.entityIds.length > 0) {
      return [...query.entityIds];
    }
    return [];
  }
}
