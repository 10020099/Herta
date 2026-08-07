import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveSafePath, type SafePathDenied } from "../path-safety.js";
import { readerPathCandidates } from "./classifier.js";

/**
 * The fs-based half of the reader-argv guard (audit T3.4). The synchronous
 * classifier can only inspect argv TEXT, so a workspace file with an innocent
 * basename that is actually a SYMLINK to `~/.ssh/id_rsa` (or anywhere outside
 * the repo) passed `readerArgvGuard` and was auto-allowed — the OS followed
 * the link and the credential's contents entered the tool result, the
 * evidence store, `.herta/logs`, and the prompt tail. read_file /
 * search_text / list_files already realpath every target through
 * resolveSafePath; run_command's readers were the one gap.
 *
 * This mirrors that: for each file-path operand of an allow-listed reader,
 * canonicalize it against the EFFECTIVE cwd and, if it resolves to an
 * existing file whose real target leaves the workspace or names credential
 * material, DENY (matching read_file's hard-deny; ask would be worse — the
 * displayed command `cat notes.txt` HIDES that it really reads id_rsa, so the
 * user can't knowingly approve it).
 *
 * Only EXISTING operands are checked: a grep/find PATTERN or a not-yet-created
 * name doesn't resolve to a file (realpath throws) and is skipped, so no false
 * denials — and a reader can't exfiltrate a file that doesn't exist. The
 * textual absolute/parent/credential-name cases stay in the classifier's
 * `readerArgvGuard` (ask), where the user sees the real target.
 *
 * Returns the first denial, or null when every operand is safe / not a reader.
 * Runs in the permission rule (where deny gates execution) AND at tool
 * execution time (defense-in-depth against a symlink swapped in the window
 * between the permission check and the spawn).
 */
export async function checkReaderArgvPaths(
  workspaceRoot: string,
  effectiveCwd: string,
  argv: readonly string[],
): Promise<SafePathDenied | null> {
  const candidates = readerPathCandidates(argv);
  if (candidates === null) return null;

  for (const cand of candidates) {
    // resolve() (not join) so a Windows DRIVE-RELATIVE operand like `E:.env`
    // canonicalizes the way the OS actually opens it — against drive E's cwd
    // (the workspace) — instead of the literal `E:\HERTA\E:.env` a naive join
    // produces (which realpaths to ENOENT and was silently skipped, leaking a
    // workspace credential; audit T3.4 review). resolve() also subsumes the
    // genuinely-absolute case.
    const abs = resolve(effectiveCwd, cand);
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      // Nonexistent operand (pattern / missing file): nothing to canonicalize
      // and nothing a reader can leak. Skip.
      continue;
    }
    // `real` is an existing canonical path; resolveSafePath re-realpaths it
    // (idempotent) and applies the SAME workspace-prefix + credential
    // denylist that guards read_file, inheriting its Windows case handling.
    const r = await resolveSafePath(workspaceRoot, real);
    if (!r.ok) {
      return {
        ok: false,
        code: r.code,
        message: `read-only command targets ${cand} → ${r.message}`,
      };
    }
  }
  return null;
}
