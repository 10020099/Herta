/**
 * OpenAI Responses API provider (`POST /v1/responses`).
 *
 * Two adapters over one codebase, mirroring the openai-compat split:
 *   - `OpenAIResponsesProvider`          — chat mode (板砖 backend, router,
 *                                          supervisor, title).
 *   - `OpenAIResponsesCompletionProvider` — completion mode (the narrative
 *                                          actor's fallback when Herta runs
 *                                          on OpenAI instead of DeepSeek).
 *
 * The Responses wire format differs from chat/completions in three ways this
 * file abstracts: (1) the request carries `input` (an item array) instead of
 * `messages`, (2) tool history is `function_call` / `function_call_output`
 * items rather than assistant `tool_calls` / role:"tool" messages, and
 * (3) the SSE stream names its deltas `response.output_text.delta` and
 * `response.function_call_arguments.delta` and finishes with
 * `response.completed`. Reasoning is controlled via `reasoning.effort`
 * (none | minimal | low | medium | high | xhigh | max).
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
import type { ApiKey } from "../openai-compat/api-key.js";
import { postJsonWithRetry } from "../openai-compat/retry-post.js";
import { parseSSE } from "../openai-compat/sse.js";

// ── Wire types ──────────────────────────────────────────────────────────────

type ResponsesItem =
  | {
      type: "message";
      role: "system" | "user" | "assistant";
      content: { type: "input_text" | "output_text"; text: string }[];
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

interface ResponsesTool {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
}

interface ResponsesRequest {
  model: string;
  input: ResponsesItem[];
  stream: true;
  tools?: ResponsesTool[];
  max_output_tokens?: number;
  temperature?: number;
  reasoning?: { effort?: string; summary?: string };
  stop?: string[];
  [key: string]: unknown;
}

// ── Shared translation ──────────────────────────────────────────────────────

function toItem(m: Message): ResponsesItem[] {
  if (m.role === "user") {
    return [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: m.text }],
      },
    ];
  }
  if (m.role === "assistant") {
    const out: ResponsesItem[] = [];
    if (m.text.length > 0) {
      out.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: m.text }],
      });
    }
    for (const c of m.toolCalls) {
      out.push({
        type: "function_call",
        call_id: c.id,
        name: c.tool,
        arguments: c.input === undefined ? "{}" : JSON.stringify(c.input),
      });
    }
    return out;
  }
  // role === "tool"
  return [
    {
      type: "function_call_output",
      call_id: m.toolCallId,
      output: toolMessageContent(m.result),
    },
  ];
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

function toTool(s: ToolSchema): ResponsesTool {
  return {
    type: "function",
    name: s.name,
    description: s.description,
    parameters: s.inputSchema,
  };
}

export interface ResponsesTranslateOpts {
  model: string;
  temperature?: number;
  maxTokens?: number;
  effort?: string;
}

function translateChat(
  frame: ProviderPromptFrame,
  opts: ResponsesTranslateOpts,
): ResponsesRequest {
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

  const input: ResponsesItem[] = [];
  for (const s of systems) {
    input.push({
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: s }],
    });
  }
  for (const m of messages) {
    input.push(...toItem(m));
  }

  const req: ResponsesRequest = {
    model: opts.model,
    input,
    stream: true,
  };
  if (toolSchemas.length > 0) {
    req.tools = toolSchemas.map(toTool);
  }
  if (opts.temperature !== undefined) req.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) req.max_output_tokens = opts.maxTokens;
  if (
    opts.effort !== undefined &&
    opts.effort !== "" &&
    opts.effort !== "off"
  ) {
    req.reasoning = { effort: opts.effort };
  }
  return req;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function postResponses(
  baseUrl: string,
  apiKey: ApiKey,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  return postJsonWithRetry(
    {
      url: `${baseUrl.replace(/\/$/, "")}/responses`,
      apiKey,
    },
    JSON.stringify(body),
    signal,
  );
}

// ── Stream ──────────────────────────────────────────────────────────────────

/** Accumulated responses function call whose args arrive as deltas. */
function mapResponsesStream(
  events: AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent, void, void> {
  let sawFinish = false;
  let sawText = false;
  const toolCalls: { call_id: string; name: string; arguments: string }[] = [];

  return (async function* (): AsyncGenerator<ProviderEvent, void, void> {
    for await (const ev of events) {
      signal.throwIfAborted();
      const e = ev as { type?: string } & Record<string, unknown>;

      if (e.type === "error") {
        const err = e.error as { message?: string } | undefined;
        throw new ProviderError({
          code: "sse",
          retryable: true,
          message: `responses stream carried an error: ${
            typeof err?.message === "string" ? err.message : JSON.stringify(err)
          }`,
        });
      }

      if (e.type === "response.output_text.delta") {
        const delta = e.delta;
        if (typeof delta === "string" && delta.length > 0) {
          sawText = true;
          yield { type: "text-delta", text: delta };
        }
        continue;
      }

      if (e.type === "response.output_item.done") {
        const item = e.item as
          | {
              type?: string;
              call_id?: string;
              name?: string;
              arguments?: string;
            }
          | undefined;
        if (item?.type === "function_call" && item.call_id !== undefined) {
          toolCalls.push({
            call_id: item.call_id,
            name: item.name ?? "",
            arguments: item.arguments ?? "{}",
          });
        }
        continue;
      }

      if (e.type === "response.completed") {
        sawFinish = true;
        if (toolCalls.length > 0) {
          for (const tc of toolCalls) {
            yield {
              type: "tool-call-request",
              call: {
                id: tc.call_id,
                tool: tc.name,
                input: parseArgs(tc.arguments),
              },
            };
          }
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "finish", reason: "stop" };
        }
        continue;
      }

      if (e.type === "response.failed") {
        sawFinish = true;
        yield { type: "finish", reason: "error" };
      }
    }

    if (!sawFinish) {
      if (toolCalls.length > 0) {
        throw new ProviderError({
          code: "sse",
          retryable: true,
          message: "responses stream ended before response.completed",
        });
      }
      if (sawText) {
        throw new ProviderError({
          code: "sse",
          retryable: true,
          message: "responses stream ended mid-generation",
        });
      }
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

export interface OpenAIResponsesOpts {
  baseUrl?: string;
  apiKey: ApiKey;
  model?: string;
  /** reasoning.effort. "off"/"" omit the reasoning block. */
  effort?: string;
  temperature?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

export class OpenAIResponsesProvider implements ProviderAdapter {
  constructor(private readonly opts: OpenAIResponsesOpts) {}

  async *streamChat(
    frame: ProviderPromptFrame,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent, void, void> {
    signal.throwIfAborted();
    const body = translateChat(frame, {
      model: this.opts.model ?? "gpt-5.6",
      temperature: this.opts.temperature,
      maxTokens: this.opts.maxTokens,
      effort: this.opts.effort,
    });
    const res = await postResponses(
      this.opts.baseUrl ?? "https://api.openai.com/v1",
      this.opts.apiKey,
      body,
      signal,
    );
    if (res.body === null) {
      throw new ProviderError({
        code: "sse",
        retryable: false,
        message: "responses response had empty body",
      });
    }
    yield* mapResponsesStream(parseSSE(res.body, signal), signal);
  }
}

// ── Completion adapter (narrative actor fallback) ───────────────────────────

export interface OpenAIResponsesCompletionOpts {
  baseUrl?: string;
  apiKey: ApiKey;
  model?: string;
  effort?: string;
  temperature?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Completion-mode adapter over the Responses API: the actor's narrative
 * prompt becomes a single user input and the stop sequences become the
 * `stop` array. Responses has no raw-completion endpoint, so this is the
 * closest analogue — the model answers as the same speaker.
 */
export class OpenAIResponsesCompletionProvider
  implements CompletionProviderAdapter
{
  constructor(private readonly opts: OpenAIResponsesCompletionOpts) {}

  async *streamCompletion(
    request: CompletionRequest,
    signal: AbortSignal,
  ): AsyncGenerator<CompletionEvent, void, void> {
    signal.throwIfAborted();
    const baseUrl = this.opts.baseUrl ?? "https://api.openai.com/v1";
    const body: ResponsesRequest = {
      model: request.model,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: request.prompt }],
        },
      ],
      stream: true,
    };
    if (request.maxTokens !== undefined) {
      body.max_output_tokens = request.maxTokens;
    }
    if (request.temperature !== undefined)
      body.temperature = request.temperature;
    if (request.stop.length > 0) body.stop = [...request.stop];
    if (
      this.opts.effort !== undefined &&
      this.opts.effort !== "" &&
      this.opts.effort !== "off"
    ) {
      body.reasoning = { effort: this.opts.effort };
    }

    const res = await postResponses(baseUrl, this.opts.apiKey, body, signal);
    if (res.body === null) {
      throw new ProviderError({
        code: "sse",
        retryable: false,
        message: "responses completion response had empty body",
      });
    }

    let sawFinish = false;
    for await (const ev of parseSSE(res.body, signal)) {
      signal.throwIfAborted();
      const e = ev as { type?: string } & Record<string, unknown>;
      if (e.type === "response.output_text.delta") {
        const delta = e.delta;
        if (typeof delta === "string" && delta.length > 0) {
          yield { type: "text-delta", text: delta };
        }
      } else if (e.type === "response.completed") {
        sawFinish = true;
        yield { type: "finish", reason: "stop" };
      } else if (e.type === "response.failed") {
        sawFinish = true;
        yield { type: "finish", reason: "error" };
      } else if (e.type === "error") {
        throw new ProviderError({
          code: "sse",
          retryable: true,
          message: "responses completion stream errored",
        });
      }
    }
    if (!sawFinish) yield { type: "finish", reason: "stop" };
  }
}

export function openaiResponsesProvider(
  opts: OpenAIResponsesOpts,
): ProviderAdapter {
  return new OpenAIResponsesProvider(opts);
}

export function openaiResponsesCompletionProvider(
  opts: OpenAIResponsesCompletionOpts,
): CompletionProviderAdapter {
  return new OpenAIResponsesCompletionProvider(opts);
}
