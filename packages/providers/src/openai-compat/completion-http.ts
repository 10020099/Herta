import { ProviderError } from "../errors.js";
import { isTlsOrProxyFailure, providerFetch } from "../transport.js";
import { type ApiKey, resolveApiKey } from "./api-key.js";
import {
  DEFAULT_HEADERS_TIMEOUT_MS,
  fetchWithHeadersDeadline,
  readErrorBodyBounded,
} from "./fetch-deadline.js";

export interface CompletionHttpOpts {
  baseUrl: string;
  apiKey: ApiKey;
  /** Endpoint path appended to baseUrl. DeepSeek factory passes "/beta/completions". */
  path: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Maximum retry attempts for retryable failures (network / 429 / 5xx).
   * Default: 2. */
  maxRetries?: number;
  /** Base backoff in ms; doubles each attempt with ±25% jitter. Default 500. */
  retryBaseMs?: number;
  /** Max ms to wait for response HEADERS before treating the attempt as a
   * retryable stall (hang audit 2026-07-09, H1). Headers phase only — once
   * headers arrive the SSE idle watchdog owns the body. 0 disables.
   * Default 30s. */
  headersTimeoutMs?: number;
}

export interface CompletionRequestBody {
  model: string;
  prompt: string;
  stop: readonly string[];
  maxTokens?: number;
  temperature?: number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 500;

export async function postCompletions(
  opts: CompletionHttpOpts,
  body: CompletionRequestBody,
  signal: AbortSignal,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? providerFetch();
  const url = `${opts.baseUrl.replace(/\/$/, "")}${opts.path}`;
  const headers = new Headers({
    "content-type": "application/json",
    authorization: `Bearer ${resolveApiKey(opts.apiKey)}`,
  });
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) headers.set(k, v);
  }

  // Translate to wire shape: max_tokens (not maxTokens), stream: true, drop undefined.
  const wireBody: Record<string, unknown> = {
    model: body.model,
    prompt: body.prompt,
    stop: body.stop,
    stream: true,
  };
  if (body.maxTokens !== undefined) wireBody.max_tokens = body.maxTokens;
  if (body.temperature !== undefined) wireBody.temperature = body.temperature;
  const bodyJson = JSON.stringify(wireBody);

  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const headersTimeoutMs = opts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;

  let lastError: ProviderError | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      if (signal.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      await sleep(retryBackoffMs(retryBaseMs, attempt), signal);
    }

    let res: Response;
    try {
      res = await fetchWithHeadersDeadline(
        fetchImpl,
        url,
        { method: "POST", headers, body: bodyJson, signal },
        headersTimeoutMs,
      );
    } catch (cause) {
      if (isAbortError(cause)) throw cause;
      // A certificate or proxy failure (audit S3) is thrown, not retried: an
      // intercepting proxy Herta does not trust rejects the second attempt
      // exactly like the first, and the user needs to be told to go fix the
      // machine rather than watch three silent retries end in "please resend".
      if (isTlsOrProxyFailure(cause)) {
        throw new ProviderError({
          code: "network-tls",
          retryable: false,
          message: cause instanceof Error ? cause.message : "TLS failure",
          cause,
        });
      }
      // A headers-phase stall is already a typed retryable ProviderError —
      // keep it as-is so the caller sees "stall", not a generic wrap.
      lastError =
        cause instanceof ProviderError
          ? cause
          : new ProviderError({
              code: "network",
              retryable: true,
              message: cause instanceof Error ? cause.message : "fetch failed",
              cause,
            });
      continue;
    }

    if (!res.ok) {
      // Bounded read (audit finding 18) — see http.ts: a stalled error body
      // parked forever; aborts rethrow instead of masquerading as HTTP.
      const text = await readErrorBodyBounded(res, headersTimeoutMs);
      let detail = res.statusText || "request failed";
      if (text.length > 0) {
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string } };
          if (parsed.error?.message) detail = parsed.error.message;
        } catch {
          detail = text.slice(0, 200);
        }
      }
      const retryable = res.status === 429 || res.status >= 500;
      lastError = new ProviderError({
        code: "http",
        retryable,
        status: res.status,
        message: `${res.status} ${detail}`,
      });
      if (!retryable) throw lastError;
      continue;
    }

    return res;
  }

  throw (
    lastError ??
    new ProviderError({
      code: "network",
      retryable: false,
      message: "all retry attempts exhausted",
    })
  );
}

/** Exponential backoff with ±25% jitter. */
function retryBackoffMs(baseMs: number, attempt: number): number {
  const base = baseMs * 2 ** (attempt - 1);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/** Abort-aware sleep. Resolves after `ms`, or rejects with AbortError if
 * the signal aborts during the wait. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === "AbortError" || (e as { code?: string }).code === "ABORT_ERR")
  );
}
