import type {
  SystemBlock,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  buildCompactionBody,
  compactRecordForPrompt,
  digestSystemBlock,
} from "./compact-record.js";

describe("digestSystemBlock — 差分协处理器 entries", () => {
  it('renders Reading {"path":"X"} as \'Reading X\'', () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: 'Reading {"path":"foo.ts"}',
    };
    expect(digestSystemBlock(block)).toBe("Reading foo.ts");
  });

  it("renders Reading with extra fields as 'Reading X'", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: 'Reading {"path":"src","recursive":false,"maxEntries":30}',
    };
    expect(digestSystemBlock(block)).toBe("Reading src");
  });

  it('renders Writing {"path":"X"} as \'Writing X\'', () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: 'Writing {"path":"scripts/merge-sort.js"}',
    };
    expect(digestSystemBlock(block)).toBe("Writing scripts/merge-sort.js");
  });

  it("renders Running {\"argv\":[...]} as 'Running `joined`'", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: 'Running {"argv":["pnpm","test","--silent"]}',
    };
    expect(digestSystemBlock(block)).toBe("Running `pnpm test --silent`");
  });

  it("a THOUGHT after the done-marker does not count as the spoken verdict (audit 2026-07-24, 1.10)", () => {
    // The mood-routed path commits a （我 想）right after the dispatch's
    // done-marker; treating that as "verdict spoken" folded the marker away
    // and stripped its evidence roll-up from the very prompt that generates
    // the synthesis speech.
    const marker: TerminalRecordBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "完成 · 1 个文件",
      role: "done-marker",
      evidenceDetail: "↳ 改动文件: a.ts\n↳ 待办: 补测试",
    };
    const withThought: TerminalRecord = [
      { kind: "user", text: "改一下" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      { kind: "system", label: "差分协处理器", body: "Writing a.ts" },
      marker,
      { kind: "herta", surface: "thought", text: "（我 想）看着还行。" },
    ];
    const out = compactRecordForPrompt(withThought);
    const kept = out.find(
      (b) =>
        b.kind === "system" && (b as { role?: string }).role === "done-marker",
    );
    expect(kept).toBeDefined();
    expect((kept as { evidenceDetail?: string }).evidenceDetail).toContain(
      "改动文件: a.ts",
    );
    // …while a SPEECH after it still folds the marker away (State 2).
    const withSpeech: TerminalRecord = [
      ...withThought.slice(0, 4),
      { kind: "herta", surface: "speech", text: "改完了。" },
    ];
    expect(
      compactRecordForPrompt(withSpeech).find(
        (b) =>
          b.kind === "system" &&
          (b as { role?: string }).role === "done-marker",
      ),
    ).toBeUndefined();
  });

  it("skips Planning blocks (returns null)", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: 'Planning {"op":"add","item":{"id":"x"}}',
    };
    expect(digestSystemBlock(block)).toBeNull();
  });

  it("renders bg digests as one lifecycle line; skips todo digests (2026-07-23)", () => {
    const bg: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "↳ background bg-1: running",
      digest: { kind: "bg", id: "bg-1", state: "running" },
    };
    expect(digestSystemBlock(bg)).toBe("background bg-1: running");
    const todo: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "todo list (2):\n[~] a\n[ ] b",
      digest: { kind: "todo", total: 2, completed: 0 },
    };
    expect(digestSystemBlock(todo)).toBeNull();
  });

  it("renders the B1 no-op marker as '（板砖无产出）'", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "无产出 — 这次没有触发任何文件、目录或命令操作。",
    };
    expect(digestSystemBlock(block)).toBe("（板砖无产出）");
  });

  it("digests a role:noop-marker block to （板砖无产出）", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "无产出 — 这次没有触发任何文件、目录或命令操作。",
      role: "noop-marker",
    };
    expect(digestSystemBlock(block)).toBe("（板砖无产出）");
  });

  it("still digests a roleless 无产出 body (fallback for pre-role persisted records)", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "无产出 — 旧记录",
    };
    expect(digestSystemBlock(block)).toBe("（板砖无产出）");
  });

  it("falls back to first non-empty line truncated to 60 chars for unknown 差分协处理器 bodies", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: 'SomeUnknownVerb {"data":"x"}',
    };
    expect(digestSystemBlock(block)).toBe('SomeUnknownVerb {"data":"x"}');
  });
});

describe("digestSystemBlock — 系统 entries", () => {
  it("skips patch preview blocks (covered by Writing)", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "patch preview: scripts/merge-sort.js\n\n```diff\n--- /dev/null\n+++ b/scripts/merge-sort.js\n+content\n```",
    };
    expect(digestSystemBlock(block)).toBeNull();
  });

  it("renders all-pass tests as 'Tests: N/N passed'", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "↳ tests: 8 passed, 0 failed",
    };
    expect(digestSystemBlock(block)).toBe("Tests: 8/8 passed");
  });

  it("renders mixed-result tests as 'Tests: N passed, M failed'", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "↳ tests: 6 passed, 2 failed",
    };
    expect(digestSystemBlock(block)).toBe("Tests: 6 passed, 2 failed");
  });

  it("renders tool failures as '<tool> failed (<code>)'", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "↳ write_new_file failed: file_exists: scripts/merge_sort.py already exists",
    };
    expect(digestSystemBlock(block)).toBe(
      "write_new_file failed (file_exists)",
    );
  });

  it("falls back to first non-empty line truncated to 60 chars for unknown 系统 bodies", () => {
    const longBody = `[文件内容：foo.ts]\n${"x".repeat(200)}`;
    const block: SystemBlock = {
      kind: "system",
      label: "系统",
      body: longBody,
    };
    expect(digestSystemBlock(block)).toBe("[文件内容：foo.ts]");
  });

  it("truncates a very long first line to 60 chars", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "x".repeat(200),
    };
    const out = digestSystemBlock(block);
    expect(out).not.toBeNull();
    expect((out ?? "").length).toBe(60);
  });
});

describe("buildCompactionBody — assemble summary block body", () => {
  it("wraps a single non-skipped digest in the [历史已压缩 · 板砖] header", () => {
    const blocks: SystemBlock[] = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"foo.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"foo.ts"}',
      },
    ];
    expect(buildCompactionBody(blocks)).toBe(
      "[历史已压缩 · 板砖]\n- Reading foo.ts\n- Writing foo.ts",
    );
  });

  it("coalesces consecutive Reading entries into one comma-joined bullet", () => {
    const blocks: SystemBlock[] = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"b.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"c.ts"}',
      },
    ];
    expect(buildCompactionBody(blocks)).toBe(
      "[历史已压缩 · 板砖]\n- Reading a.ts, b.ts, c.ts",
    );
  });

  it("coalesces consecutive Writing entries similarly", () => {
    const blocks: SystemBlock[] = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"b.ts"}',
      },
    ];
    expect(buildCompactionBody(blocks)).toBe(
      "[历史已压缩 · 板砖]\n- Writing a.ts, b.ts",
    );
  });

  it("does NOT coalesce across verb changes", () => {
    const blocks: SystemBlock[] = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"b.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"c.ts"}',
      },
    ];
    expect(buildCompactionBody(blocks)).toBe(
      "[历史已压缩 · 板砖]\n- Reading a.ts\n- Writing b.ts\n- Reading c.ts",
    );
  });

  it("skips Planning and patch preview entries silently", () => {
    const blocks: SystemBlock[] = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      { kind: "system", label: "差分协处理器", body: 'Planning {"op":"add"}' },
      {
        kind: "system",
        label: "系统",
        body: "patch preview: a.ts\n\n```diff\n+x\n```",
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"a.ts"}',
      },
    ];
    expect(buildCompactionBody(blocks)).toBe(
      "[历史已压缩 · 板砖]\n- Reading a.ts\n- Writing a.ts",
    );
  });

  it("returns empty string when every input block hits a skip rule", () => {
    const blocks: SystemBlock[] = [
      { kind: "system", label: "差分协处理器", body: 'Planning {"op":"add"}' },
      {
        kind: "system",
        label: "系统",
        body: "patch preview: x\n```diff\n+y\n```",
      },
    ];
    expect(buildCompactionBody(blocks)).toBe("");
  });

  it("returns empty string for an empty input list", () => {
    expect(buildCompactionBody([])).toBe("");
  });

  it("mixes Reading-coalesce with a tool-fail in the middle correctly", () => {
    const blocks: SystemBlock[] = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"b.ts"}',
      },
      {
        kind: "system",
        label: "系统",
        body: "↳ write_new_file failed: file_exists: a.ts",
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"c.ts"}',
      },
    ];
    expect(buildCompactionBody(blocks)).toBe(
      "[历史已压缩 · 板砖]\n- Reading a.ts, b.ts\n- write_new_file failed (file_exists)\n- Reading c.ts",
    );
  });
});

describe("compactRecordForPrompt — walker", () => {
  it("returns an empty record for empty input", () => {
    expect(compactRecordForPrompt([])).toEqual([]);
  });

  it("returns input unchanged when there are no system blocks", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "hi" },
      { kind: "herta", surface: "speech", text: "yes." },
    ];
    expect(compactRecordForPrompt(record)).toEqual(record);
  });

  it("passes through a singleton system block (run too short to compact)", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "hi" },
      { kind: "system", label: "系统", body: "无产出 — some marker" },
      { kind: "herta", surface: "speech", text: "yes." },
    ];
    expect(compactRecordForPrompt(record)).toEqual(record);
  });

  it("compacts a run of ≥2 contiguous system blocks into one summary block", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "改一下" },
      { kind: "herta", surface: "speech", text: "@板砖" },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"a.ts"}',
      },
      { kind: "herta", surface: "speech", text: "done." },
    ];
    const compacted = compactRecordForPrompt(record);
    expect(compacted).toHaveLength(4);
    expect(compacted[0]).toEqual(record[0]);
    expect(compacted[1]).toEqual(record[1]);
    expect(compacted[2]).toEqual({
      kind: "system",
      label: "系统",
      body: "[历史已压缩 · 板砖]\n- Reading a.ts\n- Writing a.ts",
    });
    expect(compacted[3]).toEqual(record[4]);
  });

  it("treats beat-interrupted runs as separate runs (each gets its own summary)", () => {
    // Spec §3: "When an in-turn beat fires between two system blocks
    // of the same invocation, the run gets split — the result is two
    // smaller summary blocks rather than one."
    const record: TerminalRecord = [
      { kind: "user", text: "x" },
      { kind: "herta", surface: "speech", text: "@板砖" },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"b.ts"}',
      },
      { kind: "herta", surface: "speech", text: "beat between" }, // beat splits run
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"a.ts"}',
      },
      { kind: "system", label: "系统", body: "↳ tests: 8 passed, 0 failed" },
      { kind: "herta", surface: "speech", text: "done." },
    ];
    const compacted = compactRecordForPrompt(record);
    // Expected layout:
    //   [user, herta@板砖, summary1, beat, summary2, herta-done]
    expect(compacted).toHaveLength(6);
    expect(compacted[2]).toEqual({
      kind: "system",
      label: "系统",
      body: "[历史已压缩 · 板砖]\n- Reading a.ts, b.ts",
    });
    expect(compacted[3]).toEqual(record[4]); // the beat
    expect(compacted[4]).toEqual({
      kind: "system",
      label: "系统",
      body: "[历史已压缩 · 板砖]\n- Writing a.ts\n- Tests: 8/8 passed",
    });
  });

  it("preserves HertaBlock.selfCorrection verbatim across compactable surroundings", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "改一下" },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"a.ts"}',
      },
      {
        kind: "herta",
        surface: "speech",
        text: "嗯，重写过的。",
        selfCorrection: "不该跟着叫瓦尔特杨叔",
      },
    ];
    const compacted = compactRecordForPrompt(record);
    expect(compacted).toHaveLength(3);
    expect(compacted[2]).toEqual({
      kind: "herta",
      surface: "speech",
      text: "嗯，重写过的。",
      selfCorrection: "不该跟着叫瓦尔特杨叔",
    });
  });

  it("passes through a skip-only run verbatim (no empty-header summary)", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "x" },
      { kind: "system", label: "差分协处理器", body: 'Planning {"op":"add"}' },
      {
        kind: "system",
        label: "系统",
        body: "patch preview: a.ts\n```diff\n+x\n```",
      },
      { kind: "herta", surface: "speech", text: "done." },
    ];
    const compacted = compactRecordForPrompt(record);
    // The 2-block run is skip-only → buildCompactionBody returns "" →
    // we pass the original blocks through.
    expect(compacted).toEqual(record);
  });

  it("respects opts.minRunSize", () => {
    const record: TerminalRecord = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"b.ts"}',
      },
    ];
    // With minRunSize=3, a 2-block run passes through.
    expect(compactRecordForPrompt(record, { minRunSize: 3 })).toEqual(record);
    // With minRunSize=2 (default), a 2-block run compacts.
    expect(compactRecordForPrompt(record, { minRunSize: 2 })).toHaveLength(1);
  });

  it("does not mutate the input record", () => {
    const record: TerminalRecord = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"a.ts"}',
      },
    ];
    const snapshot = JSON.parse(JSON.stringify(record));
    compactRecordForPrompt(record);
    expect(record).toEqual(snapshot);
  });
});

describe("compactRecordForPrompt — done-marker two-state lifecycle", () => {
  const doneMarker = (detail?: string): SystemBlock => ({
    kind: "system",
    label: "差分协处理器",
    body: "完成 · 1 file · tests 12/12",
    role: "done-marker",
    ...(detail ? { evidenceDetail: detail } : {}),
  });

  it("an excerpt is verbatim in its own turn and a CITATION afterwards (ADR 0027)", () => {
    const excerpt = (): TerminalRecordBlock => ({
      kind: "system",
      label: "差分协处理器",
      body: "↳ excerpt src/a.ts:120-121",
      digest: { kind: "excerpt", path: "src/a.ts", from: 120, to: 121 },
      evidenceDetail: "↳ 摘录 src/a.ts:120-121\n120\tconst x = 1;",
    });
    // The turn it happened in: the content must reach Herta, or she cannot
    // quote what the user asked to see.
    const live: TerminalRecord = [
      { kind: "user", text: "把那两行贴出来" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      excerpt(),
    ];
    const liveOut = compactRecordForPrompt(live);
    expect(
      liveOut.some(
        (b) =>
          b.kind === "system" &&
          (b as { evidenceDetail?: string }).evidenceDetail?.includes(
            "const x = 1;",
          ) === true,
      ),
    ).toBe(true);

    // Later turns: a long run folds it into the summary. The citation
    // survives (she still knows she was shown that span); the content does
    // not (it stops costing tokens every turn thereafter).
    const later: TerminalRecord = [
      { kind: "user", text: "把那两行贴出来" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      { kind: "system", label: "差分协处理器", body: "Reading src/a.ts" },
      excerpt(),
      { kind: "system", label: "差分协处理器", body: "Reading src/b.ts" },
      { kind: "herta", surface: "speech", text: "贴好了。" },
      { kind: "user", text: "下一件事" },
    ];
    const out = compactRecordForPrompt(later);
    const text = JSON.stringify(out);
    expect(text).not.toContain("const x = 1;");
    expect(text).toContain("Excerpt src/a.ts:120-121");
  });

  it("State 1 (verdict turn): passes the done-marker through verbatim with evidenceDetail", () => {
    const record: TerminalRecord = [
      { kind: "system", label: "差分协处理器", body: "Writing a.ts" },
      { kind: "system", label: "差分协处理器", body: "↳ exit 0 · 1 lines" },
      doneMarker("↳ 输出:\nRESULT=42"),
      // no herta block after → verdict not yet spoken
    ];
    const out = compactRecordForPrompt(record);
    const marker = out.find(
      (b) =>
        b.kind === "system" && (b as { role?: string }).role === "done-marker",
    );
    expect(marker).toBeDefined();
    expect((marker as { evidenceDetail?: string }).evidenceDetail).toContain(
      "RESULT=42",
    );
    // The non-marker system blocks compacted into a summary before it.
    const summary = out.find(
      (b) =>
        b.kind === "system" &&
        (b as { body: string }).body.includes("历史已压缩"),
    );
    expect(summary).toBeDefined();
  });

  it("State 2 (verdict spoken): drops the done-marker's evidenceDetail, folds body in", () => {
    const record: TerminalRecord = [
      { kind: "system", label: "差分协处理器", body: "Writing a.ts" },
      doneMarker("↳ 输出:\nRESULT=42"),
      { kind: "herta", surface: "speech", text: "板砖搞定了。" }, // verdict spoken
    ];
    const out = compactRecordForPrompt(record);
    // No surviving block carries evidenceDetail (the roll-up was dropped).
    const survivingDetail = out.find(
      (b) =>
        b.kind === "system" &&
        (b as { evidenceDetail?: string }).evidenceDetail !== undefined,
    );
    expect(survivingDetail).toBeUndefined();
    // The herta block is preserved.
    expect(out.some((b) => b.kind === "herta")).toBe(true);
  });

  it("a run with no done-marker compacts exactly as before (regression)", () => {
    const record: TerminalRecord = [
      { kind: "system", label: "差分协处理器", body: "Reading a.ts" },
      { kind: "system", label: "差分协处理器", body: "Reading b.ts" },
    ];
    const out = compactRecordForPrompt(record);
    expect(out).toHaveLength(1);
    expect((out[0] as { body: string }).body).toContain("历史已压缩");
  });

  it("State 1: does not drop system blocks that follow the pass-through done-marker", () => {
    // done-marker not last in its run (no herta after → State 1). The trailing
    // system block must survive (regression guard for the i=j drop bug).
    const record: TerminalRecord = [
      { kind: "system", label: "差分协处理器", body: "Reading a.ts" },
      doneMarker("↳ 输出:\nRESULT=1"),
      { kind: "system", label: "差分协处理器", body: "Writing b.ts" },
    ];
    const out = compactRecordForPrompt(record);
    // The done-marker passes through verbatim with its detail.
    const marker = out.find(
      (b) =>
        b.kind === "system" && (b as { role?: string }).role === "done-marker",
    );
    expect(marker).toBeDefined();
    expect((marker as { evidenceDetail?: string }).evidenceDetail).toContain(
      "RESULT=1",
    );
    // The trailing "Writing b.ts" content is NOT lost (verbatim, since it's a
    // lone run of 1 < minRunSize, OR folded if you change minRunSize — assert
    // the content survives somewhere in the output).
    const survives = out.some(
      (b) =>
        b.kind === "system" && (b as { body: string }).body.includes("b.ts"),
    );
    expect(survives).toBe(true);
  });

  it("State 1: re-collapses a multi-block suffix after the pass-through done-marker", () => {
    const record: TerminalRecord = [
      doneMarker("↳ 输出:\nR=0"),
      { kind: "system", label: "差分协处理器", body: "Reading x.ts" },
      { kind: "system", label: "差分协处理器", body: "Reading y.ts" },
    ];
    const out = compactRecordForPrompt(record);
    // done-marker first (verbatim), then the two Readings collapse to a summary.
    expect(out[0]?.kind).toBe("system");
    expect((out[0] as { role?: string }).role).toBe("done-marker");
    const summary = out.find(
      (b) =>
        b.kind === "system" &&
        (b as { body: string }).body.includes("历史已压缩"),
    );
    expect(summary).toBeDefined();
    // Both x.ts and y.ts survive (in the summary).
    expect((summary as { body: string }).body).toContain("x.ts");
    expect((summary as { body: string }).body).toContain("y.ts");
  });
});

describe("digestSystemBlock — structured digest field (M-projection-3)", () => {
  // Blocks written since 2026-07-04 carry `digest` data; the body-regex
  // path above survives only for pre-digest persisted records.

  it("renders op digests: Reading/Writing plain, Running backticked, Planning skipped", () => {
    const base = { kind: "system" as const, label: "差分协处理器" as const };
    expect(
      digestSystemBlock({
        ...base,
        body: "Reading src/foo.ts",
        digest: { kind: "op", verb: "Reading", arg: "src/foo.ts" },
      }),
    ).toBe("Reading src/foo.ts");
    expect(
      digestSystemBlock({
        ...base,
        body: "Running pnpm test",
        digest: { kind: "op", verb: "Running", arg: "pnpm test" },
      }),
    ).toBe("Running `pnpm test`");
    expect(
      digestSystemBlock({
        ...base,
        body: "Planning add step",
        digest: { kind: "op", verb: "Planning", arg: "add step" },
      }),
    ).toBeNull();
  });

  it("digest takes precedence over a body the legacy regexes would misread", () => {
    // Human-form bodies (summarizeInput, 2026-06) never matched the
    // legacy JSON patterns — with the digest present the body is not
    // parsed at all.
    const out = digestSystemBlock({
      kind: "system",
      label: "差分协处理器",
      body: "Writing scripts/merge_sort.py",
      digest: { kind: "op", verb: "Writing", arg: "scripts/merge_sort.py" },
    });
    expect(out).toBe("Writing scripts/merge_sort.py");
  });

  it("renders tests digests from status + summary (both labels' legacy paths never matched real bodies)", () => {
    expect(
      digestSystemBlock({
        kind: "system",
        label: "差分协处理器",
        body: "↳ tests: exit 0, 3.21s",
        digest: { kind: "tests", status: "passed", summary: "exit 0, 3.21s" },
      }),
    ).toBe("Tests passed (exit 0, 3.21s)");
    expect(
      digestSystemBlock({
        kind: "system",
        label: "差分协处理器",
        body: "↳ tests: exit 1, 5.02s",
        digest: { kind: "tests", status: "failed", summary: "exit 1, 5.02s" },
      }),
    ).toBe("Tests failed (exit 1, 5.02s)");
  });

  it("renders tool-fail digests and skip digests", () => {
    expect(
      digestSystemBlock({
        kind: "system",
        label: "系统",
        body: "↳ edit_file failed: stale_read: file changed",
        digest: { kind: "tool-fail", tool: "edit_file", code: "stale_read" },
      }),
    ).toBe("edit_file failed (stale_read)");
    expect(
      digestSystemBlock({
        kind: "system",
        label: "系统",
        body: "patch preview: x.ts\n```diff\n+1\n```",
        digest: { kind: "skip" },
      }),
    ).toBeNull();
  });

  it("text digests fall back to the first line, truncated to 60 chars", () => {
    const long = `${"x".repeat(80)}\nsecond line`;
    const out = digestSystemBlock({
      kind: "system",
      label: "差分协处理器",
      body: long,
      digest: { kind: "text", text: long },
    });
    // The cut is marked and still fits the 60-char budget.
    expect(out).toBe(`${"x".repeat(59)}…`);
    expect((out ?? "").length).toBe(60);
  });

  it("does not mark a first line that fit", () => {
    const out = digestSystemBlock({
      kind: "system",
      label: "差分协处理器",
      body: "x".repeat(60),
      digest: { kind: "text", text: "x".repeat(60) },
    });
    expect(out).toBe("x".repeat(60));
  });

  it("structured Reading lines coalesce in buildCompactionBody like legacy ones", () => {
    const body = buildCompactionBody([
      {
        kind: "system",
        label: "差分协处理器",
        body: "Reading a.ts",
        digest: { kind: "op", verb: "Reading", arg: "a.ts" },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "Reading b.ts",
        digest: { kind: "op", verb: "Reading", arg: "b.ts" },
      },
    ]);
    expect(body).toContain("- Reading a.ts, b.ts");
  });

  it("a block WITHOUT digest still digests via the legacy body path (pre-digest records)", () => {
    expect(
      digestSystemBlock({
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"old.ts"}',
      }),
    ).toBe("Reading old.ts");
  });
});

describe("compaction markers — session language", () => {
  const excerpt: SystemBlock = {
    kind: "system",
    label: "差分协处理器",
    body: "↳ excerpt src/a.ts:120-140",
    digest: { kind: "excerpt", path: "src/a.ts", from: 120, to: 140 },
    evidenceDetail: "↳ 摘录 src/a.ts:120-140\n120\tconst x = 1;",
  };
  const noop: SystemBlock = {
    kind: "system",
    label: "差分协处理器",
    body: "无产出 — 这次没有触发任何文件、目录或命令操作。",
    role: "noop-marker",
  };

  it("defaults to zh so an unlabelled call is unchanged for CN sessions", () => {
    expect(digestSystemBlock(excerpt)).toBe(digestSystemBlock(excerpt, "zh"));
    expect(buildCompactionBody([excerpt, noop])).toBe(
      buildCompactionBody([excerpt, noop], "zh"),
    );
  });

  it("localizes the header, the no-output marker and the excerpt elision", () => {
    const zh = buildCompactionBody([excerpt, noop], "zh");
    const en = buildCompactionBody([excerpt, noop], "en");
    expect(zh).toBe(
      "[历史已压缩 · 板砖]\n- Excerpt src/a.ts:120-140 · 正文已略去\n- （板砖无产出）",
    );
    expect(en).toBe(
      "[history compacted · 板砖]\n- Excerpt src/a.ts:120-140 · body elided\n- (板砖 produced nothing)",
    );
  });

  it("keeps the operation verbs canonical in both languages", () => {
    // Only harness prose localizes. `Reading` / `Writing` / `Running` echo
    // the record body verbatim and must read the same in every session, or
    // the summary stops matching the blocks it summarizes.
    const ops: SystemBlock[] = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"b.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Running {"argv":["npm","test"]}',
      },
    ];
    const bullets = (lang: "zh" | "en") =>
      buildCompactionBody(ops, lang).split("\n").slice(1).join("\n");
    expect(bullets("en")).toBe(bullets("zh"));
    expect(bullets("zh")).toContain("Reading a.ts");
  });

  it("threads lang from compactRecordForPrompt into the summary block", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "show me those lines" },
      { kind: "herta", surface: "speech", text: "@板砖 go." },
      { kind: "system", label: "差分协处理器", body: "Reading src/a.ts" },
      excerpt,
      { kind: "herta", surface: "speech", text: "there." },
    ];
    const en = JSON.stringify(compactRecordForPrompt(record, { lang: "en" }));
    expect(en).toContain("[history compacted · 板砖]");
    expect(en).toContain("body elided");
    // The content itself is gone either way — the note describes a real loss.
    expect(en).not.toContain("const x = 1;");
  });
});
