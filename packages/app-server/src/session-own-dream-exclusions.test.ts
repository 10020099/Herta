/**
 * Reopen own-dream filter (design 2026-07-07) — the composed seam in
 * `ownDreamExclusions`: recap-cache boundary validation, dream-manifest
 * lookup under the workspace, and fail-open behavior. The selection rule
 * itself is unit-tested in @herta/knowledge (prompt-exclusions.test.ts);
 * the prefix-side filtering in @herta/herta (static-prefix.test.ts).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalRecordBlock } from "@herta/core";
import { writeRecapCache } from "@herta/herta";
import {
  episodeHash,
  resolveDreamConfig,
  segmentSession,
} from "@herta/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownDreamExclusions } from "./session-wiring.js";

const u = (text: string, at: string): TerminalRecordBlock => ({
  kind: "user",
  text,
  at,
});
const h = (text: string, at: string): TerminalRecordBlock => ({
  kind: "herta",
  surface: "speech",
  text,
  at,
});

/** Two gap-separated episodes: ep1 = blocks [0,2), ep2 = blocks [2,4). */
const RECORD: TerminalRecordBlock[] = [
  u("topic A", "2026-07-07T09:00:00Z"),
  h("ans A", "2026-07-07T09:00:30Z"),
  u("topic B", "2026-07-07T11:00:00Z"),
  h("ans B", "2026-07-07T11:00:30Z"),
];

const SESSION_ID = "sess-reopen";

function episodeHashes(): string[] {
  return segmentSession(SESSION_ID, RECORD, resolveDreamConfig()).map(
    (e) => e.episodeHash,
  );
}

function writeDreamManifest(
  workspaceRoot: string,
  entries: readonly { file: string; sourceEpisodes: readonly string[] }[],
): void {
  const dreamDir = join(workspaceRoot, ".herta", "dream");
  mkdirSync(dreamDir, { recursive: true });
  const created = entries.map((e, i) => ({
    id: `r${i}`,
    file: e.file,
    nn: 7 + i,
    state: "live",
    sourceSessionId: SESSION_ID,
    sourceEpisodeHash: e.sourceEpisodes[0] ?? "",
    sourceEpisodes: e.sourceEpisodes,
    runId: "run",
    model: "deepseek-v4-pro",
    generatedAt: "2026-07-07T10:00:00Z",
    situationTag: "tag",
    summary: "摘要",
    critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
    validateFeianPassed: true,
    estimatedPrefixTokens: 100,
    reactivationCount: 0,
  }));
  writeFileSync(
    join(dreamDir, "manifest.json"),
    JSON.stringify({ version: 1, episodes: [], created }),
    "utf8",
  );
}

describe("ownDreamExclusions", () => {
  let workspaceRoot: string;
  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "herta-own-dream-"));
  });
  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("excludes a 废案 sourced from a verbatim episode (no recap cache on disk)", () => {
    const [ep1] = episodeHashes();
    writeDreamManifest(workspaceRoot, [
      { file: "### 废案_07：x.txt", sourceEpisodes: [ep1 ?? ""] },
    ]);
    const excluded = ownDreamExclusions({
      workspaceRoot,
      sessionId: SESSION_ID,
      record: RECORD,
      dream: undefined,
      lang: "zh",
    });
    expect(excluded).toEqual(new Set(["### 废案_07：x.txt"]));
  });

  it("respects a valid recap boundary: behind-boundary 废案 stays in", () => {
    const [ep1, ep2] = episodeHashes();
    writeDreamManifest(workspaceRoot, [
      { file: "### 废案_07：old.txt", sourceEpisodes: [ep1 ?? ""] },
      { file: "### 废案_08：new.txt", sourceEpisodes: [ep2 ?? ""] },
    ]);
    // Boundary 2 indexes a user block → valid: ep1 survives only via recap.
    writeRecapCache(workspaceRoot, SESSION_ID, {
      boundaryIndex: 2,
      recapText: "recap",
      lang: "zh",
      advancesSinceRederive: 0,
    });
    const excluded = ownDreamExclusions({
      workspaceRoot,
      sessionId: SESSION_ID,
      record: RECORD,
      dream: undefined,
      lang: "zh",
    });
    expect(excluded).toEqual(new Set(["### 废案_08：new.txt"]));
  });

  it("treats an invalid cached boundary (non-user block) as no recap", () => {
    const [ep1] = episodeHashes();
    writeDreamManifest(workspaceRoot, [
      { file: "### 废案_07：x.txt", sourceEpisodes: [ep1 ?? ""] },
    ]);
    // Index 3 is a herta block — the recap runtime would discard this cache,
    // so the filter must too (whole record verbatim → exclusion applies).
    writeRecapCache(workspaceRoot, SESSION_ID, {
      boundaryIndex: 3,
      recapText: "recap",
      lang: "zh",
      advancesSinceRederive: 0,
    });
    const excluded = ownDreamExclusions({
      workspaceRoot,
      sessionId: SESSION_ID,
      record: RECORD,
      dream: undefined,
      lang: "zh",
    });
    expect(excluded).toEqual(new Set(["### 废案_07：x.txt"]));
  });

  it("returns undefined when nothing matches (other-session dream) or no manifest exists", () => {
    // No .herta/dream at all.
    expect(
      ownDreamExclusions({
        workspaceRoot,
        sessionId: SESSION_ID,
        record: RECORD,
        dream: undefined,
        lang: "zh",
      }),
    ).toBeUndefined();
    // A manifest whose record points at foreign episodes.
    writeDreamManifest(workspaceRoot, [
      { file: "### 废案_07：other.txt", sourceEpisodes: ["foreign-hash"] },
    ]);
    expect(
      ownDreamExclusions({
        workspaceRoot,
        sessionId: SESSION_ID,
        record: RECORD,
        dream: undefined,
        lang: "zh",
      }),
    ).toBeUndefined();
  });

  it("hashes here really match the segmentation the dream pass uses", () => {
    // Guard against fixture drift: the first episode's hash equals hashing
    // its blocks directly.
    const eps = segmentSession(SESSION_ID, RECORD, resolveDreamConfig());
    expect(eps[0]?.episodeHash).toBe(episodeHash(RECORD.slice(0, 2)));
  });
});
