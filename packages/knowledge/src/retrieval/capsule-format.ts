import type { ContextCapsule } from "@herta/core";
import type { WikiPage } from "../schema.js";
import {
  type EntityCandidate,
  formatDisambiguationBlock,
} from "./disambiguate.js";
import type { LoreSearchResult } from "./lore-search.js";
import { renderWikiPage } from "./render-wiki-page.js";
import { xmlAttr, xmlText } from "./xml-escape.js";

export interface FormatLoreCapsuleOptions {
  queryId: string;
  /** Default 800 — small per-turn lore budget per Phase 2A spec note. */
  maxTokens?: number;
  /** URI of the local DB; defaults to the canonical path. */
  dbUri?: string;
  disambiguation?: {
    alias: string;
    candidates: ReadonlyArray<EntityCandidate>;
  };
  /**
   * Structured wiki pages for entities relevant to the query (typically the
   * candidates of {@link disambiguation} or an explicit entity-id filter).
   * Rendered between the disambiguation block and the retrieved-lore block.
   */
  wikiPages?: ReadonlyArray<WikiPage>;
}

const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_DB_URI = ".herta/knowledge/herta-canon.sqlite";

export function formatLoreCapsule(
  results: ReadonlyArray<LoreSearchResult>,
  opts: FormatLoreCapsuleOptions,
): ContextCapsule {
  const disambiguationBlock =
    opts.disambiguation !== undefined
      ? formatDisambiguationBlock(
          opts.disambiguation.alias,
          opts.disambiguation.candidates,
        )
      : "";
  const wikiBlock =
    opts.wikiPages !== undefined && opts.wikiPages.length > 0
      ? renderWikiPagesBlock(opts.wikiPages)
      : "";
  const loreBlock = renderRetrievedLore(results);
  const content = [disambiguationBlock, wikiBlock, loreBlock]
    .filter((s) => s.length > 0)
    .join("\n");
  return {
    id: `lore.retrieved.${opts.queryId}`,
    type: "lore",
    source: {
      kind: "built_in",
      uri: opts.dbUri ?? DEFAULT_DB_URI,
      trust: "validated",
    },
    content,
    activation: { mode: "always" },
    priority: 50,
    insertionLayer: "retrieved_lore",
    tokenBudget: {
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      overflow: "drop",
    },
    conflictGroup: "herta_lore_retrieval",
    deterministic: true,
    enabled: true,
  };
}

function renderWikiPagesBlock(pages: ReadonlyArray<WikiPage>): string {
  const parts: string[] = [`<entity-wikis count="${pages.length}">`];
  for (const p of pages) {
    parts.push(renderWikiPage(p));
  }
  parts.push(`</entity-wikis>`);
  return parts.join("\n");
}

function renderRetrievedLore(results: ReadonlyArray<LoreSearchResult>): string {
  const parts: string[] = [`<retrieved-lore count="${results.length}">`];
  for (const r of results) {
    const sourceAttr = xmlAttr(r.path);
    const titleAttr = xmlAttr(r.documentTitle);
    const sectionAttr = r.sectionPath.map(xmlAttr).join(" > ");
    const speakerAttr =
      r.speaker !== undefined ? ` speaker="${xmlAttr(r.speaker)}"` : "";
    const entitiesAttr = xmlAttr(r.matchedEntities.join(","));
    const escapedText = xmlText(r.text);
    parts.push(
      `  <lore source="${sourceAttr}" title="${titleAttr}" section="${sectionAttr}"${speakerAttr} entities="${entitiesAttr}">`,
    );
    parts.push(`  ${escapedText}`);
    parts.push(`  </lore>`);
  }
  parts.push(`</retrieved-lore>`);
  return parts.join("\n");
}
