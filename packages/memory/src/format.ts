import type { MemoryItem } from "@herta/core";

export function formatMemoryContext(items: readonly MemoryItem[]): string {
  if (items.length === 0) return "";
  const sorted = [...items].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const lines = sorted.map((i) => `[${i.kind}] ${i.text}`);
  return `<project-memory count="${items.length}">\n${lines.join("\n")}\n</project-memory>`;
}
