import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative as relativePath,
  resolve,
  sep,
} from "node:path";
import {
  isCredentialBasename,
  isSensitiveSegment,
} from "./credential-denylist.js";

export interface SafePathOk {
  ok: true;
  resolved: string;
  relative: string;
}
export interface SafePathDenied {
  ok: false;
  code: "path_denied" | "path_outside_workspace";
  message: string;
}
export type SafePathResult = SafePathOk | SafePathDenied;

/** Whole-directory-tree denials (audit T3.4): `.git` protects git internals;
 *  `.herta` is harness-owned state (memory, capsules, logs, transcript,
 *  secrets, keys) that no TOOL has any business reading or writing — the
 *  harness writes it via direct node:fs, never through resolveSafePath, so
 *  this denies the tool path without touching legitimate harness writes.
 *  Promoted from the former `.herta/keys` PAIR (which left the rest of
 *  `.herta` tool-writable). Credential basenames + `.ssh`/`.aws`/`.gnupg`
 *  segments are owned by credential-denylist.ts (shared with the run_command
 *  classifier). */
const DENY_SEGMENTS_EXACT = [".git", ".herta"];

/**
 * Harness-evidence prefixes a READ may opt into (ADR 0025 slice 2).
 * `.herta` stays a whole-tree denial for every mutation and for listing;
 * these two subtrees hold ONLY output the harness itself wrote FOR the
 * model, so letting `read_file` (and only `read_file`) follow the "full
 * output at <path>" pointers is re-reading what the model already saw in
 * truncated form, not a new information channel. Everything else under
 * `.herta` (memory, capsules, transcript, keys) stays denied.
 *
 * Redaction is NOT uniform across the two, and the claim that it was is what
 * this paragraph used to say (audit BL17). `run_command` logs ARE
 * secret-redacted at capture time; `.herta/tool-results` is written verbatim,
 * because `read_file` is the one tool whose output never passes through
 * `redactSecrets` — redacting on the way to disk would desync the persisted
 * bytes from what the model already received and break offset/limit re-reads
 * of the same file.
 *
 * That is sound for THIS boundary: the model is re-reading its own prior tool
 * output, so redaction would hide nothing it has not already seen. It stops
 * being sound the moment those bytes reach a surface the model's own context
 * is not already equivalent to. Any future EXPORT path — a bug-report bundle,
 * a support upload, a "share this session" feature — must redact at that
 * boundary, and must not assume the file on disk is already clean.
 *
 * Symlink safety: the check runs on the POST-realpath relative path, so
 * a symlink planted inside `.herta/logs/` pointing at `.herta/keys/…`
 * (or outside the workspace) resolves to its target first and is judged
 * on where it actually lands — the carve-out cannot be used as a hop.
 * The credential-basename check below still applies inside the carve-out
 * (fail-closed for anything key-shaped, whoever wrote it).
 */
const HARNESS_READ_PREFIXES = [".herta/logs/", ".herta/tool-results/"];

/**
 * User-supplied documents the 开拓者 attached to a session (ADR 0033).
 *
 * A THIRD class, deliberately not folded into HARNESS_READ_PREFIXES above,
 * because the two carve-outs answer different questions and one flag meaning
 * both would leave the next reader guessing which applied:
 *
 *   - HARNESS_READ_PREFIXES is for NAVIGATING harness internals — output the
 *     harness wrote for the model, which the model has already seen in
 *     truncated form. `read_file` only. `show_excerpt` is deliberately
 *     excluded (ADR 0027 §5, pinned by a test): presenting harness internals
 *     to the user is not what that tool is for.
 *   - This one is USER CONTENT that merely happens to live under a harness
 *     directory, so it is stored session-scoped and disappears with the
 *     session. Presenting it back to the user is precisely the point — a
 *     document Herta can read but can never quote would answer half the
 *     request — so `show_excerpt` DOES get this one.
 *
 * Same guarantees as the harness carve-out and for the same reasons: judged on
 * the POST-realpath relative path, so a symlink planted in the attachments dir
 * is resolved to its target and judged on where it lands; must be a file
 * strictly beneath the prefix; skips only the structural `.herta` denial, so
 * the credential-basename and credential-directory checks still run over
 * whatever the user handed us.
 */
const ATTACHMENT_READ_PREFIXES = [".herta/attachments/"];

function isWindows(): boolean {
  return process.platform === "win32";
}

/** Canonicalize a NONEXISTENT path by realpath-ing its deepest existing
 *  ancestor and re-joining the not-yet-created suffix. Bounded by path depth
 *  (dirname reaches a fixed point at the filesystem root); if no ancestor
 *  resolves (detached drive etc.) the raw candidate returns — the prefix
 *  check then fails closed for anything outside the root. */
async function realpathViaExistingAncestor(candidate: string): Promise<string> {
  let dir = dirname(candidate);
  const suffix: string[] = [basename(candidate)];
  while (true) {
    try {
      const real = await realpath(dir);
      return join(real, ...suffix.reverse());
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return candidate; // hit the root; nothing resolved
      suffix.push(basename(dir));
      dir = parent;
    }
  }
}

function caseNormalize(s: string): string {
  return isWindows() ? s.toLowerCase() : s;
}

/** The name Win32 will ACTUALLY open for a path component (audit T3.4 review):
 *  CreateFileW trims trailing dots and spaces, and an NTFS alternate-data-
 *  stream suffix (`name::$DATA`) opens the default stream `name`. Without this
 *  normalization the write path — which re-joins a NONEXISTENT basename
 *  verbatim (write_new_file never realpaths a live inode) — compared `.env `
 *  / `id_rsa.` / `.git ` / `.env::$DATA` against the denylist, all misses, yet
 *  the write landed on the denied target after the OS trimmed the suffix.
 *  POSIX keeps trailing dots/spaces significant and allows colons, so this is
 *  a Windows-only normalization. */
function winCanonicalizeSegment(seg: string): string {
  if (!isWindows()) return seg;
  return seg.replace(/:.*$/, "").replace(/[. ]+$/, "");
}

export interface ResolveSafePathOpts {
  /**
   * Allow READ access to the harness-evidence subtrees
   * (`.herta/logs/`, `.herta/tool-results/`). Passed ONLY by read_file —
   * never by any mutating or listing tool. See HARNESS_READ_PREFIXES.
   */
  allowHarnessReadPaths?: boolean;
  /**
   * Allow READ access to session attachments (`.herta/attachments/`).
   * Passed by read_file AND show_excerpt — the asymmetry with the flag above
   * is the whole point of there being two. See ATTACHMENT_READ_PREFIXES.
   */
  allowAttachmentPaths?: boolean;
}

export async function resolveSafePath(
  workspaceRoot: string,
  inputPath: string,
  opts: ResolveSafePathOpts = {},
): Promise<SafePathResult> {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: "empty path",
    };
  }

  const candidate = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(workspaceRoot, inputPath);

  // Canonicalize through symlinks. For a NONEXISTENT target (write_new_file
  // — always, since the file doesn't exist yet) the old fallback used the
  // UNRESOLVED candidate, so a pre-existing directory symlink inside the
  // workspace that points OUTSIDE passed the prefix check and the write
  // landed at the symlink's target outside the repo. Walk up to the deepest
  // EXISTING ancestor, realpath that, and re-join the nonexistent suffix.
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    resolved = await realpathViaExistingAncestor(candidate);
  }

  const rootCmp = caseNormalize(workspaceRoot);
  const resolvedCmp = caseNormalize(resolved);
  const isInside =
    resolvedCmp === rootCmp || resolvedCmp.startsWith(rootCmp + sep);
  if (!isInside) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `resolved path is outside workspace root: ${resolved}`,
    };
  }

  const rel = relativePath(workspaceRoot, resolved).split(sep).join("/");

  if (rel.length > 0) {
    // Compare against the name Win32 will actually open (trailing dots/spaces
    // trimmed, NTFS ADS suffix resolved) — no-op on POSIX.
    const segments = rel.split("/").map(winCanonicalizeSegment);

    // Read carve-outs: judged on the canonicalized, post-realpath segments
    // (so `.herta ` / ADS tricks and symlink hops are already collapsed).
    // Must be a FILE strictly beneath one of the allowed prefixes. Skips only
    // the structural `.herta` denial below — the credential checks still run.
    const canonicalRel = segments.join("/");
    const beneathAny = (prefixes: readonly string[]): boolean =>
      prefixes.some(
        (p) =>
          caseNormalize(canonicalRel).startsWith(caseNormalize(p)) &&
          canonicalRel.length > p.length,
      );
    const inReadCarveOut =
      (opts.allowHarnessReadPaths === true &&
        beneathAny(HARNESS_READ_PREFIXES)) ||
      (opts.allowAttachmentPaths === true &&
        beneathAny(ATTACHMENT_READ_PREFIXES));

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] as string;
      const segLower = caseNormalize(seg);

      // `.git` / `.herta` are STRUCTURAL tree denials kept case-sensitive on
      // POSIX (a repo could hold an unrelated `.GIT` dir, and denying it would
      // break legit work) — caseNormalize only folds on Windows. Either read
      // carve-out (see above) skips exactly this check; credential denials
      // below are never skipped, for either.
      if (!inReadCarveOut) {
        for (const denied of DENY_SEGMENTS_EXACT) {
          if (caseNormalize(denied) === segLower) {
            return {
              ok: false,
              code: "path_denied",
              message: `path contains denied segment: ${denied}`,
            };
          }
        }
      }

      // Credential directories (.ssh/.aws/.gnupg) are CREDENTIAL denials, so
      // matched case-insensitively even on POSIX (fail-closed for secret
      // material — a `.SSH` dir is almost certainly keys regardless of case).
      // The deliberate asymmetry with .git/.herta above is the structural-vs-
      // credential distinction. Owned by the shared denylist.
      if (isSensitiveSegment(seg)) {
        return {
          ok: false,
          code: "path_denied",
          message: `path contains credential directory: ${seg}`,
        };
      }
    }

    const base = segments[segments.length - 1] as string;
    if (isCredentialBasename(base)) {
      return {
        ok: false,
        code: "path_denied",
        message: `denied credential basename: ${base}`,
      };
    }
  }

  return { ok: true, resolved, relative: rel };
}
