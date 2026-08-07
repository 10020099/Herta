import { describe, expect, it } from "vitest";
import {
  applyHunks,
  computeUnifiedDiff,
  parsePatch,
  validateHunks,
} from "./engine.js";

describe("parsePatch", () => {
  it("accepts a single well-formed hunk", () => {
    const r = parsePatch([{ search: "old", replace: "new" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.hunks).toEqual([{ search: "old", replace: "new" }]);
  });

  it("accepts multi-hunk arrays", () => {
    const r = parsePatch([
      { search: "a", replace: "A" },
      { search: "b", replace: "B" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("accepts empty replace (deletion)", () => {
    const r = parsePatch([{ search: "remove me\n", replace: "" }]);
    expect(r.ok).toBe(true);
  });

  it("rejects non-array input", () => {
    const r = parsePatch("not an array" as unknown);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("parse_failed");
  });

  it("rejects empty hunks array", () => {
    const r = parsePatch([]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("parse_failed");
  });

  it("rejects empty search", () => {
    const r = parsePatch([{ search: "", replace: "x" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("parse_failed");
  });

  it("rejects non-string fields", () => {
    const r = parsePatch([{ search: 1, replace: "x" }] as unknown);
    expect(r.ok).toBe(false);
  });
});

describe("validateHunks", () => {
  it("ok when each search appears exactly once", () => {
    const r = validateHunks("hello world", [
      { search: "world", replace: "earth" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("hunk_not_found when search absent", () => {
    const r = validateHunks("hello world", [{ search: "moon", replace: "x" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("hunk_not_found");
  });

  it("hunk_ambiguous when search appears multiple times", () => {
    const r = validateHunks("foo foo", [{ search: "foo", replace: "bar" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("hunk_ambiguous");
  });

  it("allows sequential hunks on disjoint regions", () => {
    const r = validateHunks("alpha beta gamma", [
      { search: "alpha", replace: "ALPHA" },
      { search: "gamma", replace: "GAMMA" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("hunk_overlap when a later search overlaps an earlier replacement region", () => {
    const before = "say small thing";
    const r = validateHunks(before, [
      { search: "small", replace: "BIG" },
      { search: "ay BIG", replace: "ay XXX" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("hunk_overlap");
  });
});

describe("applyHunks", () => {
  it("applies a single hunk", () => {
    expect(
      applyHunks("hello world", [{ search: "world", replace: "earth" }]),
    ).toBe("hello earth");
  });

  it("applies multiple hunks in order", () => {
    expect(
      applyHunks("a b c", [
        { search: "a", replace: "A" },
        { search: "c", replace: "C" },
      ]),
    ).toBe("A b C");
  });

  it("preserves CRLF line endings", () => {
    expect(applyHunks("a\r\nb\r\nc\r\n", [{ search: "b", replace: "B" }])).toBe(
      "a\r\nB\r\nc\r\n",
    );
  });

  it("preserves trailing newline", () => {
    expect(applyHunks("hi\n", [{ search: "hi", replace: "hello" }])).toBe(
      "hello\n",
    );
  });

  it("supports deletion (empty replace)", () => {
    expect(
      applyHunks("a\nremove me\nb\n", [{ search: "remove me\n", replace: "" }]),
    ).toBe("a\nb\n");
  });
});

describe("computeUnifiedDiff", () => {
  it("returns empty string when before === after", () => {
    expect(computeUnifiedDiff("same", "same", "x.txt")).toBe("");
  });

  it("includes a/x.txt and b/x.txt headers", () => {
    const d = computeUnifiedDiff("alpha\n", "beta\n", "x.txt");
    expect(d).toContain("--- a/x.txt");
    expect(d).toContain("+++ b/x.txt");
  });

  it("marks deletions with - and additions with +", () => {
    const d = computeUnifiedDiff("alpha\n", "beta\n", "x.txt");
    expect(d).toContain("-alpha");
    expect(d).toContain("+beta");
  });

  it("is deterministic for identical inputs", () => {
    const a = computeUnifiedDiff("a\n", "b\n", "x.txt");
    const b = computeUnifiedDiff("a\n", "b\n", "x.txt");
    expect(a).toBe(b);
  });
});

describe("computeUnifiedDiff — new file (before is empty)", () => {
  it("emits --- /dev/null when before is empty and after is non-empty", () => {
    const d = computeUnifiedDiff("", "hello\n", "new.txt");
    expect(d).toContain("--- /dev/null");
    expect(d).toContain("+++ b/new.txt");
    expect(d).toContain("+hello");
    expect(d).not.toContain("--- a/new.txt");
  });

  it("does not emit a no-newline marker for the /dev/null source side", () => {
    const d = computeUnifiedDiff("", "hello\n", "new.txt");
    const beforeMarkerCount = (d.match(/\\ No newline at end of file/g) ?? [])
      .length;
    expect(beforeMarkerCount).toBe(0);
  });

  it("still emits +++ b/<label> with no-newline marker when after lacks trailing newline", () => {
    const d = computeUnifiedDiff("", "no-newline", "new.txt");
    expect(d).toContain("--- /dev/null");
    expect(d).toContain("+++ b/new.txt");
    expect(d).toContain("+no-newline");
    expect(d).toContain("\\ No newline at end of file");
  });

  it("preserves --- a/<label> when before is non-empty", () => {
    const d = computeUnifiedDiff("alpha\n", "beta\n", "x.txt");
    expect(d).toContain("--- a/x.txt");
    expect(d).not.toContain("--- /dev/null");
  });
});
