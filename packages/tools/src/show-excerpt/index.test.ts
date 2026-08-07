import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ShowExcerptData,
  ToolCallRequest,
  ToolContext,
  ToolResult,
} from "@herta/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_EXCERPT_CHARS,
  MAX_EXCERPT_LINES,
  showExcerptTool,
} from "./index.js";

let root: string;
const recorded: Array<{ path: string; sha: string }> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "show-excerpt-"));
  recorded.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function ctx(): ToolContext {
  return {
    workspaceRoot: root,
    reads: {
      record: (p: string, sha: string) => recorded.push({ path: p, sha }),
    },
  } as unknown as ToolContext;
}

const call = (input: unknown): ToolCallRequest =>
  ({ id: "c1", tool: "show_excerpt", input }) as ToolCallRequest;

const noopProgress = () => {};

const run = (input: unknown) =>
  showExcerptTool().run(call(input), ctx(), noopProgress) as Promise<
    ToolResult<ShowExcerptData>
  >;

function seed(name: string, lines: string[]): void {
  writeFileSync(join(root, name), `${lines.join("\n")}\n`, "utf8");
}

describe("show_excerpt", () => {
  it("returns the requested range VERBATIM, line-numbered", async () => {
    seed("a.txt", ["one", "two", "three", "four", "five"]);
    const r = await run({ path: "a.txt", fromLine: 2, toLine: 4 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) throw new Error("expected ok + data");
    expect(r.data.range).toEqual([2, 4]);
    expect(r.data.totalLines).toBe(5);
    expect(r.data.excerpt).toBe("2\ttwo\n3\tthree\n4\tfour");
    expect(r.data.truncated).toBe(false);
    // The summary is what becomes the record row's argument.
    expect(r.summary).toBe("a.txt:2-4");
  });

  it("centres on a `match` with context lines each side", async () => {
    seed("log.txt", [
      "l1",
      "l2",
      "l3",
      "here is the WARNING line",
      "l5",
      "l6",
      "l7",
    ]);
    const r = await run({ path: "log.txt", match: "WARNING", context: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) throw new Error("expected ok + data");
    expect(r.data.range).toEqual([2, 6]);
    expect(r.data.excerpt).toContain("WARNING");
    expect(r.data.excerpt.startsWith("2\tl2")).toBe(true);
  });

  it("clamps context at the file's edges", async () => {
    seed("short.txt", ["hit", "b", "c"]);
    const r = await run({ path: "short.txt", match: "hit", context: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) throw new Error("expected ok + data");
    expect(r.data.range).toEqual([1, 3]);
  });

  it("bounds a huge span and says so", async () => {
    seed(
      "big.txt",
      Array.from({ length: 500 }, (_, i) => `line ${i + 1}`),
    );
    const r = await run({ path: "big.txt", fromLine: 1, toLine: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) throw new Error("expected ok + data");
    expect(r.data.truncated).toBe(true);
    expect(r.data.range[1] - r.data.range[0] + 1).toBeLessThanOrEqual(
      MAX_EXCERPT_LINES,
    );
  });

  it("the char cap cuts at a line boundary and the citation follows the cut", async () => {
    // As first shipped, the cap sliced the JOINED string: the excerpt lost
    // its tail but `range` and the summary kept naming the full span — and
    // the compaction digest a later turn keeps inherited the over-claim.
    // 60 lines × ~100 chars ≈ 6000 chars, so the 4000-char cap bites before
    // the line cap does.
    seed(
      "wide.txt",
      Array.from({ length: 80 }, (_, i) => `line ${i + 1} ${"x".repeat(90)}`),
    );
    const r = await run({ path: "wide.txt", fromLine: 1, toLine: 80 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) throw new Error("expected ok + data");
    expect(r.data.truncated).toBe(true);
    const [from, to] = r.data.range;
    expect(to).toBeLessThan(60); // the char cap bit, not just the line cap
    // Every line the citation claims is present IN FULL — the last numbered
    // row of the excerpt is the cited `to`, with its complete body.
    const rows = r.data.excerpt.split("\n");
    expect(rows).toHaveLength(to - from + 1);
    expect(rows[rows.length - 1]).toBe(
      `${String(to).padStart(2, " ")}\tline ${to} ${"x".repeat(90)}`,
    );
    expect(r.summary).toBe(`wide.txt:${from}-${to}`);
  });

  it("a single over-budget line cuts mid-line without splitting a surrogate pair", async () => {
    // A lone line wider than the whole char budget (minified source) is the
    // one case that still cuts inside a line. Astral chars (here 𝐀,
    // U+1D400) are two UTF-16 units — a blind slice can land between them
    // and leave a lone high surrogate, invalid once UTF-8-encoded for the
    // prompt or transcript.
    // The leading `a` matters: the numbered row is `1\ta𝐀𝐀…` — 3 units
    // before the pairs start — so the cap lands mid-pair. Without it the
    // prefix is 2 units and the cut falls on a pair boundary, exercising
    // nothing.
    seed("minified.txt", [`a${"𝐀".repeat(2100)}`]);
    const r = await run({ path: "minified.txt", fromLine: 1, toLine: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) throw new Error("expected ok + data");
    expect(r.data.truncated).toBe(true);
    expect(r.data.range).toEqual([1, 1]); // the partial line is still line 1
    // No lone surrogate at the cut…
    const last = r.data.excerpt.charCodeAt(r.data.excerpt.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    // …and the length proves the back-off actually fired: one unit UNDER
    // the cap, because the unit at the cap was the front half of a pair.
    expect(r.data.excerpt.length).toBe(MAX_EXCERPT_CHARS - 1);
  });

  it("records the read in the freshness ledger (showing IS reading)", async () => {
    seed("a.txt", ["x"]);
    await run({ path: "a.txt", fromLine: 1 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a match that is not there fails rather than showing something else", async () => {
    seed("a.txt", ["x", "y"]);
    const r = await run({ path: "a.txt", match: "zzz" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe("not_found");
  });

  it("refuses to escape the workspace", async () => {
    const r = await run({ path: "../outside.txt", fromLine: 1 });
    expect(r.ok).toBe(false);
  });

  it("does NOT follow harness-internal read paths (unlike read_file)", async () => {
    // read_file carries allowHarnessReadPaths so the backend can follow the
    // harness's own `.herta/logs/…` pointers. PRESENTING harness internals to
    // the user is a different act, and this tool has no such carve-out.
    const r = await run({ path: ".herta/logs/whatever.log", fromLine: 1 });
    expect(r.ok).toBe(false);
  });

  it("rejects a binary file", async () => {
    writeFileSync(join(root, "b.bin"), Buffer.from([0x41, 0x00, 0x42]));
    const r = await run({ path: "b.bin", fromLine: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe("binary_file");
  });

  it("requires either a range or a match", async () => {
    seed("a.txt", ["x"]);
    const r = await run({ path: "a.txt" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe("invalid_input");
  });
});
