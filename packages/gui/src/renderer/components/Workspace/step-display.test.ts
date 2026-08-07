import { describe, expect, it } from "vitest";
import type { MessageKey } from "../../i18n/keys.js";
import type { SystemBlock } from "./group-record.js";
import {
  latestOpStep,
  latestTodoProgressStep,
  stepDisplayBody,
  stepDisplayDetail,
} from "./step-display.js";

// zh-flavored fake catalog: proves localization is applied without coupling
// the test to the real message files.
const ZH: Partial<Record<MessageKey, string>> = {
  "activity.verb.reading": "读取",
  "activity.verb.writing": "写入",
  "activity.result.tests": "测试",
  "activity.result.failed": "失败",
  "activity.result.exit": "退出",
  "activity.result.lines": "行",
  "activity.step.patchPreview": "补丁预览",
  "activity.bg.label": "后台",
  "activity.bg.running": "运行中",
  "activity.bg.stopped": "已停止",
  "activity.bg.exited": "已退出",
  "activity.bg.signal": "信号中止",
  "activity.todo.list": "任务清单",
  "activity.todo.step": "步骤",
  "evidence.output": "输出",
  "evidence.excerpt": "摘录",
  "evidence.files": "改动文件",
  "evidence.risks": "风险",
  "evidence.todos": "待办",
  "evidence.error": "错误",
};
const t = (key: MessageKey): string => ZH[key] ?? key;

/** en-flavored fake catalog — the case the structured lane exists for. */
const EN: Partial<Record<MessageKey, string>> = {
  "evidence.output": "output",
  "evidence.excerpt": "excerpt",
  "evidence.files": "changed files",
  "evidence.risks": "risks",
  "evidence.todos": "to do",
  "evidence.error": "error",
};
const tEn = (key: MessageKey): string => EN[key] ?? key;

const sys = (body: string, digest?: SystemBlock["digest"]): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body,
  ...(digest !== undefined ? { digest } : {}),
});

describe("stepDisplayBody — bg + todo digests (2026-07-23)", () => {
  it("localizes background lifecycle rows, incl. the signal case", () => {
    expect(
      stepDisplayBody(
        sys("↳ background bg-1: running", {
          kind: "bg",
          id: "bg-1",
          state: "running",
        }),
        t,
      ),
    ).toBe("↳ 后台 bg-1: 运行中");
    expect(
      stepDisplayBody(
        sys("↳ background bg-1: exited (signal)", {
          kind: "bg",
          id: "bg-1",
          state: "exited",
          exitCode: null,
        }),
        t,
      ),
    ).toBe("↳ 后台 bg-1: 已退出 (信号中止)");
    expect(
      stepDisplayBody(
        sys("↳ background bg-1: exited (0)", {
          kind: "bg",
          id: "bg-1",
          state: "exited",
          exitCode: 0,
        }),
        t,
      ),
    ).toBe("↳ 后台 bg-1: 已退出 (0)");
  });

  it("localizes the todo layout header, keeping item lines verbatim", () => {
    const body = "todo list (2):\n[~] 定位 bug\n[ ] 修复";
    expect(
      stepDisplayBody(sys(body, { kind: "todo", total: 2, completed: 0 }), t),
    ).toBe("任务清单 (0/2):\n[~] 定位 bug\n[ ] 修复");
  });

  it("renders a todo progress row as the localized step line (2026-07-23)", () => {
    // In-flight item is #completed+1 of the sequential plan.
    expect(
      stepDisplayBody(
        sys("todo 1/3: 修复", {
          kind: "todo",
          total: 3,
          completed: 1,
          current: "修复",
        }),
        t,
      ),
    ).toBe("步骤 2/3 · 修复");
    // All done (no current): counts only.
    expect(
      stepDisplayBody(
        sys("todo 3/3", { kind: "todo", total: 3, completed: 3 }),
        t,
      ),
    ).toBe("任务清单 3/3");
  });
});

describe("latestTodoProgressStep + todo headline eligibility (2026-07-23)", () => {
  const layout = sys("todo list (3):\n[~] a\n[ ] b\n[ ] c", {
    kind: "todo",
    total: 3,
    completed: 0,
  });
  const progress = sys("todo 1/3: b", {
    kind: "todo",
    total: 3,
    completed: 1,
    current: "b",
  });

  it("a progress row IS headline-eligible; the multiline layout is not", () => {
    const op = sys("Reading a.ts", {
      kind: "op",
      verb: "Reading",
      arg: "a.ts",
    });
    expect(latestOpStep([op, progress])).toBe(progress);
    // Layout newest → skip back to the op, never the multiline body.
    expect(latestOpStep([op, layout])).toBe(op);
  });

  it("finds the newest progress row for the live line's step context", () => {
    const op = sys("Writing x.ts", {
      kind: "op",
      verb: "Writing",
      arg: "x.ts",
    });
    expect(latestTodoProgressStep([layout, progress, op])).toBe(progress);
    expect(latestTodoProgressStep([layout, op])).toBeUndefined();
    expect(latestTodoProgressStep([op])).toBeUndefined();
  });
});

describe("latestOpStep — failure rows are headline-eligible (2026-07-23)", () => {
  it("returns a trailing tool-fail row instead of hiding it behind the last op", () => {
    const steps = [
      sys("Reading a.ts", { kind: "op", verb: "Reading", arg: "a.ts" }),
      sys("↳ read_file failed: tool_crashed: boom", {
        kind: "tool-fail",
        tool: "read_file",
        code: "tool_crashed",
        message: "boom",
      }),
    ];
    expect(latestOpStep(steps)?.digest?.kind).toBe("tool-fail");
  });
});

describe("stepDisplayBody (display-only localization from digests, D7)", () => {
  it("localizes op verbs", () => {
    expect(
      stepDisplayBody(
        sys("Writing a.ts", { kind: "op", verb: "Writing", arg: "a.ts" }),
        t,
      ),
    ).toBe("写入 a.ts");
  });

  it("localizes the tests label, keeping the summary (data) verbatim", () => {
    expect(
      stepDisplayBody(
        sys("↳ tests: 3 passed", {
          kind: "tests",
          status: "passed",
          summary: "3 passed",
        }),
        t,
      ),
    ).toBe("↳ 测试: 3 passed");
  });

  it("localizes the failed label when the digest carries the message", () => {
    expect(
      stepDisplayBody(
        sys("↳ edit_file failed: stale_read: file changed", {
          kind: "tool-fail",
          tool: "edit_file",
          code: "stale_read",
          message: "file changed",
        }),
        t,
      ),
    ).toBe("↳ edit_file 失败: stale_read: file changed");
  });

  it("falls back to the canonical body for a pre-2026-07-10 tool-fail digest (no message — a digest-only render would drop it)", () => {
    expect(
      stepDisplayBody(
        sys("↳ edit_file failed: stale_read: file changed", {
          kind: "tool-fail",
          tool: "edit_file",
          code: "stale_read",
        }),
        t,
      ),
    ).toBe("↳ edit_file failed: stale_read: file changed");
  });

  it("localizes exit rows from the structured numbers", () => {
    expect(
      stepDisplayBody(
        sys("↳ exit 1 · 0 lines", {
          kind: "text",
          text: "↳ exit 1 · 0 lines",
          exitCode: 1,
          lineCount: 0,
        }),
        t,
      ),
    ).toBe("↳ 退出 1 · 0 行");
  });

  it("falls back to the body for text digests without exit numbers (signal/timeout, old records)", () => {
    expect(
      stepDisplayBody(
        sys("↳ timed out · 0 lines", {
          kind: "text",
          text: "↳ timed out · 0 lines",
        }),
        t,
      ),
    ).toBe("↳ timed out · 0 lines");
  });

  it("swaps only the patch-preview label, keeping files + diff fence verbatim", () => {
    const body = "patch preview: a.ts\n\n```diff\n+x\n```";
    expect(stepDisplayBody(sys(body, { kind: "skip" }), t)).toBe(
      "补丁预览: a.ts\n\n```diff\n+x\n```",
    );
  });

  it("renders records without a digest verbatim", () => {
    expect(stepDisplayBody(sys("Reading a.ts"), t)).toBe("Reading a.ts");
  });
});

describe("stepDisplayDetail — the evidence pane localizes (2026-08-01)", () => {
  /** A block whose canonical detail is the Chinese the bridge composes, with
   *  the structured mirror alongside it — exactly what projectBackendEvent
   *  now writes. */
  const excerptBlock: SystemBlock = {
    kind: "system",
    label: "差分协处理器",
    body: "↳ excerpt src/a.ts:120-121",
    evidenceDetail: "↳ 摘录 src/a.ts:120-121\nconst x = 1;",
    evidence: [
      {
        kind: "excerpt",
        path: "src/a.ts",
        from: 120,
        to: 121,
        text: "const x = 1;",
      },
    ],
  };

  it("translates the section label for an EN session", () => {
    expect(stepDisplayDetail(excerptBlock, tEn)).toBe(
      "↳ excerpt src/a.ts:120-121\nconst x = 1;",
    );
  });

  it("reproduces the canonical string verbatim for a zh session", () => {
    // The zh render must stay byte-identical to the canonical detail — this
    // change is display-only and must not move Chinese output by a character.
    expect(stepDisplayDetail(excerptBlock, t)).toBe(
      excerptBlock.evidenceDetail,
    );
  });

  it("keeps backend-authored payloads verbatim in both languages", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "↳ exit 0 · 2 lines",
      evidenceDetail: "↳ 输出:\nsrc/a.ts:9\nsrc/b.ts:3",
      evidence: [{ kind: "output", text: "src/a.ts:9\nsrc/b.ts:3" }],
    };
    expect(stepDisplayDetail(block, tEn)).toBe(
      "↳ output:\nsrc/a.ts:9\nsrc/b.ts:3",
    );
    expect(stepDisplayDetail(block, t)).toBe(block.evidenceDetail);
  });

  it("composes a multi-section done-marker roll-up in order", () => {
    const marker: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "完成 · 2 个文件",
      role: "done-marker",
      evidenceDetail:
        "↳ 输出:\nok\n↳ 改动文件: a.ts, b.ts\n↳ 风险: 未跑全量\n↳ 待办: 补测试",
      evidence: [
        { kind: "output", text: "ok" },
        { kind: "files", paths: ["a.ts", "b.ts"] },
        { kind: "risks", items: ["未跑全量"] },
        { kind: "todos", items: ["补测试"] },
      ],
    };
    expect(stepDisplayDetail(marker, tEn)).toBe(
      "↳ output:\nok\n↳ changed files: a.ts, b.ts\n↳ risks: 未跑全量\n↳ to do: 补测试",
    );
    expect(stepDisplayDetail(marker, t)).toBe(marker.evidenceDetail);
  });

  it("localizes the bridge-failure marker's error section", () => {
    expect(
      stepDisplayDetail(
        {
          kind: "system",
          label: "差分协处理器",
          body: "失败 · 运行异常中止",
          role: "done-marker",
          evidenceDetail: "↳ 错误: mkdir EACCES",
          evidence: [{ kind: "error", message: "mkdir EACCES" }],
        },
        tEn,
      ),
    ).toBe("↳ error: mkdir EACCES");
  });

  it("falls back to the canonical string for records without sections", () => {
    // Every session persisted before `evidence` existed. The pane must keep
    // showing what it showed before rather than going blank.
    expect(
      stepDisplayDetail(
        {
          kind: "system",
          label: "差分协处理器",
          body: "↳ exit 0 · 1 lines",
          evidenceDetail: "↳ 输出:\nlegacy",
        },
        tEn,
      ),
    ).toBe("↳ 输出:\nlegacy");
  });

  it("returns undefined when the block carries no detail at all", () => {
    expect(stepDisplayDetail(sys("Reading a.ts"), tEn)).toBeUndefined();
  });
});

describe("latestOpStep", () => {
  it("prefers the latest OP over a trailing result row", () => {
    const steps = [
      sys("Running x", { kind: "op", verb: "Running", arg: "x" }),
      sys("↳ exit 1 · 0 lines", { kind: "text", text: "↳ exit 1 · 0 lines" }),
    ];
    expect(latestOpStep(steps)?.body).toBe("Running x");
  });

  it("falls back to the last step when only results exist", () => {
    const steps = [
      sys("↳ exit 1 · 0 lines", { kind: "text", text: "↳ exit 1 · 0 lines" }),
    ];
    expect(latestOpStep(steps)?.body).toBe("↳ exit 1 · 0 lines");
  });
});
