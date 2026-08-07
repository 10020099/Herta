import type { TerminalRecord, TerminalRecordBlock } from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  countHertaTurns,
  hasEnoughMaterial,
  isModifiedSince,
} from "./readiness.js";

function sessionWithHertaTurns(n: number): TerminalRecord {
  const blocks: TerminalRecordBlock[] = [{ kind: "user", text: "hi" }];
  for (let i = 0; i < n; i++) {
    blocks.push({ kind: "herta", surface: "speech", text: `line ${i}` });
  }
  return blocks;
}

describe("countHertaTurns", () => {
  it("counts only 黑塔 speech/thought blocks, not user or system", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "q" },
      { kind: "herta", surface: "speech", text: "a" },
      { kind: "herta", surface: "thought", text: "（我 想）" },
      { kind: "system", label: "系统", body: "Writing foo.ts" },
      { kind: "herta", surface: "speech", text: "b" },
    ];
    expect(countHertaTurns(record)).toBe(3);
  });

  it("returns 0 for a record with no 黑塔 blocks", () => {
    expect(
      countHertaTurns([
        { kind: "user", text: "q" },
        { kind: "system", label: "系统", body: "noop" },
      ]),
    ).toBe(0);
  });
});

describe("hasEnoughMaterial", () => {
  const thresholds = { minNewSessions: 5, minSessionHertaTurns: 25 };

  it("fires when the new-session count reaches minNewSessions", () => {
    const records = Array.from({ length: 5 }, () => sessionWithHertaTurns(1));
    expect(hasEnoughMaterial(records, thresholds)).toBe(true);
  });

  it("fires on a single long-enough session even with few sessions", () => {
    expect(hasEnoughMaterial([sessionWithHertaTurns(25)], thresholds)).toBe(
      true,
    );
  });

  it("does not fire when neither branch is satisfied", () => {
    // 4 sessions (< 5) and none reaches 25 黑塔 turns.
    const records = Array.from({ length: 4 }, () => sessionWithHertaTurns(10));
    expect(hasEnoughMaterial(records, thresholds)).toBe(false);
  });

  it("does not fire on an empty new-session set", () => {
    expect(hasEnoughMaterial([], thresholds)).toBe(false);
  });

  it("uses the exact boundary: exactly minSessionHertaTurns qualifies", () => {
    expect(hasEnoughMaterial([sessionWithHertaTurns(24)], thresholds)).toBe(
      false,
    );
    expect(hasEnoughMaterial([sessionWithHertaTurns(25)], thresholds)).toBe(
      true,
    );
  });
});

describe("isModifiedSince", () => {
  const since = Date.parse("2026-06-10T00:00:00.000Z");

  it("is true for a timestamp strictly after the anchor", () => {
    expect(isModifiedSince("2026-06-15T00:00:00.000Z", since)).toBe(true);
  });

  it("is false at the exact boundary (<= anchor is not 'modified since')", () => {
    expect(isModifiedSince("2026-06-10T00:00:00.000Z", since)).toBe(false);
  });

  it("is false for a timestamp before the anchor", () => {
    expect(isModifiedSince("2026-06-05T00:00:00.000Z", since)).toBe(false);
  });

  it("is false for an unparseable timestamp (NaN guard)", () => {
    expect(isModifiedSince("not-a-date", since)).toBe(false);
    expect(isModifiedSince("", since)).toBe(false);
  });

  it("counts every parseable session as new when the anchor is 0 (never run)", () => {
    expect(isModifiedSince("2020-01-01T00:00:00.000Z", 0)).toBe(true);
    // …but an unparseable one is still excluded.
    expect(isModifiedSince("nope", 0)).toBe(false);
  });
});
