import { describe, expect, it } from "vitest";
import { sessionDisplayTitle } from "./session-title.js";

const base = {
  workspaceRoot: "/repo",
  startedAt: "2026-05-28T09:00:00Z",
  lastActivityAt: "2026-05-28T10:00:00Z",
};

describe("sessionDisplayTitle", () => {
  it("derives a title from the mock record for the 'today-1' session", () => {
    const title = sessionDisplayTitle({ ...base, sessionId: "today-1" });
    expect(title).toContain("Can you analyze");
    expect(title).not.toBe("Untitled");
  });

  it("returns 'Untitled' for any other session (no record available)", () => {
    expect(sessionDisplayTitle({ ...base, sessionId: "today-2" })).toBe(
      "Untitled",
    );
  });
});
