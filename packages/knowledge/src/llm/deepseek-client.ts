import {
  type DeepSeekChatResponse,
  type DeepSeekClient,
  DeepSeekHttpError,
  DeepSeekShapeError,
  type DisambiguationBatchInput,
} from "./types.js";

export interface RealDeepSeekClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxRetries?: number;
  backoffMs?: number;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;

export class RealDeepSeekClient implements DeepSeekClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly backoffMs: number;

  constructor(opts: RealDeepSeekClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetch ?? fetch;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  async chatJson(
    input: DisambiguationBatchInput,
  ): Promise<DeepSeekChatResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const body = JSON.stringify({
      model: input.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPayload },
      ],
      ...(input.reasoningEffort !== undefined
        ? {
            thinking: { type: "enabled" },
            reasoning_effort: input.reasoningEffort,
          }
        : {}),
    });

    let attempt = 0;
    let lastErr: unknown;
    while (attempt < this.maxRetries) {
      attempt += 1;
      try {
        const resp = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body,
        });
        if (resp.status >= 500) {
          const text = await safeReadText(resp);
          lastErr = new DeepSeekHttpError(resp.status, text);
          if (attempt < this.maxRetries) {
            await sleep(this.backoffMs * 2 ** (attempt - 1));
            continue;
          }
          throw lastErr;
        }
        if (!resp.ok) {
          const text = await safeReadText(resp);
          throw new DeepSeekHttpError(resp.status, text);
        }
        const json = (await resp.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          model?: string;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          throw new DeepSeekShapeError("missing choices[0].message.content");
        }
        return {
          rawJsonText: content,
          model: typeof json.model === "string" ? json.model : this.model,
          usage:
            json.usage === undefined
              ? undefined
              : {
                  promptTokens: json.usage.prompt_tokens,
                  completionTokens: json.usage.completion_tokens,
                  totalTokens: json.usage.total_tokens,
                },
        };
      } catch (err) {
        if (err instanceof DeepSeekShapeError) throw err;
        if (err instanceof DeepSeekHttpError && err.status < 500) throw err;
        lastErr = err;
        if (attempt < this.maxRetries) {
          await sleep(this.backoffMs * 2 ** (attempt - 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("DeepSeek client exhausted retries");
  }
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
