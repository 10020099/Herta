import { describe, expect, it } from "vitest";
import type { Message } from "../types/transcript.js";
import { buildEvidence } from "./evidence.js";

describe("buildEvidence", () => {
  it("returns empty userMessage for empty messages array, passes through loreExplicit and workspaceRoot", () => {
    const result = buildEvidence({
      workspaceRoot: "/repo",
      messages: [],
      loreExplicit: true,
    });
    expect(result.userMessage).toBe("");
    expect(result.workspaceRoot).toBe("/repo");
    expect(result.loreExplicit).toBe(true);
  });

  it("extracts last user message even when followed by assistant and tool messages", () => {
    const messages: Message[] = [
      { role: "user", text: "first question", ts: "2026-01-01T00:00:00Z" },
      {
        role: "assistant",
        text: "answer",
        toolCalls: [],
        ts: "2026-01-01T00:00:01Z",
      },
      {
        role: "tool",
        toolCallId: "t1",
        result: { ok: true, summary: "result" },
        ts: "2026-01-01T00:00:02Z",
      },
      { role: "user", text: "second question", ts: "2026-01-01T00:00:03Z" },
      {
        role: "assistant",
        text: "second answer",
        toolCalls: [],
        ts: "2026-01-01T00:00:04Z",
      },
    ];
    const result = buildEvidence({
      workspaceRoot: "/repo",
      messages,
      loreExplicit: false,
    });
    expect(result.userMessage).toBe("second question");
  });

  it("returns empty userMessage when messages contain only assistant and tool entries", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        text: "hello",
        toolCalls: [],
        ts: "2026-01-01T00:00:00Z",
      },
      {
        role: "tool",
        toolCallId: "t1",
        result: { ok: true, summary: "ok" },
        ts: "2026-01-01T00:00:01Z",
      },
    ];
    const result = buildEvidence({
      workspaceRoot: "/repo",
      messages,
      loreExplicit: false,
    });
    expect(result.userMessage).toBe("");
  });

  it("picks the LAST user message when there are multiple", () => {
    const messages: Message[] = [
      { role: "user", text: "first", ts: "2026-01-01T00:00:00Z" },
      { role: "user", text: "second", ts: "2026-01-01T00:00:01Z" },
      { role: "user", text: "third", ts: "2026-01-01T00:00:02Z" },
    ];
    const result = buildEvidence({
      workspaceRoot: "/repo",
      messages,
      loreExplicit: false,
    });
    expect(result.userMessage).toBe("third");
  });
});
