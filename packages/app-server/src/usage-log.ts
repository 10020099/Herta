import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { type ProviderUsage, setProviderUsageSink } from "@herta/providers";

/** One line per model call. Past this the file moves aside (one generation
 *  kept) — at ~130 bytes a line that is some thirty thousand calls. */
const ROTATE_AT_BYTES = 4 * 1024 * 1024;

/**
 * The usage log (perf audit 2026-09-20): every model call's token counts as
 * the API stated them, one JSON object per line —
 *
 *   {"at":"…","endpoint":"completion","model":"deepseek-v4-pro",
 *    "prompt":21930,"hit":21504,"miss":426,"completion":188}
 *
 * — so "is the prompt cache holding?" has a measured answer: `hit / prompt`
 * per call, by endpoint (completion = Herta; chat = 板砖 and the sidecars)
 * and model. Numbers only; see `ProviderUsage` for what is deliberately not
 * in it.
 *
 * Installs the providers' process-wide sink, so one call covers every
 * provider the host builds. Writes are queued and asynchronous — a model
 * call never waits on the disk — and a failed write is dropped: the log is
 * an instrument, not a record. Returns the uninstaller, which also resolves
 * once the queue has drained (tests, shutdown).
 */
export function installUsageLog(filePath: string): () => Promise<void> {
  let queue: Promise<void> = (async () => {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      const info = await stat(filePath).catch(() => null);
      if (info !== null && info.size > ROTATE_AT_BYTES)
        await rename(filePath, `${filePath}.1`);
    } catch {
      // an unwritable directory just means no log
    }
  })();
  const sink = (u: ProviderUsage): void => {
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      endpoint: u.endpoint,
      model: u.model,
      prompt: u.promptTokens,
      hit: u.cacheHitTokens,
      miss: u.cacheMissTokens,
      completion: u.completionTokens,
      // The idle dream pass says so: it spends while the user is away.
      ...(u.source !== undefined ? { source: u.source } : {}),
    })}\n`;
    queue = queue
      .then(() => appendFile(filePath, line, "utf8"))
      .catch(() => {});
  };
  setProviderUsageSink(sink);
  return async () => {
    setProviderUsageSink(undefined);
    await queue;
  };
}
