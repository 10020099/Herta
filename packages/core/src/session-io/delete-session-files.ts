import { rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Where a session's recap/compaction sidecar lives. Defined in core so
 * `deleteSessionFiles` below and `@herta/herta`'s recap-cache agree on one
 * path — herta depends on core, so the reverse import would close a cycle.
 */
export function recapCachePath(
  workspaceRoot: string,
  sessionId: string,
): string {
  return join(workspaceRoot, ".herta", "compaction", `${sessionId}.json`);
}

/**
 * Remove every per-session file for `sessionId` from `transcriptDir`:
 * the transcript `<id>.jsonl` and the title sidecar `<id>.title.json`.
 *
 * If `workspacesBaseDir` is given, also remove the managed backend workspace
 * directory at `<workspacesBaseDir>/<sessionId>`, if it exists.  The target
 * path is validated to be strictly inside the base (rejects empty, `..`, or
 * any traversal) so a malformed id can never escape the base.  An external
 * "set" workspace lives outside the base and is therefore never touched here.
 *
 * Idempotent — a missing file or directory is not an error (`rmSync` with
 * `force: true` swallows ENOENT). Other I/O errors propagate. The file list
 * is kept in one place so a future per-session sidecar is a one-line addition.
 */
export function deleteSessionFiles(
  transcriptDir: string,
  sessionId: string,
  workspacesBaseDir?: string,
  /** Workspace root, for the recap sidecar under `.herta/compaction` (audit
   *  BL8) — it lives outside `transcriptDir`, so deleting a session used to
   *  leave it behind forever. Optional: callers without a root keep the old
   *  behaviour rather than guessing a path. */
  workspaceRoot?: string,
): void {
  // Same containment rule as the workspace-dir guard below (audit 2026-07-13
  // T1.2): the transcript/title joins were the one unguarded id→path sink, so
  // a traversal id could rmSync an arbitrary `.jsonl` anywhere on disk.
  const dir = resolve(transcriptDir);
  const files = [
    resolve(dir, `${sessionId}.jsonl`),
    resolve(dir, `${sessionId}.title.json`),
  ];
  for (const f of files) {
    if (!f.startsWith(dir + sep)) continue;
    rmSync(f, { force: true });
  }

  if (workspaceRoot !== undefined) {
    // Same containment rule as above — the sidecar path is id-derived too.
    const compactionDir = resolve(workspaceRoot, ".herta", "compaction");
    const sidecar = resolve(recapCachePath(workspaceRoot, sessionId));
    if (sidecar.startsWith(compactionDir + sep)) {
      rmSync(sidecar, { force: true });
    }
  }

  if (workspacesBaseDir === undefined) return;
  // Derive the target from the id and assert it stays strictly inside the
  // managed base (rejects empty/".."/traversal). An external "set" workspace
  // is never under this base, so a real project can never be deleted here.
  const base = resolve(workspacesBaseDir);
  const target = resolve(base, sessionId);
  const inside = target !== base && target.startsWith(base + sep);
  if (!inside) return;
  rmSync(target, { recursive: true, force: true });
}
