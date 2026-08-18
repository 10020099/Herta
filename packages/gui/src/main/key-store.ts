import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderType, ThinkingEffort } from "@herta/app-server";
import { app, safeStorage } from "electron";

/**
 * Multi-provider key store, generalized from the original DeepSeek-only store.
 * Stores each provider's config in a JSON file under userData.
 *
 * Each provider config includes:
 *   - apiKey (encrypted via safeStorage, or plaintext fallback)
 *   - baseUrl (optional override)
 *   - model (optional override for each role)
 *   - thinking (optional reasoning effort)
 *
 * The raw key NEVER crosses IPC: the renderer only ever sees the masked status
 * (`set` + last-4 `hint`). See the 2026-06-24-deepseek-key design.
 */

export interface ProviderStatus {
  readonly type: ProviderType;
  /** Whether a non-empty key is stored for this provider. */
  readonly set: boolean;
  /** Last 4 characters of the key, for the "Connected · …last4" UI. Null when
   *  unset. The full key is never sent to the renderer. */
  readonly hint: string | null;
  /** False when the key is stored as plaintext (encryption unavailable). */
  readonly encrypted: boolean;
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

/** Write the full providers config file. */
function writeConfigFile(config: Record<string, ProviderConfig>): void {
  writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf-8");
}

/** Key file helper: per-provider encrypted key storage.
 *  Format: `<provider-type>-key.enc` / `<provider-type>-key.txt` */
function keyEncPath(type: ProviderType): string {
  return join(app.getPath("userData"), `${type}-key.enc`);
}
function keyTxtPath(type: ProviderType): string {
  return join(app.getPath("userData"), `${type}-key.txt`);
}

function clearKeyFiles(type: ProviderType): void {
  for (const p of [keyEncPath(type), keyTxtPath(type)]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // Best effort.
    }
  }
}

function rmIfExists(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best effort */
  }
}

/** Read the stored key for a provider in plaintext, or null when none is set. */
function readKeyPlain(type: ProviderType): string | null {
  try {
    if (existsSync(keyEncPath(type)) && safeStorage.isEncryptionAvailable()) {
      const decoded = safeStorage
        .decryptString(readFileSync(keyEncPath(type)))
        .trim();
      if (decoded.length > 0) return decoded;
    }
  } catch {
    // Corrupt — fall through.
  }
  try {
    if (existsSync(keyTxtPath(type))) {
      const raw = readFileSync(keyTxtPath(type), "utf-8").trim();
      if (raw.length > 0) return raw;
    }
  } catch {
    // Unreadable.
  }
  return null;
}

/** Persist an API key for a provider. Returns whether it was encrypted. */
function setKeyPlain(type: ProviderType, key: string): { encrypted: boolean } {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    clearKeyFiles(type);
    return { encrypted: false };
  }
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(keyEncPath(type), safeStorage.encryptString(trimmed));
    rmIfExists(keyTxtPath(type));
    return { encrypted: true };
  }
  writeFileSync(keyTxtPath(type), trimmed, "utf-8");
  rmIfExists(keyEncPath(type));
  return { encrypted: false };
}

// ───── Public API ─────

/** Get the masked status for a provider. */
export function getProviderStatus(type: ProviderType): ProviderStatus {
  const key = readKeyPlain(type);
  if (key === null) return { type, set: false, hint: null, encrypted: false };
  const encrypted =
    existsSync(keyEncPath(type)) && safeStorage.isEncryptionAvailable();
  const hint = key.length >= 4 ? key.slice(-4) : null;
  return { type, set: true, hint, encrypted };
}

/** Get the full provider config (including raw key — main process only). */
export function readProviderConfig(type: ProviderType): ProviderConfig | null {
  const configs = readConfigFile();
  const stored = configs[type];
  const key = readKeyPlain(type);
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
    const key = readKeyPlain(type);
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
  const { encrypted } = setKeyPlain(type, key);
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

/** Delete the stored key and config for a provider. */
export function clearProviderKey(type: ProviderType): void {
  clearKeyFiles(type);
  const configs = readConfigFile();
  delete configs[type];
  writeConfigFile(configs);
}

// ───── Backward compatibility (DeepSeek-only) ─────

export interface DeepSeekKeyStatus {
  readonly set: boolean;
  readonly hint: string | null;
  readonly encrypted: boolean;
}

export function setDeepSeekKey(key: string): { encrypted: boolean } {
  return setProviderKey("deepseek", key);
}

export function readDeepSeekKeyPlain(): string | null {
  return readKeyPlain("deepseek");
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
