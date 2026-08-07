import type { MemoryItem } from "@herta/core";
import { describe, expect, it } from "vitest";
import { formatMemoryContext } from "./format.js";

function mkItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: "id-1",
    scope: "repo",
    kind: "build_command",
    text: "pnpm build",
    sourceSession: "s1",
    createdAt: "2026-05-04T00:00:00.000Z",
    lastSeen: "2026-05-04T00:00:00.000Z",
    confidence: 1,
    ...overrides,
  };
}

describe("formatMemoryContext", () => {
  it("returns empty string for empty items array", () => {
    expect(formatMemoryContext([])).toBe("");
  });

  it("wraps a single item in <project-memory> markers with [kind] text line", () => {
    const out = formatMemoryContext([mkItem()]);
    expect(out).toContain('<project-memory count="1">');
    expect(out).toContain("[build_command] pnpm build");
    expect(out).toContain("</project-memory>");
  });

  it("renders items in createdAt-ascending order", () => {
    const newer = mkItem({
      kind: "test_command",
      text: "pnpm vitest",
      createdAt: "2026-05-05T00:00:00.000Z",
    });
    const older = mkItem({
      kind: "build_command",
      text: "pnpm build",
      createdAt: "2026-05-04T00:00:00.000Z",
    });
    const out = formatMemoryContext([newer, older]);
    const olderIdx = out.indexOf("[build_command]");
    const newerIdx = out.indexOf("[test_command]");
    expect(olderIdx).toBeGreaterThan(-1);
    expect(newerIdx).toBeGreaterThan(-1);
    expect(olderIdx).toBeLessThan(newerIdx);
  });
});
