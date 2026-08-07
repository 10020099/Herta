import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyManifest } from "./manifest.js";
import { reconcileDreamState } from "./reconcile.js";
import type { DreamCreatedRecord } from "./types.js";

function liveRec(file: string): DreamCreatedRecord {
  return {
    id: file,
    file,
    nn: 0,
    state: "live",
    sourceSessionId: "s",
    sourceEpisodeHash: "h",
    sourceEpisodes: ["h"],
    runId: "r",
    model: "m",
    generatedAt: "2026-06-18T09:00:00Z",
    situationTag: "tag",
    summary: "摘要",
    critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
    validateFeianPassed: true,
    estimatedPrefixTokens: 100,
    reactivationCount: 0,
  };
}

describe("reconcileDreamState", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dream-rec-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns zeros when the narrative dir does not exist", () => {
    const res = reconcileDreamState({
      narrativeDir: join(dir, "nope"),
      manifest: emptyManifest(),
    });
    expect(res).toEqual({ sweptTemp: 0, prunedPhantom: 0 });
  });

  it("sweeps stale .dream-tmp-* files and leaves 废案 files alone", () => {
    writeFileSync(join(dir, ".dream-tmp-r1-00"), "x", "utf8");
    writeFileSync(join(dir, ".dream-tmp-r1-01"), "x", "utf8");
    writeFileSync(join(dir, "### 废案_00：seed.txt"), "seed", "utf8");

    const res = reconcileDreamState({
      narrativeDir: dir,
      manifest: emptyManifest(),
    });

    expect(res.sweptTemp).toBe(2);
    const left = readdirSync(dir);
    expect(left.some((f) => f.startsWith(".dream-tmp-"))).toBe(false);
    expect(left).toContain("### 废案_00：seed.txt");
  });

  it("sweeps orphaned .dream-notes-tmp-* files from a crashed notes write", () => {
    // writeTrailblazerNotes writes `.dream-notes-tmp-<runId>` then renames;
    // a crash or EPERM-failed rename orphans it exactly like a promotion tmp.
    writeFileSync(join(dir, ".dream-notes-tmp-r9"), "half a page", "utf8");
    writeFileSync(join(dir, ".dream-tmp-r9-00"), "x", "utf8");
    writeFileSync(join(dir, "### 记录：关于开拓者.txt"), "notes", "utf8");

    const res = reconcileDreamState({
      narrativeDir: dir,
      manifest: emptyManifest(),
    });

    expect(res.sweptTemp).toBe(2); // both temp families counted together
    const left = readdirSync(dir);
    expect(left.some((f) => f.startsWith(".dream-notes-tmp-"))).toBe(false);
    expect(left).toContain("### 记录：关于开拓者.txt"); // the real page survives
  });

  it("prunes a phantom live record whose file has vanished", () => {
    const m = emptyManifest();
    m.created.push(liveRec("### 废案_05：gone.txt")); // no file on disk

    const res = reconcileDreamState({ narrativeDir: dir, manifest: m });

    expect(res.prunedPhantom).toBe(1);
    expect(m.created[0]?.state).toBe("archived");
  });

  it("keeps a live record whose file is present", () => {
    const file = "### 废案_03：here.txt";
    writeFileSync(join(dir, file), "body", "utf8");
    const m = emptyManifest();
    m.created.push(liveRec(file));

    const res = reconcileDreamState({ narrativeDir: dir, manifest: m });

    expect(res.prunedPhantom).toBe(0);
    expect(m.created[0]?.state).toBe("live");
  });

  it("never adopts an untracked 废案 file (identity guard, D7)", () => {
    const seed = "### 废案_00：用户手写.txt";
    writeFileSync(join(dir, seed), "hand-authored", "utf8");
    const m = emptyManifest();

    const res = reconcileDreamState({ narrativeDir: dir, manifest: m });

    expect(m.created).toHaveLength(0); // not adopted into the ledger
    expect(existsSync(join(dir, seed))).toBe(true); // file untouched
    expect(res).toEqual({ sweptTemp: 0, prunedPhantom: 0 });
  });
});
