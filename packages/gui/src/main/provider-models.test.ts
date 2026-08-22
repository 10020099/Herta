import { setProviderFetch } from "@herta/providers";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchProviderModels,
  openAIModelsUrl,
  providerModelsUrl,
} from "./provider-models.js";

afterEach(() => setProviderFetch(undefined));

describe("providerModelsUrl", () => {
  it("normalizes OpenAI-compatible root and /v1 base URLs to /v1/models", () => {
    expect(openAIModelsUrl("https://gateway.example/")).toBe(
      "https://gateway.example/v1/models",
    );
    expect(
      providerModelsUrl("openai-compat", "https://gateway.example/v1/"),
    ).toBe("https://gateway.example/v1/models");
  });

  it("preserves provider-native model-list paths", () => {
    expect(providerModelsUrl("deepseek", "https://api.deepseek.com/")).toBe(
      "https://api.deepseek.com/models",
    );
    expect(providerModelsUrl("anthropic", "https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1/models",
    );
  });
});

describe("fetchProviderModels", () => {
  it("uses the installed provider transport and returns sorted, deduplicated IDs", async () => {
    let capturedUrl = "";
    let authorization: string | null = null;
    setProviderFetch(async (url, init) => {
      capturedUrl = String(url);
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(
        JSON.stringify({
          data: [{ id: "model-z" }, { id: "model-a" }, { id: "model-z" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await expect(
      fetchProviderModels({
        type: "openai-compat",
        apiKey: "secret-key",
        baseUrl: "https://gateway.example/v1",
      }),
    ).resolves.toEqual({ models: ["model-a", "model-z"] });
    expect(capturedUrl).toBe("https://gateway.example/v1/models");
    expect(authorization).toBe("Bearer secret-key");
  });

  it("uses Anthropic's model-list authentication headers", async () => {
    let capturedHeaders: Headers | undefined;
    setProviderFetch(async (_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ data: [{ id: "claude-test" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(
      fetchProviderModels({ type: "anthropic", apiKey: "anthropic-key" }),
    ).resolves.toEqual({ models: ["claude-test"] });
    expect(capturedHeaders?.get("x-api-key")).toBe("anthropic-key");
    expect(capturedHeaders?.get("anthropic-version")).toBeTruthy();
  });

  it("returns only a safe status on provider failure", async () => {
    setProviderFetch(
      async () => new Response("private detail", { status: 403 }),
    );
    await expect(
      fetchProviderModels({ type: "openai", apiKey: "secret-key" }),
    ).rejects.toThrow("HTTP 403");
  });
});
