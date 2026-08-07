export interface Hunk {
  search: string;
  replace: string;
}

export type ParsePatchResult =
  | { ok: true; hunks: Hunk[] }
  | { ok: false; code: "parse_failed"; message: string };

export type ValidateResult =
  | { ok: true }
  | {
      ok: false;
      code: "hunk_not_found" | "hunk_ambiguous" | "hunk_overlap";
      message: string;
    };

export function parsePatch(input: unknown): ParsePatchResult {
  if (!Array.isArray(input)) {
    return {
      ok: false,
      code: "parse_failed",
      message: "hunks must be an array",
    };
  }
  if (input.length === 0) {
    return {
      ok: false,
      code: "parse_failed",
      message: "hunks must be non-empty",
    };
  }
  const hunks: Hunk[] = [];
  for (let i = 0; i < input.length; i++) {
    const h = input[i] as unknown;
    if (typeof h !== "object" || h === null) {
      return {
        ok: false,
        code: "parse_failed",
        message: `hunk[${i}] must be an object`,
      };
    }
    const rec = h as Record<string, unknown>;
    if (typeof rec.search !== "string") {
      return {
        ok: false,
        code: "parse_failed",
        message: `hunk[${i}].search must be a string`,
      };
    }
    if (typeof rec.replace !== "string") {
      return {
        ok: false,
        code: "parse_failed",
        message: `hunk[${i}].replace must be a string`,
      };
    }
    if (rec.search.length === 0) {
      return {
        ok: false,
        code: "parse_failed",
        message: `hunk[${i}].search must be non-empty`,
      };
    }
    hunks.push({ search: rec.search, replace: rec.replace });
  }
  return { ok: true, hunks };
}

interface ApplyTrace {
  hunkIndex: number;
  postStart: number;
  postEnd: number;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found < 0) return count;
    count += 1;
    idx = found + needle.length;
  }
}

export function validateHunks(
  content: string,
  hunks: ReadonlyArray<Hunk>,
): ValidateResult {
  let current = content;
  const replacementRanges: ApplyTrace[] = [];
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i] as Hunk;
    const occurrences = countOccurrences(current, h.search);
    if (occurrences === 0) {
      return {
        ok: false,
        code: "hunk_not_found",
        message: `hunk[${i}] search not found`,
      };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        code: "hunk_ambiguous",
        message: `hunk[${i}] search matches ${occurrences} places; need 1`,
      };
    }
    const matchStart = current.indexOf(h.search);
    const matchEnd = matchStart + h.search.length;
    for (const r of replacementRanges) {
      const overlaps = !(matchEnd <= r.postStart || matchStart >= r.postEnd);
      if (overlaps) {
        return {
          ok: false,
          code: "hunk_overlap",
          message: `hunk[${i}] match overlaps hunk[${r.hunkIndex}] replacement region`,
        };
      }
    }
    const newPostStart = matchStart;
    const newPostEnd = matchStart + h.replace.length;
    const delta = h.replace.length - h.search.length;
    for (const r of replacementRanges) {
      if (r.postStart >= matchEnd) {
        r.postStart += delta;
        r.postEnd += delta;
      }
    }
    replacementRanges.push({
      hunkIndex: i,
      postStart: newPostStart,
      postEnd: newPostEnd,
    });
    current =
      current.slice(0, matchStart) + h.replace + current.slice(matchEnd);
  }
  return { ok: true };
}

export function applyHunks(
  content: string,
  hunks: ReadonlyArray<Hunk>,
): string {
  let current = content;
  for (const h of hunks) {
    const idx = current.indexOf(h.search);
    if (idx < 0) {
      throw new Error(
        "applyHunks invariant violated: hunk search missing — call validateHunks first",
      );
    }
    current =
      current.slice(0, idx) + h.replace + current.slice(idx + h.search.length);
  }
  return current;
}

export function computeUnifiedDiff(
  before: string,
  after: string,
  label: string,
): string {
  if (before === after) return "";
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const beforeNoTrail = before.endsWith("\n")
    ? beforeLines.slice(0, -1)
    : beforeLines;
  const afterNoTrail = after.endsWith("\n")
    ? afterLines.slice(0, -1)
    : afterLines;
  const dp = longestCommonSubsequence(beforeNoTrail, afterNoTrail);
  const ops = diffOps(beforeNoTrail, afterNoTrail, dp);
  const body = ops
    .map((op) => {
      if (op.kind === "ctx") return ` ${op.line}`;
      if (op.kind === "del") return `-${op.line}`;
      return `+${op.line}`;
    })
    .join("\n");
  const noNewlineBefore =
    before.length === 0 || before.endsWith("\n")
      ? ""
      : "\n\\ No newline at end of file";
  const noNewlineAfter = after.endsWith("\n")
    ? ""
    : "\n\\ No newline at end of file";
  const sourceHeader = before.length === 0 ? "--- /dev/null" : `--- a/${label}`;
  return [
    sourceHeader,
    `+++ b/${label}`,
    body + noNewlineBefore + noNewlineAfter,
  ].join("\n");
}

interface DiffOp {
  kind: "ctx" | "del" | "add";
  line: string;
}

function longestCommonSubsequence(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const dpRow = dp[i] as number[];
      const dpPrev = dp[i - 1] as number[];
      if (a[i - 1] === b[j - 1]) {
        dpRow[j] = (dpPrev[j - 1] as number) + 1;
      } else {
        const up = dpPrev[j] as number;
        const left = dpRow[j - 1] as number;
        dpRow[j] = up >= left ? up : left;
      }
    }
  }
  return dp;
}

function diffOps(a: string[], b: string[], dp: number[][]): DiffOp[] {
  const ops: DiffOp[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: "ctx", line: a[i - 1] as string });
      i -= 1;
      j -= 1;
      continue;
    }
    const up = ((dp[i - 1] as number[])[j] as number) ?? 0;
    const left = ((dp[i] as number[])[j - 1] as number) ?? 0;
    if (up >= left) {
      ops.push({ kind: "del", line: a[i - 1] as string });
      i -= 1;
    } else {
      ops.push({ kind: "add", line: b[j - 1] as string });
      j -= 1;
    }
  }
  while (i > 0) {
    ops.push({ kind: "del", line: a[i - 1] as string });
    i -= 1;
  }
  while (j > 0) {
    ops.push({ kind: "add", line: b[j - 1] as string });
    j -= 1;
  }
  return ops.reverse();
}
