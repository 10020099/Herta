import type { TerminalRecordBlock } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import type { SystemBlock } from "./group-record.js";
import { planContext, planScope, type TodoDigestItem } from "./plan-context.js";

type TodoDigest = Extract<NonNullable<SystemBlock["digest"]>, { kind: "todo" }>;

const user = (text: string): TerminalRecordBlock => ({ kind: "user", text });
const herta = (text: string): TerminalRecordBlock => ({
  kind: "herta",
  surface: "speech",
  text,
});
const sys = (body: string): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body,
});
const marker = (role: "done-marker" | "noop-marker"): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: role === "noop-marker" ? "无产出 — 未改动仓库" : "完成 · 1 file",
  role,
});
const todo = (body: string, digest: TodoDigest): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body,
  digest,
});

const item = (
  content: string,
  status: TodoDigestItem["status"],
): TodoDigestItem => ({ content, status });

/** The dispatch's first todo_write: the multi-line layout block. */
const layout = (): SystemBlock =>
  todo("todo list (3):\n[~] 定位 bug\n[ ] 修复\n[ ] 验证", {
    kind: "todo",
    total: 3,
    completed: 0,
    items: [
      item("定位 bug", "in_progress"),
      item("修复", "pending"),
      item("验证", "pending"),
    ],
  });

/** A later todo_write: the compact progress row. */
const progress = (): SystemBlock =>
  todo("todo 1/3: 修复", {
    kind: "todo",
    total: 3,
    completed: 1,
    current: "修复",
    items: [
      item("定位 bug", "completed"),
      item("修复", "in_progress"),
      item("验证", "pending"),
    ],
  });

describe("planContext", () => {
  it("returns null for an empty record", () => {
    expect(planContext([])).toBeNull();
  });

  it("returns null when the dispatch projected no todo list", () => {
    expect(
      planContext([user("go"), sys("Reading a.ts"), sys("Writing a.ts")]),
    ).toBeNull();
  });

  it("reads the layout block's full list", () => {
    expect(planContext([user("go"), layout()])).toStrictEqual({
      total: 3,
      completed: 0,
      items: [
        item("定位 bug", "in_progress"),
        item("修复", "pending"),
        item("验证", "pending"),
      ],
      itemsKnown: true,
    });
  });

  it("omits `current` when nothing is in progress", () => {
    const ctx = planContext([user("go"), layout()]);
    expect(ctx).not.toBeNull();
    expect(ctx && "current" in ctx).toBe(false);
  });

  it("newest todo projection wins over older ones", () => {
    const ctx = planContext([
      user("go"),
      layout(),
      sys("Reading a.ts"),
      progress(),
      sys("Writing a.ts"),
    ]);
    expect(ctx?.completed).toBe(1);
    expect(ctx?.current).toBe("修复");
    expect(ctx?.items.map((i) => i.status)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
  });

  it("tracks a REWRITTEN list, not a fold of counts onto the first layout", () => {
    // todo_write is full-list replacement: 板砖 dropped 验证 and added two
    // others. Reconstructing from the layout block would show the dead list.
    const rewritten = todo("todo 1/4: 加测试", {
      kind: "todo",
      total: 4,
      completed: 1,
      current: "加测试",
      items: [
        item("定位 bug", "completed"),
        item("加测试", "in_progress"),
        item("修复", "pending"),
        item("跑全量", "pending"),
      ],
    });
    const ctx = planContext([user("go"), layout(), rewritten]);
    expect(ctx?.total).toBe(4);
    expect(ctx?.items.map((i) => i.content)).toEqual([
      "定位 bug",
      "加测试",
      "修复",
      "跑全量",
    ]);
  });

  // The reason this helper exists (D7): an in-turn beat splits one backend
  // run into separate activity groups, so the continuation group's own blocks
  // carry no plan.
  it("crosses a herta beat: a plan projected before the beat is still in scope", () => {
    const ctx = planContext([
      user("go"),
      layout(),
      herta("先定位一下。"),
      sys("Reading a.ts"),
      sys("Writing a.ts"),
    ]);
    expect(ctx?.total).toBe(3);
    expect(ctx?.items).toHaveLength(3);
  });

  it("crosses several herta beats and picks the newest projection across them", () => {
    const ctx = planContext([
      user("go"),
      layout(),
      herta("beat one"),
      progress(),
      herta("beat two"),
      sys("Running vitest"),
    ]);
    expect(ctx?.completed).toBe(1);
    expect(ctx?.current).toBe("修复");
  });

  it("stops at a user block — a previous turn's plan is out of scope", () => {
    expect(
      planContext([layout(), user("下一个任务"), sys("Reading b.ts")]),
    ).toBeNull();
  });

  it("stops at a done-marker — that dispatch already finished", () => {
    expect(
      planContext([
        user("go"),
        layout(),
        progress(),
        marker("done-marker"),
        sys("Reading b.ts"),
      ]),
    ).toBeNull();
  });

  it("stops at a noop-marker too", () => {
    expect(
      planContext([
        user("go"),
        layout(),
        marker("noop-marker"),
        sys("Reading"),
      ]),
    ).toBeNull();
  });

  it("a herta beat AFTER a done-marker does not reopen the finished plan", () => {
    expect(
      planContext([
        user("go"),
        layout(),
        marker("done-marker"),
        herta("搞定了。"),
        sys("Reading b.ts"),
      ]),
    ).toBeNull();
  });

  it("finds a NEW dispatch's plan even when an older finished one precedes it", () => {
    const ctx = planContext([
      user("go"),
      layout(),
      marker("done-marker"),
      herta("再来一轮。"),
      progress(),
      sys("Writing a.ts"),
    ]);
    expect(ctx?.completed).toBe(1);
    expect(ctx?.current).toBe("修复");
  });

  it("a legacy digest without items yields counts, not null", () => {
    const legacy = todo("todo 2/5: 收尾", {
      kind: "todo",
      total: 5,
      completed: 2,
      current: "收尾",
    });
    expect(planContext([user("go"), legacy])).toStrictEqual({
      total: 5,
      completed: 2,
      current: "收尾",
      items: [],
      itemsKnown: false,
    });
  });

  it("distinguishes an unknown list from a genuinely empty one", () => {
    const empty = todo("todo list (0):", {
      kind: "todo",
      total: 0,
      completed: 0,
      items: [],
    });
    expect(planContext([user("go"), empty])).toStrictEqual({
      total: 0,
      completed: 0,
      items: [],
      itemsKnown: true,
    });
  });

  it("prefers an older digest that carries items over a newer one that does not", () => {
    // Only reachable on a record straddling the field's introduction. Counts
    // and rows come from ONE block, so the result stays self-consistent.
    const legacy = todo("todo 2/3: 验证", {
      kind: "todo",
      total: 3,
      completed: 2,
      current: "验证",
    });
    expect(planContext([user("go"), progress(), legacy])).toStrictEqual({
      total: 3,
      completed: 1,
      current: "修复",
      items: [
        item("定位 bug", "completed"),
        item("修复", "in_progress"),
        item("验证", "pending"),
      ],
      itemsKnown: true,
    });
  });

  it("does not look past the boundary for an items-carrying digest", () => {
    const legacy = todo("todo 2/3: 验证", {
      kind: "todo",
      total: 3,
      completed: 2,
      current: "验证",
    });
    // The only digest with items sits in the PREVIOUS turn — unreachable.
    expect(planContext([layout(), user("再来"), legacy])?.itemsKnown).toBe(
      false,
    );
  });

  it("ignores non-todo digests while scanning", () => {
    const opBlock: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "Reading a.ts",
      digest: { kind: "op", verb: "Reading", arg: "a.ts" },
    };
    const ctx = planContext([user("go"), progress(), opBlock]);
    expect(ctx?.current).toBe("修复");
  });

  it("scans a record with no user block at all (windowed tail)", () => {
    // Conversation renders a WINDOW: the turn's user block may be older than
    // recordStart, so the scan simply runs off the front of the array.
    const ctx = planContext([sys("Reading a.ts"), progress()]);
    expect(ctx?.total).toBe(3);
  });
});

describe("planScope — WHY there is no plan (audit 2026-07-26)", () => {
  // planContext's bare null conflates three causes. A caller that RETRACTS a
  // live card on it must tell them apart: only two are definitive.
  it("'plan' when one is in scope", () => {
    expect(planScope([user("go"), layout()]).kind).toBe("plan");
  });

  it("'ended' at a terminal marker — the run is genuinely over", () => {
    expect(planScope([user("go"), layout(), marker("done-marker")]).kind).toBe(
      "ended",
    );
    expect(planScope([user("go"), layout(), marker("noop-marker")]).kind).toBe(
      "ended",
    );
  });

  it("'absent' at a user block — this turn has no plan", () => {
    expect(planScope([layout(), user("新的一轮")]).kind).toBe("absent");
    expect(planScope([user("go"), sys("Reading a.ts")]).kind).toBe("absent");
  });

  it("'unknown' when the window truncated the scan before any boundary", () => {
    // Conversation trims the live window back to its tail bound mid-dispatch,
    // which can drop the todo projection out of the array entirely. No
    // boundary is reached, so nothing about the run's state is knowable —
    // and a live card must NOT read that as an ending.
    expect(planScope([]).kind).toBe("unknown");
    expect(planScope([sys("Reading a.ts"), sys("Writing b.ts")]).kind).toBe(
      "unknown",
    );
  });

  it("a beat alone never ends the scan", () => {
    expect(planScope([user("go"), layout(), herta("我看看")]).kind).toBe(
      "plan",
    );
    expect(planScope([herta("我看看")]).kind).toBe("unknown");
  });
});
