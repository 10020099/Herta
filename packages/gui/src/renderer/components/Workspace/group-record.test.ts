import type { TerminalRecordBlock } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import {
  activityChipLabel,
  activityHasTerminalMarker,
  activitySteps,
  activitySummary,
  groupRecord,
  type SystemBlock,
} from "./group-record.js";

const user = (text: string): TerminalRecordBlock => ({ kind: "user", text });
const herta = (text: string): TerminalRecordBlock => ({
  kind: "herta",
  surface: "speech",
  text,
});
const sys = (
  body: string,
  label: SystemBlock["label"] = "差分协处理器",
  role?: SystemBlock["role"],
  markerSummary?: SystemBlock["markerSummary"],
): SystemBlock => ({
  kind: "system",
  label,
  body,
  ...(role !== undefined ? { role } : {}),
  ...(markerSummary !== undefined ? { markerSummary } : {}),
});

describe("groupRecord", () => {
  it("returns nothing for an empty record", () => {
    expect(groupRecord([])).toEqual([]);
  });

  it("passes user/herta blocks through with their index", () => {
    const items = groupRecord([user("hi"), herta("yo")]);
    expect(items).toEqual([
      { kind: "block", block: user("hi"), index: 0 },
      { kind: "block", block: herta("yo"), index: 1 },
    ]);
  });

  it("folds consecutive system blocks into one activity item keyed by startIndex", () => {
    const items = groupRecord([
      user("go"),
      sys("Reading scripts"),
      sys("Writing a.ts"),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: "block", block: user("go"), index: 0 });
    expect(items[1]).toMatchObject({ kind: "activity", startIndex: 1 });
    if (items[1]?.kind === "activity") expect(items[1].blocks).toHaveLength(2);
  });

  it("splits a run when a herta beat interrupts it", () => {
    const items = groupRecord([sys("Reading"), herta("beat"), sys("Writing")]);
    expect(items.map((x) => x.kind)).toEqual(["activity", "block", "activity"]);
    expect((items[0] as { startIndex: number }).startIndex).toBe(0);
    expect((items[2] as { startIndex: number }).startIndex).toBe(2);
  });

  it("chip label is 差分协处理器 if any block has it, else 系统", () => {
    expect(
      activityChipLabel([sys("x", "系统"), sys("y", "差分协处理器")]),
    ).toBe("差分协处理器");
    expect(activityChipLabel([sys("x", "系统")])).toBe("系统");
  });

  it("summary prefers the structured marker; terminal-marker + steps split out", () => {
    const blocks = [
      sys("Reading"),
      sys("完成 · 2 files", "差分协处理器", "done-marker", {
        kind: "done",
        state: "completed",
        fileCount: 2,
        riskCount: 0,
      }),
    ];
    expect(activitySummary(blocks)).toEqual({
      kind: "structured",
      marker: { kind: "done", state: "completed", fileCount: 2, riskCount: 0 },
    });
    expect(activityHasTerminalMarker(blocks)).toBe(true);
    expect(activitySteps(blocks)).toHaveLength(1);
    expect(activitySteps(blocks)[0]?.body).toBe("Reading");
    expect(activitySummary([sys("Reading")])).toBeNull();
    expect(activityHasTerminalMarker([sys("Reading")])).toBe(false);
  });

  it("summary falls back to the raw body for a pre-structured done-marker", () => {
    const blocks = [sys("完成 · 2 files", "差分协处理器", "done-marker")];
    expect(activitySummary(blocks)).toEqual({
      kind: "raw",
      text: "完成 · 2 files",
    });
  });

  it("summary reports a noop marker by role alone (no counts to localize)", () => {
    const blocks = [sys("无产出 — …", "差分协处理器", "noop-marker")];
    expect(activitySummary(blocks)).toEqual({ kind: "noop" });
  });
});
