import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";

/**
 * Secure, main-process-only store for the DeepSeek API key, over Electron
 * `safeStorage` (OS keychain — Keychain on macOS, libsecret on Linux, DPAPI on
 * Windows). The raw key NEVER crosses IPC: the renderer only ever sees the
 * masked status (`set` + last-4 `hint`). See the 2026-06-24-deepseek-key design.
 *
 * Storage lives under `app.getPath("userData")`:
 *  - `deepseek-key.enc` — `safeStorage`-encrypted bytes (preferred).
 *  - `deepseek-key.txt` — plaintext fallback when encryption is unavailable
 *    (still better than the repo file; flagged `encrypted: false` so the UI can
 *    warn).
 *
 * All reads are best-effort: a missing / corrupt / undecryptable store resolves
 * to `null` rather than throwing — a bad store must never wedge the app.
 */

function encPath(): string {
  return join(app.getPath("userData"), "deepseek-key.enc");
}

function txtPath(): string {
  return join(app.getPath("userData"), "deepseek-key.txt");
}

/** Delete both store files. Best-effort — a missing file is success. */
function clearFiles(): void {
  for (const p of [encPath(), txtPath()]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // Best effort: a locked/absent file must not block a key change.
    }
  }
}

export interface DeepSeekKeyStatus {
  /** Whether a non-empty key is stored. */
  readonly set: boolean;
  /** Last 4 characters of the key, for the "Connected · …last4" UI. Null when
   *  unset. The full key is never sent to the renderer. */
  readonly hint: string | null;
  /** False when the key is stored as plaintext (encryption unavailable). */
  readonly encrypted: boolean;
}

/** Persist `key` (trimmed). Encrypts via safeStorage when available, else writes
 *  a plaintext fallback. Clears the other file first so the two never coexist
 *  and shadow each other. An empty/whitespace key clears the store instead. */
export function setDeepSeekKey(key: string): { encrypted: boolean } {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    clearFiles();
    return { encrypted: false };
  }
  // Write the NEW key before clearing the old one (audit BL7). The old order
  // deleted both files first, so a failed write left the user with no stored
  // key at all — they had typed a valid key, seen an error, and lost the one
  // they already had. The running session was unaffected (the throw precedes
  // host.setDeepSeekKey), which is exactly what made the loss easy to miss
  // until the next launch.
  //
  // Clearing the OTHER file afterwards still keeps the two from coexisting and
  // shadowing each other, which is what clearFiles was here for.
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(encPath(), safeStorage.encryptString(trimmed));
    rmIfExists(txtPath());
    return { encrypted: true };
  }
  writeFileSync(txtPath(), trimmed, "utf-8");
  rmIfExists(encPath());
  return { encrypted: false };
}

function rmIfExists(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* a stale sibling is shadowed by read order anyway; never fail a key save */
  }
}

/** Read the stored key in plaintext, or null when none is set / readable.
 *  Main-process only — used by `buildConfig` and `setKey`, never sent to the
 *  renderer. */
export function readDeepSeekKeyPlain(): string | null {
  try {
    if (existsSync(encPath()) && safeStorage.isEncryptionAvailable()) {
      const decoded = safeStorage.decryptString(readFileSync(encPath())).trim();
      return decoded.length > 0 ? decoded : null;
    }
  } catch {
    // Corrupt/undecryptable .enc — fall through to the plaintext fallback.
  }
  try {
    if (existsSync(txtPath())) {
      const raw = readFileSync(txtPath(), "utf-8").trim();
      return raw.length > 0 ? raw : null;
    }
  } catch {
    // Unreadable .txt — treat as no key.
  }
  return null;
}

/** Masked status for the renderer. The raw key never leaves the main process. */
export function getDeepSeekKeyStatus(): DeepSeekKeyStatus {
  const key = readDeepSeekKeyPlain();
  if (key === null) return { set: false, hint: null, encrypted: false };
  const encrypted =
    existsSync(encPath()) && safeStorage.isEncryptionAvailable();
  // Last 4 only — never echo a whole (short) key back across IPC.
  const hint = key.length >= 4 ? key.slice(-4) : null;
  return { set: true, hint, encrypted };
}

/** Delete the stored key (both files). */
export function clearDeepSeekKey(): void {
  clearFiles();
}
