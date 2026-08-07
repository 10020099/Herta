import type { WikiPage } from "../schema.js";
import { xmlAttr, xmlText } from "./xml-escape.js";

/**
 * Cap on how many voice-evidence chunks we render per entity wiki block.
 * Keeps the prompt-context block bounded; the underlying capsule already has
 * a token budget but we don't want a single page to consume it all.
 */
const VOICE_EVIDENCE_RENDER_CAP = 3;

/**
 * Renders a {@link WikiPage} as an XML-ish block suitable for prompt context.
 *
 * Skips empty sections cleanly (no `count="0"` placeholder tags) and escapes
 * XML-unsafe characters in attribute values and text content. Voice evidence
 * is capped at {@link VOICE_EVIDENCE_RENDER_CAP} chunks; remaining chunks are
 * indicated via a `truncated` attribute on the section.
 *
 * Pure: depends only on its input; no I/O, no time, no store access.
 */
export function renderWikiPage(page: WikiPage): string {
  const lines: string[] = [];
  const attrs = [
    `id="${xmlAttr(page.entityId)}"`,
    `type="${xmlAttr(page.entityType)}"`,
    `canonical="${xmlAttr(page.canonicalName)}"`,
  ];
  lines.push(`<entity-wiki ${attrs.join(" ")}>`);

  if (page.description !== undefined && page.description.length > 0) {
    lines.push(`  <description>${xmlText(page.description)}</description>`);
  }

  if (page.aliases.length > 0) {
    lines.push(`  <aliases count="${page.aliases.length}">`);
    for (const a of page.aliases) {
      const langAttr =
        a.lang !== undefined && a.lang.length > 0
          ? ` lang="${xmlAttr(a.lang)}"`
          : "";
      lines.push(
        `    <alias${langAttr} priority="${a.priority}">${xmlText(a.alias)}</alias>`,
      );
    }
    lines.push(`  </aliases>`);
  }

  if (page.relationships.length > 0) {
    lines.push(`  <relationships count="${page.relationships.length}">`);
    for (const r of page.relationships) {
      const evidence =
        r.evidenceChunkIds.length > 0
          ? `[evidence chunkIds: ${xmlText(r.evidenceChunkIds.join(", "))}]`
          : "[evidence chunkIds: none]";
      lines.push(
        `    <relationship claim-id="${xmlAttr(r.claimId)}" predicate="${xmlAttr(r.predicate)}" target="${xmlAttr(r.targetCanonicalName)}" target-id="${xmlAttr(r.targetEntityId)}" confidence="${r.confidence}" method="${xmlAttr(r.method)}">${evidence}</relationship>`,
      );
    }
    lines.push(`  </relationships>`);
  }

  if (page.attributes.length > 0) {
    lines.push(`  <attributes count="${page.attributes.length}">`);
    for (const a of page.attributes) {
      const evidence =
        a.evidenceChunkIds.length > 0
          ? `[evidence chunkIds: ${xmlText(a.evidenceChunkIds.join(", "))}]`
          : "[evidence chunkIds: none]";
      lines.push(
        `    <attribute claim-id="${xmlAttr(a.claimId)}" predicate="${xmlAttr(a.predicate)}" value="${xmlAttr(a.value)}" confidence="${a.confidence}" method="${xmlAttr(a.method)}">${evidence}</attribute>`,
      );
    }
    lines.push(`  </attributes>`);
  }

  if (page.voiceEvidence.length > 0) {
    const total = page.voiceEvidence.length;
    const shown = Math.min(total, VOICE_EVIDENCE_RENDER_CAP);
    const truncatedAttr = total > shown ? ` truncated="${total - shown}"` : "";
    lines.push(`  <voice-evidence count="${shown}"${truncatedAttr}>`);
    for (let i = 0; i < shown; i++) {
      const v = page.voiceEvidence[i];
      if (v === undefined) continue;
      const sectionAttr = v.sectionPath.map(xmlAttr).join(" > ");
      lines.push(
        `    <chunk id="${xmlAttr(v.chunkId)}" source="${xmlAttr(v.documentTitle)}" section="${sectionAttr}">`,
      );
      lines.push(`    ${xmlText(v.text)}`);
      lines.push(`    </chunk>`);
    }
    lines.push(`  </voice-evidence>`);
  }

  if (page.uncertainClaims.length > 0) {
    lines.push(`  <uncertain-claims count="${page.uncertainClaims.length}">`);
    for (const u of page.uncertainClaims) {
      const targetAttr =
        u.targetCanonicalName !== undefined
          ? ` target="${xmlAttr(u.targetCanonicalName)}"`
          : "";
      const targetIdAttr =
        u.targetEntityId !== undefined
          ? ` target-id="${xmlAttr(u.targetEntityId)}"`
          : "";
      const valueAttr =
        u.value !== undefined ? ` value="${xmlAttr(u.value)}"` : "";
      const reasonAttr =
        u.reason !== undefined ? ` reason="${xmlAttr(u.reason)}"` : "";
      lines.push(
        `    <claim claim-id="${xmlAttr(u.claimId)}" predicate="${xmlAttr(u.predicate)}"${targetAttr}${targetIdAttr}${valueAttr} confidence="${u.confidence}" method="${xmlAttr(u.method)}"${reasonAttr}/>`,
      );
    }
    lines.push(`  </uncertain-claims>`);
  }

  lines.push(`</entity-wiki>`);
  return lines.join("\n");
}
