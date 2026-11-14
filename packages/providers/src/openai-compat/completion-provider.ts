import type {
  CompletionEvent,
  CompletionProviderAdapter,
  CompletionRequest,
} from "@herta/core";
import { ProviderError } from "../errors.js";
import { observedCall, type ProviderUsage } from "../usage.js";
import { throwIfAborted } from "./abort.js";
import type { ApiKey } from "./api-key.js";
import { postCompletions } from "./completion-http.js";
import { mapCompletionStream } from "./completion-stream.js";
import { postChatCompletions } from "./http.js";
import { parseSSE } from "./sse.js";
import { mapStream } from "./stream.js";

export interface OpenAICompatibleCompletionProviderOpts {
  baseUrl: string;
  apiKey: ApiKey;
  /** Endpoint path appended to baseUrl. DeepSeek uses "/beta/completions".
   * Vanilla OpenAI legacy completions uses "/v1/completions" or just
   * "/completions" depending on baseUrl convention. */
  path: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryBaseMs?: number;
  /** Headers-phase deadline. Default 30s; 0 disables. See `CompletionHttpOpts`. */
  headersTimeoutMs?: number;
  /** SSE idle watchdog: max ms between body chunks before the stream is
   * treated as stalled. Default 90s; 0 disables. See `ParseSSEOpts`. */
  idleTimeoutMs?: number;
  /** Which of the harness's roles this provider serves; rides its usage
   *  lines (`ProviderUsage.site`). */
  site?: string;
  /** Told each call's token usage as the API states it — in addition to the
   *  process-wide sink (`usage.ts`). */
  onUsage?: (usage: ProviderUsage) => void;
}

export class OpenAICompatibleCompletionProvider
  implements CompletionProviderAdapter
{
  constructor(private readonly opts: OpenAICompatibleCompletionProviderOpts) {}

  streamCompletion(
    request: CompletionRequest,
    signal: AbortSignal,
  ): AsyncGenerator<CompletionEvent, void, void> {
    return observedCall(
      {
        endpoint: "completion",
        model: request.model,
        ...(this.opts.site !== undefined ? { site: this.opts.site } : {}),
      },
      (stated) => this.stream(request, signal, stated),
      this.opts.onUsage,
      signal,
    );
  }

  private async *stream(
    request: CompletionRequest,
    signal: AbortSignal,
    stated: (usage: Omit<ProviderUsage, "endpoint" | "model">) => void,
  ): AsyncGenerator<CompletionEvent, void, void> {
    throwIfAborted(signal);

    const httpOpts: Parameters<typeof postCompletions>[0] = {
      baseUrl: this.opts.baseUrl,
      apiKey: this.opts.apiKey,
      path: this.opts.path,
      ...(this.opts.headers !== undefined
        ? { headers: this.opts.headers }
        : {}),
      ...(this.opts.fetchImpl !== undefined
        ? { fetchImpl: this.opts.fetchImpl }
        : {}),
      ...(this.opts.maxRetries !== undefined
        ? { maxRetries: this.opts.maxRetries }
        : {}),
      ...(this.opts.retryBaseMs !== undefined
        ? { retryBaseMs: this.opts.retryBaseMs }
        : {}),
      ...(this.opts.headersTimeoutMs !== undefined
        ? { headersTimeoutMs: this.opts.headersTimeoutMs }
        : {}),
    };

    const body = {
      model: request.model,
      prompt: request.prompt,
      stop: request.stop,
      ...(request.maxTokens !== undefined
        ? { maxTokens: request.maxTokens }
        : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
    };

    const res = await postCompletions(httpOpts, body, signal);

    if (res.body === null) {
      throw new ProviderError({
        code: "sse",
        retryable: false,
        message: "completion response had empty body",
      });
    }

    yield* mapCompletionStream(
      parseSSE(
        res.body,
        signal,
        this.opts.idleTimeoutMs !== undefined
          ? { idleTimeoutMs: this.opts.idleTimeoutMs }
          : {},
      ),
      signal,
      stated,
    );
  }
}

/**
 * Completion adapter for OpenAI-compatible gateways that only expose the
 * modern Chat Completions surface. The narrative actor still owns a flat
 * prompt, so it becomes one user message; its stop markers stay in the
 * chat-completions request. This is deliberately separate from
 * `OpenAICompatibleCompletionProvider`, which DeepSeek uses for its real
 * legacy completion endpoint.
 */
export class OpenAICompatibleChatCompletionProvider
  implements CompletionProviderAdapter
{
  constructor(
    private readonly opts: {
      baseUrl: string;
      apiKey: ApiKey;
      headers?: Record<string, string>;
      fetchImpl?: typeof fetch;
      maxRetries?: number;
      retryBaseMs?: number;
      headersTimeoutMs?: number;
      idleTimeoutMs?: number;
    },
  ) {}

  async *streamCompletion(
    request: CompletionRequest,
    signal: AbortSignal,
  ): AsyncGenerator<CompletionEvent, void, void> {
    signal.throwIfAborted();
    const res = await postChatCompletions(
      {
        baseUrl: this.opts.baseUrl,
        apiKey: this.opts.apiKey,
        model: request.model,
        ...(this.opts.headers !== undefined
          ? { headers: this.opts.headers }
          : {}),
        ...(this.opts.fetchImpl !== undefined
          ? { fetchImpl: this.opts.fetchImpl }
          : {}),
        ...(this.opts.maxRetries !== undefined
          ? { maxRetries: this.opts.maxRetries }
          : {}),
        ...(this.opts.retryBaseMs !== undefined
          ? { retryBaseMs: this.opts.retryBaseMs }
          : {}),
        ...(this.opts.headersTimeoutMs !== undefined
          ? { headersTimeoutMs: this.opts.headersTimeoutMs }
          : {}),
      },
      {
        model: request.model,
        messages: [{ role: "user", content: request.prompt }],
        stream: true,
        ...(request.stop.length > 0 ? { stop: request.stop } : {}),
        ...(request.maxTokens !== undefined
          ? { max_tokens: request.maxTokens }
          : {}),
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
      },
      signal,
    );

    if (res.body === null) {
      throw new ProviderError({
        code: "sse",
        retryable: false,
        message: "chat completion response had empty body",
      });
    }

    for await (const event of mapStream(
      parseSSE(
        res.body,
        signal,
        this.opts.idleTimeoutMs !== undefined
          ? { idleTimeoutMs: this.opts.idleTimeoutMs }
          : {},
      ),
      signal,
    )) {
      if (event.type === "text-delta") {
        yield event;
      } else if (event.type === "finish") {
        yield {
          type: "finish",
          reason: event.reason === "length" ? "length" : "stop",
        };
      }
    }
  }
}
