import type { ProviderType } from "@herta/app-server";
import { ANTHROPIC_VERSION, providerFetch } from "@herta/providers";

/** A deliberately narrow, safe-to-render model-list result. API keys and raw
 * provider error bodies never cross the IPC boundary. */
export interface ProviderModelList {
  readonly models: readonly string[];
}

const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  deepseek: "https://api.deepseek.com",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  "openai-compat": "",
};

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Normalize OpenAI-style endpoints so both `https://host` and
 * `https://host/v1` resolve to one canonical `/v1/models` path. */
export function openAIModelsUrl(baseUrl: string): string {
  const normalized = withoutTrailingSlash(baseUrl.trim());
  return `${normalized.endsWith("/v1") ? normalized : `${normalized}/v1`}/models`;
}

export function providerModelsUrl(
  type: ProviderType,
  baseUrl?: string,
): string {
  const resolved = (baseUrl?.trim() || DEFAULT_BASE_URLS[type]).trim();
  if (resolved.length === 0) {
    throw new Error("A base URL is required before models can be fetched");
  }
  if (type === "openai" || type === "openai-compat") {
    return openAIModelsUrl(resolved);
  }
  if (type === "anthropic") {
    const normalized = withoutTrailingSlash(resolved);
    return `${normalized.endsWith("/v1") ? normalized : `${normalized}/v1`}/models`;
  }
  return `${withoutTrailingSlash(resolved)}/models`;
}

function extractModelIds(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const root = payload as { data?: unknown; models?: unknown };
  const candidates = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.models)
      ? root.models
      : [];
  return [
    ...new Set(
      candidates
        .map((entry) => {
          if (typeof entry === "string") return entry;
          if (typeof entry !== "object" || entry === null) return undefined;
          const model = entry as { id?: unknown; name?: unknown };
          return typeof model.id === "string"
            ? model.id
            : typeof model.name === "string"
              ? model.name
              : undefined;
        })
        .filter((id): id is string => id !== undefined && id.trim().length > 0)
        .map((id) => id.trim()),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

/** Fetch model IDs from the configured provider in the Electron main process.
 * A short bounded request prevents a settings panel from waiting forever; the
 * secret remains in the main process and only model IDs are returned. */
export async function fetchProviderModels(opts: {
  readonly type: ProviderType;
  readonly apiKey: string;
  readonly baseUrl?: string;
}): Promise<ProviderModelList> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const headers = new Headers({
      authorization: `Bearer ${opts.apiKey}`,
      accept: "application/json",
    });
    if (opts.type === "anthropic") {
      headers.set("x-api-key", opts.apiKey);
      headers.set("anthropic-version", ANTHROPIC_VERSION);
    }
    const response = await providerFetch()(
      providerModelsUrl(opts.type, opts.baseUrl),
      {
        method: "GET",
        headers,
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Model discovery failed with HTTP ${response.status}`);
    }
    const models = extractModelIds(await response.json());
    if (models.length === 0) {
      throw new Error("The provider returned no selectable models");
    }
    return { models };
  } finally {
    clearTimeout(timer);
  }
}
