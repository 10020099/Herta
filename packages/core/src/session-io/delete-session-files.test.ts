import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteSessionFiles, recapCachePath } from "./delete-session-files.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "herta-del-"));
}

describe("deleteSessionFiles", () => {
  it("removes the transcript and title sidecar for the id", () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.jsonl"), "{}");
    writeFileSync(join(dir, "a.title.json"), "{}");
    deleteSessionFiles(dir, "a");
    expect(existsSync(join(dir, "a.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "a.title.json"))).toBe(false);
  });

  it("is idempotent when files are already missing", () => {
    const dir = tmp();
    expect(() => deleteSessionFiles(dir, "ghost")).not.toThrow();
  });

  it("removes the recap sidecar too, given a workspace root (audit BL8)", () => {
    // It lives under `.herta/compaction`, OUTSIDE transcriptDir, so before
    // this it survived every delete — a growing pile of orphans describing
    // conversations that no longer exist.
    const ws = tmp();
    const dir = join(ws, ".herta", "transcript", "v2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.jsonl"), "{}");
    const sidecar = recapCachePath(ws, "a");
    mkdirSync(join(ws, ".herta", "compaction"), { recursive: true });
    writeFileSync(sidecar, "{}");

    deleteSessionFiles(dir, "a", undefined, ws);
    expect(existsSync(sidecar)).toBe(false);
  });

  it("leaves the sidecar alone when no workspace root is given", () => {
    // Callers that do not know the root keep the old behaviour rather than
    // guessing a path and deleting something else.
    const ws = tmp();
    const dir = join(ws, ".herta", "transcript", "v2");
    mkdirSync(dir, { recursive: true });
    const sidecar = recapCachePath(ws, "a");
    mkdirSync(join(ws, ".herta", "compaction"), { recursive: true });
    writeFileSync(sidecar, "{}");

    deleteSessionFiles(dir, "a");
    expect(existsSync(sidecar)).toBe(true);
  });

  it("a traversal id cannot reach a sidecar outside the compaction dir", () => {
    const ws = tmp();
    const outside = join(ws, "precious.json");
    writeFileSync(outside, "{}");
    deleteSessionFiles(join(ws, "t"), "../../precious", undefined, ws);
    expect(existsSync(outside)).toBe(true);
  });

  it("leaves other sessions' files intact", () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.jsonl"), "{}");
    writeFileSync(join(dir, "b.jsonl"), "{}");
    writeFileSync(join(dir, "b.title.json"), "{}");
    deleteSessionFiles(dir, "a");
    expect(readdirSync(dir).sort()).toEqual(["b.jsonl", "b.title.json"]);
  });

  it("deletes the managed workspace dir for the id when a base dir is given", () => {
    const transcriptDir = tmp();
    const workspacesDir = tmp();
    const wsPath = join(workspacesDir, "abc");
    mkdirSync(wsPath, { recursive: true });
    writeFileSync(join(wsPath, "scratch.ts"), "x");
    writeFileSync(join(transcriptDir, "abc.jsonl"), "{}");
    deleteSessionFiles(transcriptDir, "abc", workspacesDir);
    expect(existsSync(join(transcriptDir, "abc.jsonl"))).toBe(false);
    expect(existsSync(wsPath)).toBe(false);
  });

  it("is a no-op for the workspace dir when no base dir is given", () => {
    const dir = tmp();
    writeFileSync(join(dir, "abc.jsonl"), "{}");
    expect(() => deleteSessionFiles(dir, "abc")).not.toThrow();
  });

  it("never escapes the transcript dir (guard rejects a traversal id)", () => {
    const outer = tmp();
    const transcriptDir = join(outer, "transcripts");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(join(outer, "victim.jsonl"), "{}");
    writeFileSync(join(outer, "victim.title.json"), "{}");
    deleteSessionFiles(transcriptDir, "../victim");
    expect(existsSync(join(outer, "victim.jsonl"))).toBe(true);
    expect(existsSync(join(outer, "victim.title.json"))).toBe(true);
  });

  it("never follows an absolute-path id out of the transcript dir", () => {
    const transcriptDir = tmp();
    const elsewhere = tmp();
    const victim = join(elsewhere, "victim");
    writeFileSync(`${victim}.jsonl`, "{}");
    deleteSessionFiles(transcriptDir, victim);
    expect(existsSync(`${victim}.jsonl`)).toBe(true);
  });

  it("never escapes the workspaces base dir (guard rejects a traversal id)", () => {
    const transcriptDir = tmp();
    const workspacesDir = tmp();
    writeFileSync(join(workspacesDir, "keep.txt"), "x");
    deleteSessionFiles(transcriptDir, "..", workspacesDir);
    // The parent of the base must be untouched, and the base itself must survive.
    expect(existsSync(join(workspacesDir, "keep.txt"))).toBe(true);
    expect(existsSync(workspacesDir)).toBe(true);
  });
});
