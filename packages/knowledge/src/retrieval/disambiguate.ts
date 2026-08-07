import { xmlAttr } from "./xml-escape.js";

export interface EntityCandidate {
  entityId: string;
  canonicalName: string;
  type: string;
}

const TYPE_PRIORITY: ReadonlyArray<string> = [
  "person",
  "manifestation",
  "form",
  "place",
  "work",
  "faction",
  "ambiguous",
];

function typeRank(type: string): number {
  const i = TYPE_PRIORITY.indexOf(type);
  return i === -1 ? TYPE_PRIORITY.length : i;
}

export function formatDisambiguationBlock(
  alias: string,
  candidates: ReadonlyArray<EntityCandidate>,
): string {
  if (candidates.length <= 1) return "";
  const sorted = [...candidates].sort(
    (a, b) =>
      typeRank(a.type) - typeRank(b.type) ||
      a.entityId.localeCompare(b.entityId),
  );
  const parts = [`<canon-disambiguation alias="${xmlAttr(alias)}">`];
  for (const c of sorted) {
    parts.push(
      `  <referent entity_id="${xmlAttr(c.entityId)}" canonical="${xmlAttr(c.canonicalName)}" type="${xmlAttr(c.type)}" />`,
    );
  }
  parts.push(`</canon-disambiguation>`);
  return parts.join("\n");
}
