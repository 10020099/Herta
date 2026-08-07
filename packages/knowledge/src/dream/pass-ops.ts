import { readFileSync } from "node:fs";
import { join } from "node:path";
import { archiveLiveRecord } from "./promote.js";
import type {
  DreamCreatedRecord,
  DreamManifest,
  EpisodeOutcome,
} from "./types.js";

/** Append one episode outcome to the manifest ledger. */
export function recordEpisode(
  manifest: DreamManifest,
  ep: { sessionId: string; episodeHash: string },
  outcome: EpisodeOutcome,
  reason: string,
  now: () => Date,
): void {
  manifest.episodes.push({
    sessionId: ep.sessionId,
    episodeHash: ep.episodeHash,
    outcome,
    reason,
    timestamp: now().toISOString(),
  });
}

/** Move one live record's file to the archive and flip its manifest state,
 *  recording the demotion in the episode ledger. Shared by cap-eviction,
 *  stale-floor forgetting, and the reconsolidation junction. Best-effort on the
 *  file move (a vanished file still flips the manifest state so the cap stops
 *  counting it). */
export function archiveDreamRecord(
  manifest: DreamManifest,
  target: DreamCreatedRecord,
  narrativeDir: string,
  dreamDir: string,
  reason: string,
  now: () => Date,
): void {
  try {
    archiveLiveRecord({ narrativeDir, dreamDir, file: target.file, reason });
  } catch {
    // File may have already been removed; still flip the manifest state.
  }
  const idx = manifest.created.indexOf(target);
  if (idx !== -1) {
    const updated = Object.assign({}, manifest.created[idx], {
      state: "archived" as const,
    });
    manifest.created.splice(idx, 1, updated);
  }
  recordEpisode(
    manifest,
    {
      sessionId: target.sourceSessionId,
      episodeHash: target.sourceEpisodeHash,
    },
    "archived",
    reason,
    now,
  );
}

/** Read a text file from `dir`. undefined on any error (missing, unreadable). */
export function readTextFile(dir: string, file: string): string | undefined {
  try {
    return readFileSync(join(dir, file), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * `readTextFile` with the ABSENT / UNREADABLE distinction kept (audit
 * 2026-07-24, 2.2). Collapsing every errno into `undefined` let a transient
 * lock (AV / indexer / OneDrive on Windows, or EMFILE in the long-lived main
 * process) read as "the file is gone" — and callers act on that permanently:
 * a memory recorded as archived and consumed forever via `isEpisodeDreamed`.
 *
 * The distinction is provable at the junction's call site: `reconcileDreamState`
 * runs at the top of the same pass and prunes every live record whose file is
 * genuinely absent from the dir listing, so by then an unreadable `old.file` is
 * one the listing just confirmed EXISTS.
 */
export type TextFileRead =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly code: string };

export function readTextFileResult(dir: string, file: string): TextFileRead {
  try {
    return { kind: "text", text: readFileSync(join(dir, file), "utf8") };
  } catch (err) {
    const code = (err as { code?: string }).code ?? "unknown";
    return code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable", code };
  }
}
