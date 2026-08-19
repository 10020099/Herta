/**
 * Anthropic Messages API provider (`POST /v1/messages`).
 *
 * Two adapters over one codebase, mirroring the openai-compat split:
 *   - `AnthropicProvider`          — chat mode (板砖 backend, router,
 *                                    supervisor, title).
 *   - `AnthropicCompletionProvider` — completion mode (the narrative actor's
 *                                    fallback when Herta runs on Claude).
 *
 * Anthropic differs from OpenAI-compatible in three ways this file abstracts:
 * (1) auth is `x-api-key` + `anthropic-version`, not Bearer; (2) `max_tokens`
 * is REQUIRED; (3) thinking is controlled via `thinking` / `output_config`
 * (extended-thinking `budget_tokens` is retired — adaptive thinking +
 * `output_config.effort` are the current knobs). The SSE stream names its
 * deltas `content_block_delta` with `delta.type` text_delta / thinking_delta /
 * input_json_delta, and ends with `message_delta.stop_reason`.
 */
import type {
  ActorPromptFrame,
  BackendPromptFrame,
  CompletionEvent,
  CompletionProviderAdapter,
  CompletionRequest,
  Message,
  ProviderAdapter,
  ProviderEvent,
  ProviderPromptFrame,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { ProviderError } from "../errors.js";
import { type ApiKey, resolveApiKey } from "../openai-compat/api-key.js";
import { postJsonWithRetry } from "../openai-compat/retry-post.js";
import { parseSSE } from "../openai-compat/sse.js";

export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8192;

// ── Wire types ──────────────────────────────────────────────────────────────

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: unknown;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: AnthropicMessage[];
  stream: true;
  tools?: AnthropicTool[];
  thinking?: { type: "adaptive" } | { type: "disabled" };
  output_config?: { effort?: string };
  stop_sequences?: string[];
  temperature?: number;
}

// ── Shared translation ──────────────────────────────────────────────────────

function toAnthropic(m: Message): AnthropicMessage {
  if (m.role === "user") {
    return { role: "user", content: m.text };
  }
  if (m.role === "assistant") {
    const content: AnthropicContent[] = [];
    if (m.text.length > 0) content.push({ type: "text", text: m.text });
    for (const c of m.toolCalls) {
      content.push({
        type: "tool_use",
        id: c.id,
        name: c.tool,
        input: c.input ?? {},
      });
    }
    return {
      role: "assistant",
      content,
    };
  }
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: toolMessageContent(m.result),
      },
    ],
  };
}

function toolMessageContent(result: ToolResult): string {
  if (result.modelText !== undefined) return result.modelText;
  const payload: Record<string, unknown> = {};
  if (result.data !== undefined) payload.data = result.data;
  if (!result.ok) {
    if (result.error !== undefined) payload.error = result.error;
    if (result.suggestion !== undefined) payload.suggestion = result.suggestion;
  }
  const hasPayload = Object.keys(payload).length > 0;
  if (result.summary.length > 0 && hasPayload) {
    return `${result.summary}\n\n${JSON.stringify(payload)}`;
  }
  if (result.summary.length > 0) return result.summary;
  if (hasPayload) return JSON.stringify(payload);
  return "{}";
}

function toTool(s: ToolSchema): AnthropicTool {
  return {
    name: s.name,
    description: s.description,
    input_schema: s.inputSchema,
  };
}

export interface AnthropicTranslateOpts {
  model: string;
  maxTokens?: number;
  temperature?: number;
  effort?: string;
}

function translateChat(
  frame: ProviderPromptFrame,
  opts: AnthropicTranslateOpts,
): AnthropicRequest {
  let systems: string[] = [];
  let messages: Message[] = [];
  let toolSchemas: ToolSchema[] = [];

  if ("backendSystem" in frame) {
    const f = frame as BackendPromptFrame;
    systems = [
      f.backendSystem,
      f.scopedRepoInstructions,
      f.scopedMemory,
    ].filter((s) => s.length > 0);
    messages = f.messages;
    toolSchemas = f.toolSchemas;
  } else {
    const f = frame as ActorPromptFrame;
    systems = [
      f.stableSystem,
      f.repoInstructions,
      f.memoryContext,
      f.retrievedLore,
    ].filter((s) => s.length > 0);
    messages = f.messages;
    toolSchemas = f.toolSchemas;
  }

  const req: AnthropicRequest = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: systems.join("\n\n"),
    messages: messages.map(toAnthropic),
    stream: true,
  };
  if (toolSchemas.length > 0) req.tools = toolSchemas.map(toTool);
  if (opts.temperature !== undefined) req.temperature = opts.temperature;
  if (
    opts.effort !== undefined &&
    opts.effort !== "" &&
    opts.effort !== "off"
  ) {
    req.output_config = { effort: opts.effort };
  }
  req.thinking = { type: "adaptive" };
  return req;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function postMessages(
  baseUrl: string,
  apiKey: ApiKey,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  return postJsonWithRetry(
    {
      url: `${baseUrl.replace(/\/$/, "")}/messages`,
      apiKey,
      headers: {
        "x-api-key": resolveApiKey(apiKey),
        "anthropic-version": ANTHROPIC_VERSION,
      },
    },
    JSON.stringify(body),
    signal,
  );
}

// ── Stream ──────────────────────────────────────────────────────────────────

interface ToolBuf {
  id: string;
  name: string;
  argsBuf: string;
}

function mapAnthropicStream(
  events: AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent, void, void> {
  const blocks = new Map<
    number,
    { type: string; id?: string; name?: string }
  >();
  const toolBuf = new Map<number, ToolBuf>();
  let sawFinish = false;

  return (async function* (): AsyncGenerator<ProviderEvent, void, void> {
    for await (const ev of events) {
      signal.throwIfAborted();
      const e = ev as { type?: string } & Record<string, unknown>;

      if (e.type === "error") {
        const err = e.error as { message?: string } | undefined;
        throw new ProviderError({
          code: "sse",
          retryable: true,
          message: `anthropic stream carried an error: ${
            typeof err?.message === "string" ? err.message : JSON.stringify(err)
          }`,
        });
      }

      if (e.type === "content_block_start") {
        const index = e.index as number;
        const block = e.content_block as
          | { type?: string; id?: string; name?: string }
          | undefined;
        if (index !== undefined && block !== undefined) {
          blocks.set(index, {
            type: block.type ?? "text",
            id: block.id,
            name: block.name,
          });
          if (block.type === "tool_use") {
            toolBuf.set(index, {
              id: block.id ?? "",
              name: block.name ?? "",
              argsBuf: "",
            });
          }
        }
        continue;
      }

      if (e.type === "content_block_delta") {
        const index = e.index as number;
        const delta = e.delta as
          | ({ type?: string } & Record<string, string>)
          | undefined;
        if (delta === undefined) continue;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          yield { type: "text-delta", text: delta.text };
        } else if (
          delta.type === "thinking_delta" &&
          typeof delta.thinking === "string"
        ) {
          yield { type: "reasoning-delta", text: delta.thinking };
        } else if (delta.type === "input_json_delta") {
          const buf = toolBuf.get(index) ?? { id: "", name: "", argsBuf: "" };
          if (typeof delta.partial_json === "string") {
            buf.argsBuf += delta.partial_json;
          }
          toolBuf.set(index, buf);
        }
        continue;
      }

      if (e.type === "content_block_stop") {
        const index = e.index as number;
        if (index !== undefined) {
          const buf = toolBuf.get(index);
          if (buf !== undefined && buf.id !== "" && buf.name !== "") {
            toolBuf.set(index, buf);
          } else {
            // A non-tool block finished; nothing to finalize.
          }
        }
        continue;
      }

      if (e.type === "message_delta") {
        const delta = e.delta as { stop_reason?: string } | undefined;
        const reason = delta?.stop_reason;
        sawFinish = true;
        if (reason === "tool_use") {
          const ordered = [...toolBuf.entries()].sort((a, b) => a[0] - b[0]);
          for (const [, buf] of ordered) {
            if (buf.id === "" || buf.name === "") continue;
            yield {
              type: "tool-call-request",
              call: {
                id: buf.id,
                tool: buf.name,
                input: parseArgs(buf.argsBuf),
              },
            };
          }
          yield { type: "finish", reason: "tool_calls" };
        } else if (reason === "max_tokens") {
          yield { type: "finish", reason: "length" };
        } else {
          yield { type: "finish", reason: "stop" };
        }
        continue;
      }

      if (e.type === "message_stop") {
        if (!sawFinish) {
          sawFinish = true;
          yield { type: "finish", reason: "stop" };
        }
      }
    }

    if (!sawFinish) {
      yield { type: "finish", reason: "stop" };
    }
  })();
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v === "object" && v !== null)
      return v as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

// ── Chat adapter ────────────────────────────────────────────────────────────

export interface AnthropicOpts {
  baseUrl?: string;
  apiKey: ApiKey;
  model?: string;
  /** output_config.effort. "off"/"" omit it. */
  effort?: string;
  temperature?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

export class AnthropicProvider implements ProviderAdapter {
  constructor(private readonly opts: AnthropicOpts) {}

  async *streamChat(
    frame: ProviderPromptFrame,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent, void, void> {
    signal.throwIfAborted();
    const body = translateChat(frame, {
      model: this.opts.model ?? "claude-sonnet-5",
      maxTokens: this.opts.maxTokens,
      temperature: this.opts.temperature,
      effort: this.opts.effort,
    });
    const res = await postMessages(
      this.opts.baseUrl ?? "https://api.anthropic.com",
      this.opts.apiKey,
      body,
      signal,
    );
    if (res.body === null) {
      throw new ProviderError({
        code: "sse",
        retryable: false,
        message: "anthropic response had empty body",
      });
    }
    yield* mapAnthropicStream(parseSSE(res.body, signal), signal);
  }
}

// ── Completion adapter (narrative actor fallback) ───────────────────────────

export interface AnthropicCompletionOpts {
  baseUrl?: string;
  apiKey: ApiKey;
  model?: string;
  effort?: string;
  temperature?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Completion-mode adapter over the Messages API: the actor's narrative
 * prompt becomes a single user message and the stop sequences become
 * `stop_sequences`. Anthropic has no raw-completion endpoint.
 */
export class AnthropicCompletionProvider implements CompletionProviderAdapter {
  constructor(private readonly opts: AnthropicCompletionOpts) {}

  async *streamCompletion(
    request: CompletionRequest,
    signal: AbortSignal,
  ): AsyncGenerator<CompletionEvent, void, void> {
    signal.throwIfAborted();
    const baseUrl = this.opts.baseUrl ?? "https://api.anthropic.com";
    const body: AnthropicRequest = {
      model: request.model,
      max_tokens:
        this.opts.maxTokens ?? request.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: "",
      messages: [{ role: "user", content: request.prompt }],
      stream: true,
      thinking: { type: "adaptive" },
    };
    if (request.temperature !== undefined)
      body.temperature = request.temperature;
    if (request.stop.length > 0) body.stop_sequences = [...request.stop];
    if (
      this.opts.effort !== undefined &&
      this.opts.effort !== "" &&
      this.opts.effort !== "off"
    ) {
      body.output_config = { effort: this.opts.effort };
    }

    const res = await postMessages(baseUrl, this.opts.apiKey, body, signal);
    if (res.body === null) {
      throw new ProviderError({
        code: "sse",
        retryable: false,
        message: "anthropic completion response had empty body",
      });
    }

    let sawFinish = false;
    for await (const ev of parseSSE(res.body, signal)) {
      signal.throwIfAborted();
      const e = ev as { type?: string } & Record<string, unknown>;
      if (e.type === "content_block_delta") {
        const delta = e.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          yield { type: "text-delta", text: delta.text };
        }
      } else if (e.type === "message_delta") {
        const delta = e.delta as { stop_reason?: string } | undefined;
        sawFinish = true;
        yield {
          type: "finish",
          reason: delta?.stop_reason === "max_tokens" ? "length" : "stop",
        };
      } else if (e.type === "error") {
        throw new ProviderError({
          code: "sse",
          retryable: true,
          message: "anthropic completion stream errored",
        });
      }
    }
    if (!sawFinish) yield { type: "finish", reason: "stop" };
  }
}

export function anthropicProvider(opts: AnthropicOpts): ProviderAdapter {
  return new AnthropicProvider(opts);
}

export function anthropicCompletionProvider(
  opts: AnthropicCompletionOpts,
): CompletionProviderAdapter {
  return new AnthropicCompletionProvider(opts);
}
