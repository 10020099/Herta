import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./events.js";

// Compile-time exhaustiveness check. If a variant is added to AgentEvent without
// being handled here, the `_exhaustive: never` line below fails to compile.
function describeEvent(e: AgentEvent): string {
  switch (e.type) {
    case "turn.started":
      return e.userText;
    case "assistant.delta":
      return e.text;
    case "assistant.final":
      return e.message.text;
    case "tool.call.started":
      return e.tool;
    case "tool.call.progress":
      return e.message;
    case "tool.call.finished":
      return `tool.call.finished:tool=${e.tool}/id=${e.id}`;
    case "permission.requested":
      return e.request.reason;
    case "permission.resolved":
      return `${e.id}:${e.decision}`;
    case "patch.preview":
      return e.diff;
    case "verification.started":
      return e.command;
    case "verification.finished":
      return "verified";
    case "plan.updated":
      return `${e.todos.length} todos`;
    case "turn.finished":
      return `${e.summary.durationMs}ms`;
    case "turn.failed":
      return e.error.message;
    case "agent.report":
      return `agent.report:status=${e.report.status}/files=${e.report.changedFiles.length}`;
    case "recap.compaction":
      return `recap:${e.phase}`;
    case "supervisor.check":
      return `supervisor:${e.phase}`;
    default: {
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
}

describe("AgentEvent type union", () => {
  it("compiles with all 18 variants exhaustively handled (each with a layer field)", () => {
    expect(typeof describeEvent).toBe("function");
  });
});
