import type { TerminalRecordBlock } from "@herta/core";
import { describe, expect, it } from "vitest";
import { episodeHash, isSettled, segmentSession } from "./segment-session.js";

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
const done = (at?: string): TerminalRecordBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: "完成",
  role: "done-marker",
  ...(at ? { at } : {}),
});
const noop = (at?: string): TerminalRecordBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: "noop",
  role: "noop-marker",
  ...(at ? { at } : {}),
});

const OPTS = {
  episodeGapMs: 20 * 60_000,
  maxEpisodeBlocks: 60,
  maxEpisodeMs: 45 * 60_000,
};

describe("segmentSession", () => {
  it("splits on a large idle gap between blocks", () => {
    const rec = [
      u("topic A", "2026-06-18T09:00:00Z"),
      h("ans A", "2026-06-18T09:00:30Z"),
      u("topic B", "2026-06-18T11:00:00Z"), // +~2h gap → boundary
      h("ans B", "2026-06-18T11:00:30Z"),
    ];
    const eps = segmentSession("s1", rec, OPTS);
    expect(eps).toHaveLength(2);
    expect(eps[0]?.blocks).toHaveLength(2);
    expect(eps[1]?.blocks).toHaveLength(2);
  });

  it("splits structurally on a done-marker (no timestamps)", () => {
    const rec = [u("fix it"), h("@板砖"), done(), u("now docs"), h("ok")];
    const eps = segmentSession("s1", rec, OPTS);
    expect(eps).toHaveLength(2);
    expect(eps[0]?.endIndex).toBe(3);
  });

  it("marks the trailing episode unsettled, earlier ones settled", () => {
    const rec = [u("a"), h("a"), done(), u("b"), h("b")];
    const eps = segmentSession("s1", rec, OPTS);
    expect(eps[0]?.settled).toBe(true);
    expect(eps.at(-1)?.settled).toBe(false);
  });

  // ── Trailing-silence settling (ADR 0024) ─────────────────────────────────
  describe("trailing-silence settling (ADR 0024)", () => {
    const T0 = Date.parse("2026-06-18T09:00:00Z");

    it("settles the tail once silence after its last stamped block exceeds episodeGapMs", () => {
      const rec = [
        u("说件事", "2026-06-18T09:00:00Z"),
        h("听着", "2026-06-18T09:01:00Z"),
      ];
      // 21 minutes after the last block → settled.
      const eps = segmentSession("s1", rec, OPTS, T0 + 22 * 60_000);
      expect(eps).toHaveLength(1);
      expect(eps[0]?.settled).toBe(true);
    });

    it("keeps the tail unsettled within the gap window", () => {
      const rec = [
        u("说件事", "2026-06-18T09:00:00Z"),
        h("听着", "2026-06-18T09:01:00Z"),
      ];
      // 5 minutes after the last block → still open, not dreamable.
      const eps = segmentSession("s1", rec, OPTS, T0 + 6 * 60_000);
      expect(eps[0]?.settled).toBe(false);
    });

    it("keeps an unstamped tail unsettled (silence cannot be proven)", () => {
      const rec = [u("a"), h("b")]; // no `at` anywhere
      const eps = segmentSession("s1", rec, OPTS, T0 + 10 * 24 * 60 * 60_000);
      expect(eps[0]?.settled).toBe(false);
    });

    it("uses the last STAMPED block when trailing blocks are unstamped", () => {
      const rec = [
        u("说件事", "2026-06-18T09:00:00Z"),
        h("听着", "2026-06-18T09:01:00Z"),
        h("补一句"), // unstamped tail block
      ];
      const eps = segmentSession("s1", rec, OPTS, T0 + 30 * 60_000);
      expect(eps.at(-1)?.settled).toBe(true);
    });

    it("does not change earlier episodes' settled flags", () => {
      const rec = [
        u("a"),
        h("a"),
        done(),
        u("b", "2026-06-18T09:00:00Z"),
        h("b", "2026-06-18T09:01:00Z"),
      ];
      const eps = segmentSession("s1", rec, OPTS, T0 + 30 * 60_000);
      expect(eps[0]?.settled).toBe(true);
      expect(eps.at(-1)?.settled).toBe(true); // now settled by silence
    });

    it("omitting nowMs keeps the legacy contract (tail never settles)", () => {
      const rec = [
        u("说件事", "2026-06-18T09:00:00Z"),
        h("听着", "2026-06-18T09:01:00Z"),
      ];
      const eps = segmentSession("s1", rec, OPTS);
      expect(eps[0]?.settled).toBe(false);
    });

    it("resume after the gap forms a NEW episode and the settled tail's hash is unchanged", () => {
      const before = [
        u("说件事", "2026-06-18T09:00:00Z"),
        h("听着", "2026-06-18T09:01:00Z"),
      ];
      const settledTail = segmentSession("s1", before, OPTS, T0 + 30 * 60_000);
      const tailHash = settledTail[0]?.episodeHash;
      // The user resumes 30 min later — the between-block gap rule splits
      // at the same silence, so the old tail's blocks and hash are stable.
      const resumed = [
        ...before,
        u("我又来了", "2026-06-18T09:31:00Z"),
        h("嗯", "2026-06-18T09:31:30Z"),
      ];
      const eps = segmentSession("s1", resumed, OPTS, T0 + 60 * 60_000);
      expect(eps).toHaveLength(2);
      expect(eps[0]?.episodeHash).toBe(tailHash);
      expect(eps[0]?.settled).toBe(true);
      expect(eps[1]?.settled).toBe(true); // 29 min silence after the resume
    });
  });

  it("caps an episode at maxEpisodeBlocks", () => {
    const rec = Array.from({ length: 5 }, (_, i) => u(`m${i}`));
    const eps = segmentSession("s1", rec, { ...OPTS, maxEpisodeBlocks: 2 });
    expect(eps.every((e) => e.blocks.length <= 2)).toBe(true);
  });

  it("hashes episode content stably and distinctly", () => {
    const a = [u("x"), h("y")];
    expect(episodeHash(a)).toBe(episodeHash([u("x"), h("y")]));
    expect(episodeHash(a)).not.toBe(episodeHash([u("x"), h("z")]));
  });

  // Fix 1 regression: distinct block partitions must not collide.
  it("episodeHash: distinct partitions of the same characters do not collide", () => {
    expect(episodeHash([u("a"), u("b")])).not.toBe(episodeHash([u("ab")]));
  });

  // Fix 2: noop-marker also splits on the following UserBlock.
  it("splits structurally on a noop-marker (no timestamps)", () => {
    const rec = [u("query"), h("@板砖"), noop(), u("next question"), h("ok")];
    const eps = segmentSession("s1", rec, OPTS);
    expect(eps).toHaveLength(2);
    expect(eps[0]?.endIndex).toBe(3);
  });

  // Fix 3a: cap test asserts index continuity.
  it("cap: episodes cover every block with no gaps or overlaps", () => {
    const rec = Array.from({ length: 5 }, (_, i) => u(`m${i}`));
    const eps = segmentSession("s1", rec, { ...OPTS, maxEpisodeBlocks: 2 });
    // With 5 user blocks and cap=2: [0,2), [2,4), [4,5)
    expect(eps).toHaveLength(3);
    expect(eps[0]).toMatchObject({ startIndex: 0, endIndex: 2 });
    expect(eps[1]).toMatchObject({ startIndex: 2, endIndex: 4 });
    expect(eps[2]).toMatchObject({ startIndex: 4, endIndex: 5 });
  });

  // Fix 3b: empty record returns [].
  it("returns [] for an empty record", () => {
    expect(segmentSession("s1", [], OPTS)).toEqual([]);
  });

  // Fix 3c: malformed `at` does NOT cause an idle-gap split.
  it("malformed `at` values do not trigger idle-gap split", () => {
    const rec = [
      u("a", "not-a-date"),
      u("b", "not-a-date"),
      u("c", "not-a-date"),
    ];
    const eps = segmentSession("s1", rec, { ...OPTS, episodeGapMs: 0 });
    // NaN gap → Number.isFinite guard → no gap split → one episode
    expect(eps).toHaveLength(1);
  });

  // Temporal grouping: consecutive exchanges with small gaps stay in ONE episode.
  it("temporal grouping: rapid user→herta exchanges (sub-gap) collapse into one episode", () => {
    // Four blocks each ~10 s apart — well under episodeGapMs (20 min).
    const t0 = "2026-06-18T10:00:00Z";
    const t1 = "2026-06-18T10:00:10Z";
    const t2 = "2026-06-18T10:00:20Z";
    const t3 = "2026-06-18T10:00:30Z";
    const rec = [u("q1", t0), h("a1", t1), u("q2", t2), h("a2", t3)];
    const eps = segmentSession("s1", rec, OPTS);
    // No idle gap, no done-marker, no duration cap → single episode.
    expect(eps).toHaveLength(1);
    expect(eps[0]?.blocks).toHaveLength(4);
  });

  // Duration cap: a gapless run whose total span exceeds maxEpisodeMs splits.
  it("duration cap: gapless run exceeding maxEpisodeMs splits at the cap", () => {
    const base = new Date("2026-06-18T08:00:00Z").getTime();
    const min = 60_000;
    const ts = (offset: number): string =>
      new Date(base + offset * min).toISOString();
    // Blocks at 0, 19, 38, 57, 76, 95 min. Each consecutive gap is 19 min
    // (< episodeGapMs 20 min) so no idle gap fires. With maxEpisodeMs = 45 min:
    //   episode 1 starts @0; block @57 → span 57 > 45 → split before it.
    //   episode 2 starts @57; @76 (19), @95 (38) — both < 45 → no further split.
    // Expected: exactly 2 episodes — [0,3) (0..38 min) and [3,6) (57..95 min).
    const rec = [
      u("a", ts(0)),
      h("b", ts(19)),
      u("c", ts(38)),
      h("d", ts(57)),
      u("e", ts(76)),
      h("f", ts(95)),
    ];
    const opts = { ...OPTS, maxEpisodeMs: 45 * min, episodeGapMs: 20 * min };
    const eps = segmentSession("s1", rec, opts);
    expect(eps).toHaveLength(2);
    expect(eps[0]?.startIndex).toBe(0);
    expect(eps[0]?.endIndex).toBe(3);
    expect(eps[0]?.settled).toBe(true);
    expect(eps[1]?.startIndex).toBe(3);
    expect(eps[1]?.endIndex).toBe(6);
    expect(eps[1]?.settled).toBe(false); // trailing episode
    // Neither episode spans more than the 45-min cap.
    for (const e of eps) {
      const stamps = e.blocks
        .map((b) => b.at)
        .filter((x): x is string => x !== undefined);
      const span =
        Date.parse(stamps[stamps.length - 1] as string) -
        Date.parse(stamps[0] as string);
      expect(span).toBeLessThanOrEqual(45 * min);
    }
  });

  it("a gap exactly equal to episodeGapMs does NOT split (strict >)", () => {
    const t0 = "2026-06-18T10:00:00Z";
    const t1 = "2026-06-18T10:20:00Z"; // exactly 20 min later == episodeGapMs
    const opts = {
      ...OPTS,
      episodeGapMs: 20 * 60_000,
      maxEpisodeMs: 45 * 60_000,
    };
    expect(segmentSession("s1", [u("q", t0), h("a", t1)], opts)).toHaveLength(
      1,
    );
  });

  // Per-turn fallback: blocks WITHOUT `at` still split on herta→user.
  it("per-turn fallback: untimstamped herta→user still splits", () => {
    // No `at` on any block → temporal rules don't fire → fallback (d) applies.
    const rec = [u("q1"), h("a1"), u("q2"), h("a2"), u("q3"), h("a3")];
    const eps = segmentSession("s1", rec, OPTS);
    // Each herta→user pair should split: [u,h], [u,h], [u,h]
    expect(eps).toHaveLength(3);
  });

  // Done-marker still splits even within a single time window.
  it("done-marker splits even when timestamps are within episodeGapMs", () => {
    const t0 = "2026-06-18T10:00:00Z";
    const t1 = "2026-06-18T10:00:10Z";
    const t2 = "2026-06-18T10:00:20Z";
    const t3 = "2026-06-18T10:00:30Z";
    const t4 = "2026-06-18T10:00:40Z";
    const rec = [
      u("fix it", t0),
      h("@板砖", t1),
      done(t2),
      u("now docs", t3),
      h("ok", t4),
    ];
    const eps = segmentSession("s1", rec, OPTS);
    expect(eps).toHaveLength(2);
    expect(eps[0]?.endIndex).toBe(3);
  });
});

describe("isSettled", () => {
  it("returns true when end is before recordLength", () => {
    expect(isSettled(3, 5)).toBe(true);
  });
  it("returns false when end equals recordLength", () => {
    expect(isSettled(5, 5)).toBe(false);
  });
});
