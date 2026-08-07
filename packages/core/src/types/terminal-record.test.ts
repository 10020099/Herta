import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type HertaBlock,
  isSystemBlockLabel,
  SYSTEM_BLOCK_LABELS,
  type SystemBlock,
  type SystemBlockDigest,
  type SystemBlockLabel,
  type TerminalRecord,
  type TerminalRecordBlock,
  type TodoDigestItem,
  type UserBlock,
} from "./terminal-record.js";
import type { TodoStatus } from "./todo.js";

describe("SystemBlockLabel", () => {
  it("enumerates exactly 系统 and 差分协处理器", () => {
    expect([...SYSTEM_BLOCK_LABELS].sort()).toEqual(
      ["差分协处理器", "系统"].sort(),
    );
  });

  it("does not include 板砖 — the harness must never emit → 板砖", () => {
    expect(SYSTEM_BLOCK_LABELS).not.toContain(
      "板砖" as unknown as SystemBlockLabel,
    );
  });

  it("isSystemBlockLabel narrows to the two canonical labels", () => {
    expect(isSystemBlockLabel("系统")).toBe(true);
    expect(isSystemBlockLabel("差分协处理器")).toBe(true);
    expect(isSystemBlockLabel("板砖")).toBe(false);
    expect(isSystemBlockLabel("")).toBe(false);
  });
});

describe("TerminalRecord block types", () => {
  it("UserBlock carries kind=user and text", () => {
    const block: UserBlock = { kind: "user", text: "黑塔女士，在吗？" };
    expect(block.kind).toBe("user");
    expect(block.text).toContain("黑塔");
  });

  it("HertaBlock carries kind=herta, surface, and text", () => {
    const block: HertaBlock = {
      kind: "herta",
      surface: "speech",
      text: "说事。你最好真的有事。",
    };
    expect(block.kind).toBe("herta");
  });

  it("SystemBlock carries kind=system, label, body", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "accepted",
    };
    expect(block.label).toBe("差分协处理器");
  });

  it("SystemBlock.label is the SystemBlockLabel union (type-level)", () => {
    expectTypeOf<SystemBlock["label"]>().toEqualTypeOf<
      "系统" | "差分协处理器"
    >();
  });

  it("SystemBlock accepts optional evidenceDetail and role", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "完成 · 1 file · tests 12/12",
      evidenceDetail: "↳ 输出:\nsorted: [1, 2, 2, 3]",
      role: "done-marker",
    };
    expect(block.evidenceDetail).toContain("sorted");
    expect(block.role).toBe("done-marker");
  });

  it("SystemBlock.role accepts noop-marker as well as done-marker", () => {
    const done: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "完成",
      role: "done-marker",
    };
    const noop: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "无产出 …",
      role: "noop-marker",
    };
    expect(done.role).toBe("done-marker");
    expect(noop.role).toBe("noop-marker");
  });

  it("SystemBlock works without the optional fields (backward compat)", () => {
    const block: SystemBlock = { kind: "system", label: "系统", body: "x" };
    expect(block.evidenceDetail).toBeUndefined();
    expect(block.role).toBeUndefined();
  });

  it("a todo digest carries the whole list; its status union IS the backend's", () => {
    // The literals are imported from the backend's TodoItem, never restated
    // here — a new backend status must break this, not slip past a renderer.
    expectTypeOf<TodoDigestItem["status"]>().toEqualTypeOf<TodoStatus>();
    const digest: SystemBlockDigest = {
      kind: "todo",
      total: 2,
      completed: 1,
      current: "修复",
      items: [
        { content: "定位 bug", status: "completed" },
        { content: "修复", status: "in_progress" },
      ],
    };
    expect(digest.kind === "todo" && digest.items?.[1]?.content).toBe("修复");
  });

  it("a todo digest without items still typechecks (records persisted before the field)", () => {
    const legacy: SystemBlockDigest = { kind: "todo", total: 3, completed: 0 };
    expect(legacy.kind === "todo" && legacy.items).toBeUndefined();
  });

  it("TerminalRecordBlock discriminates by kind", () => {
    const blocks: TerminalRecordBlock[] = [
      { kind: "user", text: "..." },
      { kind: "herta", surface: "speech", text: "..." },
      { kind: "system", label: "系统", body: "..." },
    ];
    expect(blocks).toHaveLength(3);
  });

  it("TerminalRecord is a readonly array of TerminalRecordBlock", () => {
    const record: TerminalRecord = [{ kind: "user", text: "hi" }];
    expect(record).toHaveLength(1);
  });
});
