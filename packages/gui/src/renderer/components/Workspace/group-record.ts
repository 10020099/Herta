import type { TerminalRecordBlock } from "@herta/app-server";

/** The system-block member of the record union (no name-import needed). */
export type SystemBlock = Extract<TerminalRecordBlock, { kind: "system" }>;

/** The structured done-marker roll-up (derived from the block, no name-import). */
export type DoneMarkerSummary = NonNullable<SystemBlock["markerSummary"]>;

/**
 * What the activity header should display. `structured` carries the typed
 * roll-up (new records) so the renderer composes a localized summary;
 * `raw` carries the canonical body verbatim (records persisted before the
 * structured field existed). `noop` is recognised by role alone — it has no
 * counts, so it never needs a `markerSummary` on the block.
 */
export type ActivitySummary =
  | { readonly kind: "structured"; readonly marker: DoneMarkerSummary }
  | { readonly kind: "noop" }
  | { readonly kind: "raw"; readonly text: string };

export type RenderItem =
  | {
      readonly kind: "block";
      readonly block: TerminalRecordBlock;
      readonly index: number;
    }
  | {
      readonly kind: "activity";
      readonly startIndex: number;
      readonly blocks: readonly SystemBlock[];
    };

/**
 * Fold the flat record into render items: maximal runs of consecutive
 * `system` blocks become one `activity` item (keyed by its first index,
 * stable because the record is append-only); user/herta blocks pass through.
 * Pure presentation — the record itself is unchanged (D7).
 */
export function groupRecord(
  record: readonly TerminalRecordBlock[],
): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;
  while (i < record.length) {
    const block = record[i];
    if (block === undefined) {
      i += 1;
      continue;
    }
    if (block.kind === "system") {
      const startIndex = i;
      const blocks: SystemBlock[] = [];
      while (i < record.length) {
        const b = record[i];
        if (b === undefined || b.kind !== "system") break;
        blocks.push(b);
        i += 1;
      }
      items.push({ kind: "activity", startIndex, blocks });
    } else {
      items.push({ kind: "block", block, index: i });
      i += 1;
    }
  }
  return items;
}

function isTerminal(b: SystemBlock): boolean {
  return b.role === "done-marker" || b.role === "noop-marker";
}

/** Chip identity: backend if any backend block, else system. */
export function activityChipLabel(
  blocks: readonly SystemBlock[],
): "差分协处理器" | "系统" {
  return blocks.some((b) => b.label === "差分协处理器")
    ? "差分协处理器"
    : "系统";
}

/**
 * The done/noop marker summary shown in the header, or null when the run has
 * no terminal marker yet. Prefers the structured roll-up (localizable);
 * falls back to the canonical body for pre-structured records.
 */
export function activitySummary(
  blocks: readonly SystemBlock[],
): ActivitySummary | null {
  const marker = blocks.find(isTerminal);
  if (marker === undefined) return null;
  if (marker.role === "noop-marker") return { kind: "noop" };
  if (marker.markerSummary !== undefined) {
    return { kind: "structured", marker: marker.markerSummary };
  }
  return { kind: "raw", text: marker.body };
}

export function activityHasTerminalMarker(
  blocks: readonly SystemBlock[],
): boolean {
  return blocks.some(isTerminal);
}

/** The operational rows (terminal markers are header summary, not steps). */
export function activitySteps(
  blocks: readonly SystemBlock[],
): readonly SystemBlock[] {
  return blocks.filter((b) => !isTerminal(b));
}
