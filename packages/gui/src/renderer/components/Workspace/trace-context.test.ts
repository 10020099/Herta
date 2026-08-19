import type { TerminalRecordBlock } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import { settleTrace, TRACE_MAX_ROWS, traceScope } from "./trace-context.js";

const user = (text = "修一下"): TerminalRecordBlock =>
  ({ kind: "user", text }) as TerminalRecordBlock;
const herta = (text = "看着。"): TerminalRecordBlock =>
  ({ kind: "herta", surface: "speech", text }) as TerminalRecordBlock;
const marker: TerminalRecordBlock = {
  kind: "system",
  label: "差分协处理器",
  body: "完成 · 1 个文件",
  role: "done-marker",
} as TerminalRecordBlock;
const sys = (digest: unknown, body = "row"): TerminalRecordBlock =>
  ({
    kind: "system",
    label: "差分协处理器",
    body,
    digest,
  }) as TerminalRecordBlock;
const op = (verb: string, arg: string) => sys({ kind: "op", verb, arg });
const exit = (exitCode: number | null, lineCount = 3) =>
  sys({ kind: "text", exitCode, lineCount });

describe("traceScope", () => {
  it("collects the current dispatch's ops in order; results settle statuses", () => {
    const s = traceScope([
      user(),
      op("Running", "npm test"),
      exit(1),
      op("Writing", "src/store.mjs"),
      op("Running", "node --test test/"),
      sys({ kind: "tests", status: "passed", summary: "3 passed" }),
      op("Running", "git add -A && git commit -m x"),
    ]);
    expect(s.kind).toBe("trace");
    if (s.kind !== "trace") return;
    expect(s.trace.ops).toEqual([
      {
        verb: "Running",
        arg: "npm test",
        status: "fail",
        note: { kind: "exit", code: 1 },
      },
      // No result row of its own — settled by the next op starting.
      { verb: "Writing", arg: "src/store.mjs", status: "ok" },
      {
        verb: "Running",
        arg: "node --test test/",
        status: "ok",
        note: { kind: "tests", summary: "3 passed", failed: false },
      },
      {
        verb: "Running",
        arg: "git add -A && git commit -m x",
        status: "running",
      },
    ]);
    expect(s.trace.running).toBe(true);
    expect(s.trace.writes).toBe(1);
    expect(s.trace.steps).toBe(4);
    expect(s.trace.firstOrdinal).toBe(0);
  });

  it("a long run trims the list to TRACE_MAX_ROWS but keeps whole-run counts", () => {
    const blocks: TerminalRecordBlock[] = [user()];
    for (let i = 0; i < 30; i += 1) {
      blocks.push(op(i % 5 === 0 ? "Writing" : "Running", `step-${i}`));
      blocks.push(exit(0));
    }
    const s = traceScope(blocks);
    expect(s.kind).toBe("trace");
    if (s.kind !== "trace") return;
    expect(s.trace.ops).toHaveLength(TRACE_MAX_ROWS);
    // The window is the TAIL: newest kept, oldest dropped.
    expect(s.trace.ops[0]?.arg).toBe(`step-${30 - TRACE_MAX_ROWS}`);
    expect(s.trace.ops[TRACE_MAX_ROWS - 1]?.arg).toBe("step-29");
    expect(s.trace.firstOrdinal).toBe(30 - TRACE_MAX_ROWS);
    // Header counts stay honest over the WHOLE dispatch, trim or no trim.
    expect(s.trace.steps).toBe(30);
    expect(s.trace.writes).toBe(6);
  });

  it("herta beats do not stop the scan; the trace spans the whole dispatch", () => {
    const s = traceScope([
      user(),
      op("Reading", "src/store.mjs"),
      exit(0),
      herta(),
      op("Writing", "src/store.mjs"),
    ]);
    expect(s.kind).toBe("trace");
    if (s.kind !== "trace") return;
    expect(s.trace.ops.map((o) => o.arg)).toEqual([
      "src/store.mjs",
      "src/store.mjs",
    ]);
  });

  it("signal exits, tool failures and search notes attach to the last op", () => {
    const s = traceScope([
      user(),
      op("Running", "kill 574"),
      exit(null),
      op("Searching", '"TODO" in src'),
      sys({ kind: "search", matches: 5, files: 2, truncated: false }),
      op("Running", "node x.mjs"),
      sys({ kind: "tool-fail", tool: "bash", code: "timeout" }),
    ]);
    expect(s.kind).toBe("trace");
    if (s.kind !== "trace") return;
    expect(s.trace.ops[0]?.status).toBe("fail");
    expect(s.trace.ops[0]?.note).toEqual({ kind: "signal" });
    expect(s.trace.ops[1]?.note).toEqual({ kind: "matches", n: 5 });
    expect(s.trace.ops[2]?.status).toBe("fail");
    expect(s.trace.ops[2]?.note).toEqual({ kind: "fail", code: "timeout" });
  });

  it("boundaries mirror planScope: marker → ended; user with no ops → absent; off-start with no ops → unknown", () => {
    expect(
      traceScope([user(), op("Running", "ls"), exit(0), marker]).kind,
    ).toBe("ended");
    expect(traceScope([user(), herta()]).kind).toBe("absent");
    expect(traceScope([herta()]).kind).toBe("unknown");
  });

  it("ops after a marker belong to a NEWER chained dispatch — trace, not ended", () => {
    const s = traceScope([
      user(),
      op("Running", "npm test"),
      marker,
      herta(),
      op("Running", "git push"),
    ]);
    expect(s.kind).toBe("trace");
    if (s.kind !== "trace") return;
    expect(s.trace.ops.map((o) => o.arg)).toEqual(["git push"]);
  });

  it("a partial window still yields the ops in hand (recency, not completeness)", () => {
    const s = traceScope([op("Running", "npm test"), exit(0)]);
    expect(s.kind).toBe("trace");
    if (s.kind !== "trace") return;
    expect(s.trace.ops).toHaveLength(1);
  });

  it("settleTrace finishes the running tail for the held (post-run) view", () => {
    const s = traceScope([user(), op("Running", "npm test")]);
    if (s.kind !== "trace") throw new Error("expected trace");
    const settled = settleTrace(s.trace);
    expect(settled.running).toBe(false);
    expect(settled.ops[0]?.status).toBe("ok");
    // Idempotent on an already-settled trace.
    expect(settleTrace(settled)).toBe(settled);
  });
});
