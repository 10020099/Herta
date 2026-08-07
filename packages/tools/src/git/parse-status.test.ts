import { describe, expect, it } from "vitest";
import { parseStatusPorcelain } from "./parse-status.js";

describe("parseStatusPorcelain", () => {
  it("returns clean state when only branch line present", () => {
    const r = parseStatusPorcelain("## main\n");
    expect(r.branch).toBe("main");
    expect(r.ahead).toBe(0);
    expect(r.behind).toBe(0);
    expect(r.files).toEqual([]);
    expect(r.clean).toBe(true);
  });

  it("parses upstream tracking with ahead+behind counts", () => {
    const r = parseStatusPorcelain(
      "## main...origin/main [ahead 2, behind 1]\n",
    );
    expect(r.branch).toBe("main");
    expect(r.ahead).toBe(2);
    expect(r.behind).toBe(1);
  });

  it("parses ahead-only tracking", () => {
    const r = parseStatusPorcelain("## feature...origin/main [ahead 5]\n");
    expect(r.ahead).toBe(5);
    expect(r.behind).toBe(0);
  });

  it("returns null branch for detached HEAD", () => {
    const r = parseStatusPorcelain("## HEAD (no branch)\n");
    expect(r.branch).toBeNull();
  });

  it("parses modified files (worktree status)", () => {
    const r = parseStatusPorcelain("## main\n M src/x.ts\n");
    expect(r.clean).toBe(false);
    expect(r.files).toEqual([
      { path: "src/x.ts", indexStatus: " ", worktreeStatus: "M" },
    ]);
  });

  it("parses staged + unstaged combo", () => {
    const r = parseStatusPorcelain(
      "## main\nMM src/a.ts\nA  src/b.ts\n D src/c.ts\n",
    );
    expect(r.files).toEqual([
      { path: "src/a.ts", indexStatus: "M", worktreeStatus: "M" },
      { path: "src/b.ts", indexStatus: "A", worktreeStatus: " " },
      { path: "src/c.ts", indexStatus: " ", worktreeStatus: "D" },
    ]);
  });

  it("parses untracked files", () => {
    const r = parseStatusPorcelain("## main\n?? new.txt\n");
    expect(r.files).toEqual([
      { path: "new.txt", indexStatus: "?", worktreeStatus: "?" },
    ]);
  });

  it("parses renames with origPath", () => {
    const r = parseStatusPorcelain("## main\nR  old.ts -> new.ts\n");
    expect(r.files).toEqual([
      {
        path: "new.ts",
        indexStatus: "R",
        worktreeStatus: " ",
        origPath: "old.ts",
      },
    ]);
  });
});
