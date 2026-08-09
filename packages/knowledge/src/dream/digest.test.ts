import type { TerminalRecordBlock } from "@herta/core";
import { describe, expect, it } from "vitest";
import { buildEpisodeDigest } from "./digest.js";

const blocks: TerminalRecordBlock[] = [
  { kind: "user", text: "加个 --verbose" },
  { kind: "herta", surface: "thought", text: "又是 flag。" },
  { kind: "herta", surface: "speech", text: "@板砖 去加。" },
  {
    kind: "system",
    label: "差分协处理器",
    body: "完成 · 1 file",
    evidenceDetail: "↳ targeted test pass",
    role: "done-marker",
  },
  { kind: "herta", surface: "speech", text: "加好了，只跑了定向测试。" },
];

describe("buildEpisodeDigest — attachments (ADR 0033)", () => {
  // The ADR claims dreams need no new rule for attachments, because the
  // citation rides `body` and the document's text rides `evidenceDetail`,
  // which no dream ever reads. That is a claim about behaviour, so it is
  // pinned here rather than asserted in prose: she should be able to dream
  // that the 开拓者 handed her a spec, and never dream its contents.
  const withAttachment: TerminalRecordBlock[] = [
    { kind: "user", text: "看看这个" },
    {
      kind: "system",
      label: "系统",
      body: "附件 spec.md · 120 行 · 4.8K 字 · .herta/attachments/s1/spec.md",
      evidenceDetail: "↳ 附件 spec.md\nCONFIDENTIAL ROADMAP Q4 REVENUE TARGET",
      digest: {
        kind: "attachment",
        name: "spec.md",
        path: ".herta/attachments/s1/spec.md",
        lines: 120,
        chars: 4800,
      },
    },
    { kind: "herta", surface: "speech", text: "看完了。" },
  ];

  it("keeps the citation and never the document body", () => {
    const d = buildEpisodeDigest(withAttachment);
    expect(d).toContain("附件 spec.md");
    expect(d).not.toContain("CONFIDENTIAL");
    expect(d).not.toContain("REVENUE");
  });
});

describe("buildEpisodeDigest", () => {
  it("includes user + herta lines and the verified outcome evidence", () => {
    const d = buildEpisodeDigest(blocks);
    expect(d).toContain("加个 --verbose");
    expect(d).toContain("我（内心独白）：又是 flag。"); // thought → 内心独白
    expect(d).toContain("@板砖 去加");
    expect(d).toContain("完成 · 1 file");
    expect(d).toContain("targeted test pass");
  });
  it("labels the outcome spine as verified backend evidence", () => {
    expect(buildEpisodeDigest(blocks)).toContain("差分协处理器");
  });
  it("omits an outcome spine when the episode has no coding system blocks", () => {
    const chat: TerminalRecordBlock[] = [
      { kind: "user", text: "闲聊" },
      { kind: "herta", surface: "speech", text: "终端外面有噪声。" },
    ];
    const d = buildEpisodeDigest(chat);
    expect(d).not.toContain("差分协处理器");
    expect(d).toContain("终端外面有噪声");
  });
  it("surfaces a supervisor self-correction as a labeled beat before the line", () => {
    const corrected: TerminalRecordBlock[] = [
      { kind: "user", text: "瓦尔特那边怎么说" },
      {
        kind: "herta",
        surface: "speech",
        text: "瓦尔特说再等等。",
        selfCorrection: "把瓦尔特说成了杨叔，已更正",
      },
    ];
    const d = buildEpisodeDigest(corrected);
    expect(d).toContain("〔黑塔的自我更正：把瓦尔特说成了杨叔，已更正〕");
    // the marker precedes the corrected speech line
    const lines = d.split("\n");
    const markerIdx = lines.findIndex((l) => l.includes("自我更正"));
    const speechIdx = lines.findIndex((l) => l.includes("瓦尔特说再等等"));
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBeLessThan(speechIdx);
  });
  it("adds no self-correction marker for a thought block or a plain speech", () => {
    const plain: TerminalRecordBlock[] = [
      { kind: "herta", surface: "speech", text: "在。" },
      { kind: "herta", surface: "thought", text: "随便他。" },
    ];
    expect(buildEpisodeDigest(plain)).not.toContain("自我更正");
  });
  it("drops live-work chrome: bg rows, todo layout, patch previews, 待办 roll-up", () => {
    const coding: TerminalRecordBlock[] = [
      { kind: "user", text: "修一下解析器" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      {
        kind: "system",
        label: "系统",
        body: "patch preview: a.ts\n\n```diff\n+++ b/a.ts\n+x\n```",
        digest: { kind: "skip" },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "todo list (2):\n[ ] 修解析器\n[x] 读文件",
        digest: { kind: "todo", total: 2, completed: 1 },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "↳ background bg-1: running",
        digest: { kind: "bg", id: "bg-1", state: "running" },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "Writing a.ts",
        digest: { kind: "op", verb: "Writing", arg: "a.ts" },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "完成 · 1 个文件",
        role: "done-marker",
        evidenceDetail: "↳ 改动文件: a.ts\n↳ 待办: 补测试",
      },
      { kind: "herta", surface: "speech", text: "改完了。" },
    ];
    const d = buildEpisodeDigest(coding);
    expect(d).not.toContain("```diff");
    expect(d).not.toContain("todo list");
    expect(d).not.toContain("background bg-1");
    expect(d).not.toContain("待办");
    // The outcome spine survives: op rows, the marker, its files roll-up.
    expect(d).toContain("Writing a.ts");
    expect(d).toContain("完成 · 1 个文件");
    expect(d).toContain("改动文件: a.ts");
  });
  it("drops a legacy pre-digest patch preview by body prefix", () => {
    const legacy: TerminalRecordBlock[] = [
      { kind: "herta", surface: "speech", text: "看。" },
      {
        kind: "system",
        label: "系统",
        body: "patch preview: old.ts\n\n```diff\n+y\n```",
      },
    ];
    expect(buildEpisodeDigest(legacy)).not.toContain("patch preview");
  });
});
