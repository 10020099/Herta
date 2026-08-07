import type { TerminalRecordBlock } from "@herta/core";
import { describe, expect, it } from "vitest";
import { emptyManifest } from "./manifest.js";
import { selectPromptExclusions } from "./prompt-exclusions.js";
import { segmentSession } from "./segment-session.js";
import type { DreamCreatedRecord, DreamManifest } from "./types.js";

const u = (text: string, at?: string): TerminalRecordBlock => ({
  kind: "user",
  text,
  ...(at ? { at } : {}),
});
const h = (text: string, at?: string): TerminalRecordBlock => ({
  kind: "herta",
  surface: "speech",
  text,
  ...(at ? { at } : {}),
});

const OPTS = {
  episodeGapMs: 20 * 60_000,
  maxEpisodeBlocks: 60,
  maxEpisodeMs: 45 * 60_000,
};

const mkCreated = (
  id: string,
  sourceEpisodes: readonly string[],
  extra: Partial<DreamCreatedRecord> = {},
): DreamCreatedRecord => ({
  id,
  file: `### 废案_0${id}：t.txt`,
  nn: Number(id),
  state: "live",
  sourceSessionId: "s1",
  sourceEpisodeHash: sourceEpisodes[0] ?? "h0",
  sourceEpisodes,
  runId: "r",
  model: "deepseek-v4-pro",
  generatedAt: "2026-06-18T09:00:00Z",
  situationTag: "tag",
  summary: "这是一段叙事开篇摘要。",
  critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
  validateFeianPassed: true,
  estimatedPrefixTokens: 100,
  reactivationCount: 0,
  ...extra,
});

const withCreated = (...created: DreamCreatedRecord[]): DreamManifest => ({
  ...emptyManifest(),
  created,
});

/** Two gap-separated episodes: ep1 = blocks [0,2), ep2 = blocks [2,4). */
const TWO_EPISODE_RECORD: TerminalRecordBlock[] = [
  u("topic A", "2026-06-18T09:00:00Z"),
  h("ans A", "2026-06-18T09:00:30Z"),
  u("topic B", "2026-06-18T11:00:00Z"), // +2h gap → boundary at index 2
  h("ans B", "2026-06-18T11:00:30Z"),
];

function hashesOf(record: readonly TerminalRecordBlock[]): string[] {
  return segmentSession("s1", record, OPTS).map((e) => e.episodeHash);
}

describe("selectPromptExclusions", () => {
  it("excludes a 废案 whose source episode is verbatim (no recap engaged)", () => {
    const [ep1Hash] = hashesOf(TWO_EPISODE_RECORD);
    const rec = mkCreated("1", [ep1Hash ?? ""]);
    const excluded = selectPromptExclusions({
      manifest: withCreated(rec),
      sessionId: "s1",
      record: TWO_EPISODE_RECORD,
      recapBoundaryIndex: 0,
      config: OPTS,
    });
    expect(excluded).toEqual(new Set([rec.file]));
  });

  it("keeps a 废案 whose source episode fell behind the recap boundary", () => {
    const [ep1Hash, ep2Hash] = hashesOf(TWO_EPISODE_RECORD);
    const behind = mkCreated("1", [ep1Hash ?? ""]);
    const verbatim = mkCreated("2", [ep2Hash ?? ""]);
    // Boundary 2: ep1 ([0,2)) survives only via recap; ep2 ([2,4)) is verbatim.
    const excluded = selectPromptExclusions({
      manifest: withCreated(behind, verbatim),
      sessionId: "s1",
      record: TWO_EPISODE_RECORD,
      recapBoundaryIndex: 2,
      config: OPTS,
    });
    expect(excluded.has(behind.file)).toBe(false);
    expect(excluded).toEqual(new Set([verbatim.file]));
  });

  it("keeps a 废案 sourced from another session (no hash match)", () => {
    const rec = mkCreated("1", ["hash-from-elsewhere"], {
      sourceSessionId: "s-other",
    });
    const excluded = selectPromptExclusions({
      manifest: withCreated(rec),
      sessionId: "s1",
      record: TWO_EPISODE_RECORD,
      recapBoundaryIndex: 0,
      config: OPTS,
    });
    expect(excluded.size).toBe(0);
  });

  it("keeps a reconsolidated 废案 with any non-verbatim source episode", () => {
    const [ep1Hash] = hashesOf(TWO_EPISODE_RECORD);
    // Accreted across sessions: one source is verbatim here, one is foreign.
    const rec = mkCreated("1", [ep1Hash ?? "", "hash-from-elsewhere"]);
    const excluded = selectPromptExclusions({
      manifest: withCreated(rec),
      sessionId: "s1",
      record: TWO_EPISODE_RECORD,
      recapBoundaryIndex: 0,
      config: OPTS,
    });
    expect(excluded.size).toBe(0);
  });

  it("excludes a multi-source 废案 only when every source is verbatim", () => {
    const [ep1Hash, ep2Hash] = hashesOf(TWO_EPISODE_RECORD);
    const rec = mkCreated("1", [ep1Hash ?? "", ep2Hash ?? ""]);
    const boundary0 = selectPromptExclusions({
      manifest: withCreated(rec),
      sessionId: "s1",
      record: TWO_EPISODE_RECORD,
      recapBoundaryIndex: 0,
      config: OPTS,
    });
    expect(boundary0).toEqual(new Set([rec.file]));
    // Recap swallows ep1 → the record carries recovered detail again.
    const boundary2 = selectPromptExclusions({
      manifest: withCreated(rec),
      sessionId: "s1",
      record: TWO_EPISODE_RECORD,
      recapBoundaryIndex: 2,
      config: OPTS,
    });
    expect(boundary2.size).toBe(0);
  });

  it("never considers archived records", () => {
    const [ep1Hash] = hashesOf(TWO_EPISODE_RECORD);
    const rec = mkCreated("1", [ep1Hash ?? ""], { state: "archived" });
    const excluded = selectPromptExclusions({
      manifest: withCreated(rec),
      sessionId: "s1",
      record: TWO_EPISODE_RECORD,
      recapBoundaryIndex: 0,
      config: OPTS,
    });
    expect(excluded.size).toBe(0);
  });

  it("returns an empty set for an empty manifest or an empty record", () => {
    expect(
      selectPromptExclusions({
        manifest: emptyManifest(),
        sessionId: "s1",
        record: TWO_EPISODE_RECORD,
        recapBoundaryIndex: 0,
        config: OPTS,
      }).size,
    ).toBe(0);
    expect(
      selectPromptExclusions({
        manifest: withCreated(mkCreated("1", ["h1"])),
        sessionId: "s1",
        record: [],
        recapBoundaryIndex: 0,
        config: OPTS,
      }).size,
    ).toBe(0);
  });
});
