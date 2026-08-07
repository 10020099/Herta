import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Audit 2026-08-05, S10 — a failed append must not fuse the next line.
 *
 * `appendFileSync` can write SOME bytes and then throw (disk full, quota, a
 * transient EBUSY), leaving the file ending in a partial JSON fragment with
 * no newline. The persister is NOT discarded on that throw: the error
 * propagates to session.ts, which appends a `turn_end` on the SAME instance
 * and swallows its own failure. That second write lands on the partial tail
 * and FUSES the two into one corrupt line.
 *
 * A fused line is fatal even as the file's last line — it ends with a
 * newline, so `trailingEmpty` is true and read-session-file's tolerant
 * last-line branch never fires. It throws `corrupt-line` and the GUI reports
 * the code with no repair path: the conversation is permanently unopenable.
 *
 * This lives in its OWN file because reproducing it needs a hoisted
 * `vi.mock("node:fs")` — the persister binds `appendFileSync` as a named
 * import at module load, so a `vi.spyOn` on the fs namespace afterwards does
 * not reach it. Mocking node:fs for the sibling suite would break its real-fs
 * assertions.
 */
const state = vi.hoisted(() => ({ failNext: false }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    default: real,
    appendFileSync: (
      file: Parameters<typeof real.appendFileSync>[0],
      data: Parameters<typeof real.appendFileSync>[1],
      opts?: Parameters<typeof real.appendFileSync>[2],
    ) => {
      if (state.failNext) {
        state.failNext = false;
        // The dangerous shape: a PARTIAL line reaches disk, then the call
        // throws. Truncated mid-JSON with no trailing newline.
        real.appendFileSync(file, String(data).slice(0, 12), opts);
        throw Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
      }
      return real.appendFileSync(file, data, opts);
    },
  };
});

const { readSessionFile } = await import("./read-session-file.js");
const { V2RecordPersister } = await import("./v2-record-persister.js");

describe("V2RecordPersister — failed append must not fuse (audit S10)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "v2-fuse-"));
    state.failNext = false;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const newPersister = (id: string) =>
    V2RecordPersister.forNewSession({
      sessionId: id,
      workspaceRoot: "/w",
      startedAt: new Date("2026-06-18T00:00:00.000Z"),
      transcriptDir: tmp,
      now: () => "2026-06-18T09:30:00.000Z",
    });

  const texts = (file: string) =>
    readSessionFile(file).record.map((b) => (b as { text?: string }).text);

  it("heals the partial tail on the NEXT append instead of fusing", () => {
    const p = newPersister("fuse");
    p.appendBlock({ kind: "user", text: "u1" });

    // The failing write must still throw LOUDLY — history is never silently
    // dropped; the turn fails and the caller sees why.
    state.failNext = true;
    expect(() =>
      p.appendBlock({ kind: "herta", surface: "speech", text: "h1" }),
    ).toThrow(/ENOSPC/);

    // …and then the follow-up write session.ts performs on the SAME
    // persister, which is what used to fuse the line.
    p.appendTurnEnd("failed", "2026-06-18T10:00:00.000Z");

    // Pre-fix: SessionFileError("corrupt-line"), permanently.
    expect(texts(p.sessionFile)).toEqual(["u1"]);
  });

  it("keeps the session openable AND appendable afterwards", () => {
    const p = newPersister("recover");
    p.appendBlock({ kind: "user", text: "u1" });
    state.failNext = true;
    expect(() => p.appendBlock({ kind: "user", text: "lost" })).toThrow();

    p.appendBlock({ kind: "user", text: "u2" });
    // The failed block never landed, but nothing before it was damaged and
    // the conversation keeps working.
    expect(texts(p.sessionFile)).toEqual(["u1", "u2"]);
  });

  it("survives a failure on the workspace_set meta line too", () => {
    // Every append path shares the guard, not just appendBlock.
    const p = newPersister("meta");
    p.appendBlock({ kind: "user", text: "u1" });
    state.failNext = true;
    expect(() =>
      p.appendWorkspaceSet("/some/where", "2026-06-18T10:00:00.000Z"),
    ).toThrow();
    p.appendBlock({ kind: "user", text: "u2" });
    expect(texts(p.sessionFile)).toEqual(["u1", "u2"]);
  });

  it("does no healing on the happy path", () => {
    const p = newPersister("clean");
    p.appendBlock({ kind: "user", text: "u1" });
    p.appendBlock({ kind: "user", text: "u2" });
    p.appendTurnEnd("completed", "2026-06-18T10:00:00.000Z");
    expect(console.warn).not.toHaveBeenCalled();
    expect(texts(p.sessionFile)).toEqual(["u1", "u2"]);
  });
});
