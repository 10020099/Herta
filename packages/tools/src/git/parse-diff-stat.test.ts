import { describe, expect, it } from "vitest";
import { parseDiffStat } from "./parse-diff-stat.js";

describe("parseDiffStat", () => {
  it("returns empty result for empty input", () => {
    const r = parseDiffStat("");
    expect(r.files).toEqual([]);
    expect(r.totalAdditions).toBe(0);
    expect(r.totalDeletions).toBe(0);
  });

  it("parses single-file diff", () => {
    const text = ` packages/foo.ts | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)\n`;
    const r = parseDiffStat(text);
    expect(r.files).toEqual([
      { path: "packages/foo.ts", additions: 2, deletions: 2 },
    ]);
    expect(r.totalAdditions).toBe(2);
    expect(r.totalDeletions).toBe(2);
  });

  it("parses multiple files and ignores summary line", () => {
    const text = ` a.ts | 5 +++++\n b.ts | 3 +--\n 2 files changed, 6 insertions(+), 2 deletions(-)\n`;
    const r = parseDiffStat(text);
    expect(r.files).toEqual([
      { path: "a.ts", additions: 5, deletions: 0 },
      { path: "b.ts", additions: 1, deletions: 2 },
    ]);
    expect(r.totalAdditions).toBe(6);
    expect(r.totalDeletions).toBe(2);
  });

  it("preserves rename rendering as a single path string", () => {
    const text = ` {old.ts => new.ts} | 0\n 1 file changed, 0 insertions(+), 0 deletions(-)\n`;
    const r = parseDiffStat(text);
    expect(r.files).toEqual([
      { path: "{old.ts => new.ts}", additions: 0, deletions: 0 },
    ]);
  });

  it("parses binary file lines as zero additions/deletions", () => {
    const text = ` data.bin | Bin 0 -> 100 bytes\n 1 file changed\n`;
    const r = parseDiffStat(text);
    expect(r.files).toEqual([{ path: "data.bin", additions: 0, deletions: 0 }]);
  });
});
