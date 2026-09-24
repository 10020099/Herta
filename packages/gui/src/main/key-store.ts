import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ProviderType, ThinkingEffort } from "@herta/app-server";
import { app, safeStorage } from "electron";

/**
 * Secure, main-process-only store for API keys and per-provider settings.
 *
 * Two things live here:
 *  - SECRETS, over Electron `safeStorage` (OS keychain — DPAPI on Windows,
 *    Keychain on macOS, libsecret on Linux). The raw key NEVER crosses IPC:
 *    the renderer only ever sees the masked status (`set` + last-4 `hint`).
 *    See the 2026-06-24-deepseek-key design.
 *  - the multi-provider CONFIG (base URL, per-role model overrides, thinking
 *    effort), in `providers.json` under `app.getPath("userData")`. API keys
 *    are never written there.
 *
 * Every secret is its own pair of files under `app.getPath("userData")`:
 * `<name>-key.enc` is the `safeStorage`-encrypted form (preferred),
 * `<name>-key.txt` the plaintext fallback when encryption is unavailable — or
 * only nominal (`basic_text`, see `encryptionProtects`). The fallback is
 * owner-only (0600) and flagged `encrypted: false` so the UI can warn. Every
 * provider type is a secret name, plus the MiniMax voice keys:
 *  - `minimax` — the MiniMax pay-as-you-go key for the cloud voice (ADR 0062,
 *    2026-09-08): clones her voice, and speaks when no plan key is set;
 *  - `minimax-plan` — the MiniMax token-plan (`sk-cp-…`) key (ADR 0062 §1.8):
 *    speaks under the plan; cannot clone.
 *
 * All reads are best-effort: a missing / corrupt / undecryptable store resolves
 * to `null` rather than throwing — a bad store must never wedge the app.
 */

/** Every secret this store owns: one per provider type, plus the voice keys. */
export type SecretName = ProviderType | "minimax" | "minimax-plan";

function encPath(name: SecretName): string {
  return join(app.getPath("userData"), `${name}-key.enc`);
}

function txtPath(name: SecretName): string {
  return join(app.getPath("userData"), `${name}-key.txt`);
}

/** Delete both store files. Best-effort — a missing file is success. */
function clearFiles(name: SecretName): void {
  for (const p of [encPath(name), txtPath(name)]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // Best effort: a locked/absent file must not block a key change.
    }
  }
}

function rmIfExists(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* a stale sibling is shadowed by read order anyway; never fail a key save */
  }
}

/**
 * Whether `safeStorage` really protects a secret on this machine.
 *
 * On Linux without a keyring — a tiling window manager, a minimal distro, no
 * gnome-keyring / KWallet running — Electron picks its `basic_text` backend,
 * which "encrypts" with a password hard-coded into Chromium. The ciphertext
 * is then no protection at all, yet the store used to write it as `.enc` and
 * report `encrypted: true`, and Settings told the user the key was stored
 * encrypted (platform review 2026-09-23). That backend now counts as NOT
 * encrypted: the key goes to the owner-only plaintext file and the UI says so.
 */
function encryptionProtects(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === "linux") {
    try {
      return safeStorage.getSelectedStorageBackend() !== "basic_text";
    } catch {
      return false;
    }
  }
  return true;
}

/** Owner-only on POSIX (the default 0644 let any local account read a
 *  plaintext key); `mode` only applies when the file is CREATED, so an
 *  existing file is tightened too. Best-effort: Windows ignores POSIX modes,
 *  and a failed chmod must not fail the save. */
function writeOwnerOnly(path: string, data: string | Buffer): void {
  writeFileSync(
    path,
    data,
    typeof data === "string"
      ? { encoding: "utf-8", mode: 0o600 }
      : { mode: 0o600 },
  );
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
}

export interface KeyStatus {
  /** Whether a non-empty key is stored. */
  readonly set: boolean;
  /** Last 4 characters of the key, for the "Connected · …last4" UI. Null when
   *  unset. The full key is never sent to the renderer. */
  readonly hint: string | null;
  /** False when the key is stored as plaintext (encryption unavailable). */
  readonly encrypted: boolean;
}

/** The DeepSeek status's historical name; the same shape serves every key. */
export type DeepSeekKeyStatus = KeyStatus;

/** Persist `key` (trimmed). Encrypts via safeStorage when available, else writes
 *  a plaintext fallback. Clears the other file first so the two never coexist
 *  and shadow each other. An empty/whitespace key clears the store instead. */
export function setSecret(
  name: SecretName,
  key: string,
): { encrypted: boolean } {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    clearFiles(name);
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
  if (encryptionProtects()) {
    writeOwnerOnly(encPath(name), safeStorage.encryptString(trimmed));
    rmIfExists(txtPath(name));
    return { encrypted: true };
  }
  writeOwnerOnly(txtPath(name), trimmed);
  rmIfExists(encPath(name));
  return { encrypted: false };
}

/** Read the stored key in plaintext, or null when none is set / readable.
 *  Main-process only — used by `buildConfig` and the synthesizers, never sent
 *  to the renderer. */
export function readSecretPlain(name: SecretName): string | null {
  try {
    if (existsSync(encPath(name)) && safeStorage.isEncryptionAvailable()) {
      const decoded = safeStorage
        .decryptString(readFileSync(encPath(name)))
        .trim();
      return decoded.length > 0 ? decoded : null;
    }
  } catch {
    // Corrupt/undecryptable .enc — fall through to the plaintext fallback.
  }
  try {
    if (existsSync(txtPath(name))) {
      const raw = readFileSync(txtPath(name), "utf-8").trim();
      return raw.length > 0 ? raw : null;
    }
  } catch {
    // Unreadable .txt — treat as no key.
  }
  return null;
}

/** Masked status for the renderer. The raw key never leaves the main process. */
export function getSecretStatus(name: SecretName): KeyStatus {
  const key = readSecretPlain(name);
  if (key === null) return { set: false, hint: null, encrypted: false };
  // A `.enc` written under `basic_text` still DECRYPTS (readSecretPlain uses
  // the plain availability check, so a key saved before 2026-09-23 keeps
  // working) — but it is not reported as encrypted, because it is not.
  const encrypted = existsSync(encPath(name)) && encryptionProtects();
  // Last 4 only — never echo a whole (short) key back across IPC.
  const hint = key.length >= 4 ? key.slice(-4) : null;
  return { set: true, hint, encrypted };
}

/** Delete the stored key (both files). */
export function clearSecret(name: SecretName): void {
  clearFiles(name);
}

// ── the MiniMax key (ADR 0062) ───────────────────────────────────────────────

export function setMiniMaxKey(key: string): { encrypted: boolean } {
  return setSecret("minimax", key);
}
export function readMiniMaxKeyPlain(): string | null {
  return readSecretPlain("minimax");
}
export function getMiniMaxKeyStatus(): KeyStatus {
  return getSecretStatus("minimax");
}
export function clearMiniMaxKey(): void {
  clearSecret("minimax");
}

// ── the MiniMax token-plan key (ADR 0062 §1.8) ──────────────────────────────

export function setMiniMaxPlanKey(key: string): { encrypted: boolean } {
  return setSecret("minimax-plan", key);
}
export function readMiniMaxPlanKeyPlain(): string | null {
  return readSecretPlain("minimax-plan");
}
export function getMiniMaxPlanKeyStatus(): KeyStatus {
  return getSecretStatus("minimax-plan");
}
export function clearMiniMaxPlanKey(): void {
  clearSecret("minimax-plan");
}

// ── Multi-provider configuration (providers.json) ───────────────────────────

/** Safe-to-render provider status. API keys never cross IPC. */
export interface ProviderStatus {
  readonly type: ProviderType;
  readonly set: boolean;
  readonly hint: string | null;
  readonly encrypted: boolean;
  /** Safe-to-render configuration; API keys never cross IPC. */
  readonly baseUrl?: string;
  readonly actorModel?: string;
  readonly backendModel?: string;
  readonly thinking?: ThinkingEffort;
  readonly anthropicOutputEffort?: ThinkingEffort;
}

export interface ProviderConfig {
  readonly type: ProviderType;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly actorModel?: string;
  readonly backendModel?: string;
  readonly routerModel?: string;
  readonly thinking?: ThinkingEffort;
  /** Anthropic: OutputConfig effort level. Sent as `output_config: { effort: "..." }`. */
  readonly anthropicOutputEffort?: ThinkingEffort;
}

function configPath(): string {
  return join(app.getPath("userData"), "providers.json");
}

/** Read the full providers config file. Returns default configs if none exists. */
function readConfigFile(): Record<string, ProviderConfig> {
  try {
    if (existsSync(configPath())) {
      return JSON.parse(readFileSync(configPath(), "utf-8")) as Record<
        string,
        ProviderConfig
      >;
    }
  } catch {
    // Corrupt file — treat as empty.
  }
  return {};
}

/** Write the full providers config file. The file carries no secrets, but it
 *  names the user's providers and endpoints — owner-only like the key
 *  fallbacks (best-effort; Windows ignores POSIX modes). */
function writeConfigFile(config: Record<string, ProviderConfig>): void {
  writeOwnerOnly(configPath(), JSON.stringify(config, null, 2));
}

/** Get the masked status for a provider. */
export function getProviderStatus(type: ProviderType): ProviderStatus {
  const { set, hint, encrypted } = getSecretStatus(type);
  const stored = readConfigFile()[type];
  const common = {
    ...(stored?.baseUrl !== undefined ? { baseUrl: stored.baseUrl } : {}),
    ...(stored?.actorModel !== undefined
      ? { actorModel: stored.actorModel }
      : {}),
    ...(stored?.backendModel !== undefined
      ? { backendModel: stored.backendModel }
      : {}),
    ...(stored?.thinking !== undefined ? { thinking: stored.thinking } : {}),
    ...(stored?.anthropicOutputEffort !== undefined
      ? { anthropicOutputEffort: stored.anthropicOutputEffort }
      : {}),
  };
  return { type, set, hint, encrypted, ...common };
}

/** Get the full provider config (including raw key — main process only). */
export function readProviderConfig(type: ProviderType): ProviderConfig | null {
  const configs = readConfigFile();
  const stored = configs[type];
  const key = readSecretPlain(type);
  if (key === null) return null;
  return {
    type,
    apiKey: key,
    baseUrl: stored?.baseUrl,
    actorModel: stored?.actorModel,
    backendModel: stored?.backendModel,
    routerModel: stored?.routerModel,
    thinking: stored?.thinking,
    anthropicOutputEffort: stored?.anthropicOutputEffort,
  };
}

/** Get all configured provider configs (main process only). */
export function readAllProviderConfigs(): Record<string, ProviderConfig> {
  const configs = readConfigFile();
  const result: Record<string, ProviderConfig> = {};
  for (const type of [
    "deepseek",
    "openai",
    "anthropic",
    "openai-compat",
  ] as ProviderType[]) {
    const key = readSecretPlain(type);
    if (key !== null) {
      result[type] = {
        type,
        apiKey: key,
        ...configs[type],
      };
    }
  }
  return result;
}

/** Persist provider config (key + optional settings). Returns encryption status. */
export function setProviderKey(
  type: ProviderType,
  key: string,
  opts?: {
    baseUrl?: string;
    actorModel?: string;
    backendModel?: string;
    routerModel?: string;
    thinking?: ThinkingEffort;
    anthropicOutputEffort?: ThinkingEffort;
  },
): { encrypted: boolean } {
  const { encrypted } = setSecret(type, key);
  const configs = readConfigFile();
  configs[type] = {
    type,
    apiKey: "", // key is stored separately in encrypted files
    ...(opts?.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts?.actorModel ? { actorModel: opts.actorModel } : {}),
    ...(opts?.backendModel ? { backendModel: opts.backendModel } : {}),
    ...(opts?.routerModel ? { routerModel: opts.routerModel } : {}),
    ...(opts?.thinking ? { thinking: opts.thinking } : {}),
    ...(opts?.anthropicOutputEffort
      ? { anthropicOutputEffort: opts.anthropicOutputEffort }
      : {}),
  };
  writeConfigFile(configs);
  return { encrypted };
}

/** Update saved non-secret settings while retaining the provider's stored key. */
export function updateProviderConfig(
  type: ProviderType,
  opts: Omit<ProviderConfig, "type" | "apiKey">,
): void {
  if (readSecretPlain(type) === null) {
    throw new Error(`Cannot update unconfigured provider "${type}"`);
  }
  const configs = readConfigFile();
  configs[type] = { type, apiKey: "", ...opts };
  writeConfigFile(configs);
}

/** Delete the stored key and config for a provider. */
export function clearProviderKey(type: ProviderType): void {
  clearSecret(type);
  const configs = readConfigFile();
  delete configs[type];
  writeConfigFile(configs);
}

// ── the DeepSeek key, under its historical names ─────────────────────────────

export function setDeepSeekKey(key: string): { encrypted: boolean } {
  return setProviderKey("deepseek", key);
}

export function readDeepSeekKeyPlain(): string | null {
  return readSecretPlain("deepseek");
}

export function getDeepSeekKeyStatus(): DeepSeekKeyStatus {
  // Strip the `type` field ProviderStatus carries — the legacy DeepSeek-only
  // shape predates multi-provider and its consumers/test expect exactly
  // { set, hint, encrypted }.
  const { set, hint, encrypted } = getProviderStatus("deepseek");
  return { set, hint, encrypted };
}

export function clearDeepSeekKey(): void {
  clearProviderKey("deepseek");
}
