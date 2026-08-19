/**
 * Provider factory — turn the resolved `providers` config into concrete
 * adapter instances for each role, dispatching on the provider type.
 *
 * Role split mirrors the runtime's two inference surfaces:
 *   - completion (the narrative actor, D8) — DeepSeek /beta/completions is
 *     the canonical implementation; OpenAI and Anthropic have no raw
 *     completion endpoint, so their completion adapters ride the Responses /
 *     Messages API with the actor prompt as a single user turn.
 *   - chat (板砖 backend, router, supervisor, title) — DeepSeek and
 *     openai-compat speak chat/completions; OpenAI speaks /v1/responses;
 *     Anthropic speaks /v1/messages.
 *
 * Thinking effort is a per-provider wire concept with different vocabularies,
 * normalized here from the single `ThinkingEffort` enum (see types.ts):
 *   - DeepSeek  reasoning_effort: low | high | max (off → omit)
 *   - OpenAI    reasoning.effort: none…max (off → omit)
 *   - Anthropic output_config.effort: low | medium | high | max (off → omit)
 */
import type { CompletionProviderAdapter, ProviderAdapter } from "@herta/core";
import {
  type ApiKey,
  anthropicCompletionProvider,
  anthropicProvider,
  deepseekCompletionProvider,
  deepseekProvider,
  OpenAICompatibleCompletionProvider,
  OpenAICompatibleProvider,
  openaiResponsesCompletionProvider,
  openaiResponsesProvider,
} from "@herta/providers";
import type { ProviderType, ThinkingEffort } from "./types.js";

export interface ChatProviderFactoryOpts {
  readonly type: ProviderType;
  readonly apiKey: ApiKey;
  readonly model: string;
  readonly baseUrl?: string;
  readonly thinking?: ThinkingEffort;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface CompletionProviderFactoryOpts {
  readonly type: ProviderType;
  readonly apiKey: ApiKey;
  readonly baseUrl?: string;
  readonly thinking?: ThinkingEffort;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  deepseek: "https://api.deepseek.com",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  "openai-compat": "",
};

function deepseekThinking(
  t: ThinkingEffort | undefined,
): false | "low" | "high" | "max" {
  if (t === "off") return false;
  if (t === "none" || t === "minimal" || t === "low") return "low";
  if (t === "medium" || t === "high") return "high";
  return "max";
}

function openaiEffort(t: ThinkingEffort | undefined): string | undefined {
  if (t === undefined || t === "off") return undefined;
  return t;
}

function anthropicEffort(t: ThinkingEffort | undefined): string | undefined {
  if (t === undefined || t === "off") return undefined;
  if (t === "none" || t === "minimal") return "low";
  if (t === "xhigh" || t === "max") return "max";
  return t;
}

/** Chat-mode adapter for the coding backend / router / supervisor / title. */
export function createChatProvider(
  opts: ChatProviderFactoryOpts,
): ProviderAdapter {
  const baseUrl = opts.baseUrl?.trim()
    ? opts.baseUrl
    : DEFAULT_BASE_URLS[opts.type];

  switch (opts.type) {
    case "deepseek":
      return deepseekProvider({
        apiKey: opts.apiKey,
        model: opts.model,
        thinking: deepseekThinking(opts.thinking),
        ...(baseUrl ? { baseUrl } : {}),
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      });
    case "openai":
      return openaiResponsesProvider({
        apiKey: opts.apiKey,
        model: opts.model,
        effort: openaiEffort(opts.thinking),
        ...(baseUrl ? { baseUrl } : {}),
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      });
    case "anthropic":
      return anthropicProvider({
        apiKey: opts.apiKey,
        model: opts.model,
        effort: anthropicEffort(opts.thinking),
        ...(baseUrl ? { baseUrl } : {}),
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      });
    case "openai-compat":
      return new OpenAICompatibleProvider({
        baseUrl,
        apiKey: opts.apiKey,
        model: opts.model,
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      });
    default: {
      const _exhaustive: never = opts.type;
      throw new Error(`unknown provider type: ${String(_exhaustive)}`);
    }
  }
}

/** Completion-mode adapter for the narrative actor. */
export function createCompletionProvider(
  opts: CompletionProviderFactoryOpts,
): CompletionProviderAdapter {
  const baseUrl = opts.baseUrl?.trim()
    ? opts.baseUrl
    : DEFAULT_BASE_URLS[opts.type];

  switch (opts.type) {
    case "deepseek":
      return deepseekCompletionProvider({
        apiKey: opts.apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      });
    case "openai":
      return openaiResponsesCompletionProvider({
        apiKey: opts.apiKey,
        effort: openaiEffort(opts.thinking),
        ...(baseUrl ? { baseUrl } : {}),
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      });
    case "anthropic":
      return anthropicCompletionProvider({
        apiKey: opts.apiKey,
        effort: anthropicEffort(opts.thinking),
        ...(baseUrl ? { baseUrl } : {}),
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      });
    case "openai-compat":
      return new OpenAICompatibleCompletionProvider({
        baseUrl,
        apiKey: opts.apiKey,
        path: "/v1/completions",
      });
    default: {
      const _exhaustive: never = opts.type;
      throw new Error(`unknown provider type: ${String(_exhaustive)}`);
    }
  }
}
