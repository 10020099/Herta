import type { SystemBlock, TodoDigestItem } from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  PLAN_MAX_ROWS,
  planChecklist,
  planStepLine,
  type TodoDigest,
  todoDigestOf,
} from "./plan-strip.js";

function items(
  ...rows: [string, TodoDigestItem["status"]][]
): TodoDigestItem[] {
  return rows.map(([content, status]) => ({ content, status }));
}

const THREE = items(
  ["定位 bug", "completed"],
  ["修 cursor reset", "in_progress"],
  ["加回归测试", "pending"],
);

function digest(over: Partial<TodoDigest> = {}): TodoDigest {
  return {
    kind: "todo",
    total: 3,
    completed: 1,
    current: "修 cursor reset",
    items: THREE,
    ...over,
  };
}

describe("todoDigestOf", () => {
  it("returns the digest for a todo block and null for every other kind", () => {
    const todo: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "todo 1/3: 修 cursor reset",
      digest: digest(),
    };
    const op: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "Reading foo.ts",
      digest: { kind: "op", verb: "Reading", arg: "foo.ts" },
    };
    const bare: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "workspace_set",
    };
    expect(todoDigestOf(todo)?.total).toBe(3);
    expect(todoDigestOf(op)).toBeNull();
    expect(todoDigestOf(bare)).toBeNull();
  });
});

describe("planStepLine", () => {
  it("numbers the in-flight step as completed + 1 (zh)", () => {
    expect(planStepLine(digest(), "zh")).toBe("步骤 2/3 · 修 cursor reset");
  });

  it("uses the same wording the GUI does (en)", () => {
    expect(planStepLine(digest(), "en")).toBe("Step 2/3 · 修 cursor reset");
  });

  it("takes the in-flight item from `items` when the digest carries no `current`", () => {
    // The layout block never carries `current` (its `[~]` mark did the job in
    // place) — a line restated later has no mark to lean on.
    const d = digest({ current: undefined });
    expect(planStepLine(d, "zh")).toBe("步骤 2/3 · 修 cursor reset");
  });

  it("falls back to the counts when nothing is in flight", () => {
    const done = items(
      ["定位 bug", "completed"],
      ["修 cursor reset", "completed"],
      ["加回归测试", "completed"],
    );
    const d = digest({ current: undefined, completed: 3, items: done });
    expect(planStepLine(d, "zh")).toBe("任务清单 3/3");
    expect(planStepLine(d, "en")).toBe("todo list 3/3");
    // Same fallback for a record with no list at all.
    const legacy: TodoDigest = { kind: "todo", total: 3, completed: 3 };
    expect(planStepLine(legacy, "zh")).toBe("任务清单 3/3");
  });

  it("clamps the step number to the total (every item already completed)", () => {
    // A plan can report `current` while all items read completed only through
    // a malformed update; the line must not claim a step 4 of 3.
    const d = digest({ completed: 3, current: "收尾" });
    expect(planStepLine(d, "zh")).toBe("步骤 3/3 · 收尾");
  });

  it("folds a multi-line item onto one row", () => {
    const d = digest({ current: "修 cursor\n  然后跑测试" });
    expect(planStepLine(d, "zh")).toBe("步骤 2/3 · 修 cursor 然后跑测试");
  });
});

describe("planChecklist", () => {
  it("marks done / in-flight / pending rows under a localized header (zh)", () => {
    expect(planChecklist(digest(), "zh")).toEqual([
      "任务清单 (1/3):",
      "✓ 定位 bug",
      "▸ 修 cursor reset",
      "· 加回归测试",
    ]);
  });

  it("localizes the header on the session language (en)", () => {
    expect(planChecklist(digest(), "en")?.[0]).toBe("todo list (1/3):");
  });

  it("renders item text verbatim — it is backend-authored content (D7)", () => {
    const d = digest({
      items: items(["fix `parser.ts` — cursor 没重置", "pending"]),
      total: 1,
      completed: 0,
      current: undefined,
    });
    expect(planChecklist(d, "zh")?.[1]).toBe(
      "· fix `parser.ts` — cursor 没重置",
    );
  });

  it("caps the rows and tails the remainder, localized", () => {
    const many = items(
      ...Array.from(
        { length: PLAN_MAX_ROWS + 3 },
        (_, i) =>
          [`步骤 ${i}`, "pending"] as [string, TodoDigestItem["status"]],
      ),
    );
    const d = digest({
      items: many,
      total: many.length,
      completed: 0,
      current: undefined,
    });
    const zh = planChecklist(d, "zh");
    expect(zh).toHaveLength(PLAN_MAX_ROWS + 2); // header + rows + tail
    expect(zh?.[zh.length - 1]).toBe("… 还有 3 项");
    const en = planChecklist(d, "en");
    expect(en?.[en.length - 1]).toBe("… +3 more");
  });

  it("adds no tail when the list exactly fills the cap", () => {
    const exact = items(
      ...Array.from(
        { length: PLAN_MAX_ROWS },
        (_, i) =>
          [`步骤 ${i}`, "pending"] as [string, TodoDigestItem["status"]],
      ),
    );
    const d = digest({
      items: exact,
      total: exact.length,
      completed: 0,
      current: undefined,
    });
    expect(planChecklist(d, "zh")).toHaveLength(PLAN_MAX_ROWS + 1);
  });

  it("returns null when the list is UNKNOWN, not empty (record predates items)", () => {
    // The caller must fall back to the record's own body — drawing a plan
    // with no steps in it would be a lie about a list we simply never got.
    const legacy: TodoDigest = { kind: "todo", total: 4, completed: 2 };
    expect(planChecklist(legacy, "zh")).toBeNull();
  });

  it("returns a header-only strip for a genuinely empty list", () => {
    const empty = digest({
      items: [],
      total: 0,
      completed: 0,
      current: undefined,
    });
    expect(planChecklist(empty, "zh")).toEqual(["任务清单 (0/0):"]);
  });
});
