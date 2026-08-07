import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * User app settings, persisted to `<workspaceRoot>/.herta/settings.json`
 * (workspace-scoped, gitignored). Extensible — future sections add keys. Read
 * at app-server bootstrap (`buildConfig`); changes apply on the next launch.
 */
/** Backend (差分协处理器) reasoning effort tiers, as accepted by the DeepSeek
 *  API since its 2026-07-31 update. NOTE: deepseek-v4-pro maps a sent "low"
 *  to "high" server-side until its announced early-August-2026 update — we
 *  store and send the user's choice as-is so it starts meaning "low" the day
 *  DeepSeek ships that, with no change here. */
export type BackendThinking = "low" | "high" | "max";

const BACKEND_THINKING_VALUES: readonly string[] = ["low", "high", "max"];

/** Narrow an untrusted (hand-editable settings.json) value to a valid tier. */
export function isBackendThinking(v: unknown): v is BackendThinking {
  return typeof v === "string" && BACKEND_THINKING_VALUES.includes(v);
}

export interface AppSettings {
  readonly dream?: { readonly enabled?: boolean };
  readonly backend?: { readonly thinking?: BackendThinking };
}

function settingsPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".herta", "settings.json");
}

/**
 * Read the settings file. Best-effort: a missing / unreadable / corrupt /
 * non-object file resolves to `{}` so every setting falls back to its default.
 */
export async function readAppSettings(
  workspaceRoot: string,
): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(workspaceRoot), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    // A malformed nested section (e.g. a hand-edited `"dream": 5`) → fall back
    // to defaults rather than hand back a shape that violates AppSettings.
    const { dream, backend } = parsed as { dream?: unknown; backend?: unknown };
    if (dream !== undefined && (typeof dream !== "object" || dream === null)) {
      return {};
    }
    if (
      backend !== undefined &&
      (typeof backend !== "object" || backend === null)
    ) {
      return {};
    }
    return parsed as AppSettings;
  } catch {
    return {};
  }
}

/** Write the settings file, creating `.herta/` if needed. Temp + rename so a
 *  crash mid-write can't tear the file into "all defaults" (audit 2026-07-13
 *  T3.9, same fix as app-global-settings). */
export async function writeAppSettings(
  workspaceRoot: string,
  settings: AppSettings,
): Promise<void> {
  const path = settingsPath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true });
  // Unique temp name (audit BL7). A FIXED `.tmp` path with no serialization
  // meant two concurrent writes — two Settings panes, or a fast toggle —
  // interleaved on the same file: writer A's rename could publish writer B's
  // half-written bytes. That race is what made the Settings error-note bug
  // (BL14) reachable at all.
  const tmp = `${path}.${process.pid}.${settingsWriteSeq++}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {
      /* temp already gone or undeletable */
    });
    throw err;
  }
}

/** Per-process counter for temp names. */
let settingsWriteSeq = 0;
