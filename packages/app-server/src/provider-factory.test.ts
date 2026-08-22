import { describe, expect, it } from "vitest";
import {
  createChatProvider,
  createCompletionProvider,
  normalizeOpenAICompatibleBaseUrl,
} from "./provider-factory.js";

/** The provider classes keep constructor options private at the type level,
 * but the regression under test is precisely factory-to-adapter wiring. */
function configuredModel(provider: unknown): string | undefined {
  return (provider as { opts?: { model?: string } }).opts?.model;
}

function configuredBaseUrl(provider: unknown): string | undefined {
  return (provider as { opts?: { baseUrl?: string } }).opts?.baseUrl;
}

describe("createChatProvider", () => {
  it("normalizes third-party root and /v1 base URLs exactly once", () => {
    expect(normalizeOpenAICompatibleBaseUrl("https://gateway.example/")).toBe(
      "https://gateway.example/v1",
    );
    expect(
      normalizeOpenAICompatibleBaseUrl("https://gateway.example/v1/"),
    ).toBe("https://gateway.example/v1");

    const chat = createChatProvider({
      type: "openai-compat",
      apiKey: "sk-test",
      model: "third-party-model",
      actorModel: "third-party-model",
      baseUrl: "https://gateway.example",
    });
    const actor = createCompletionProvider({
      type: "openai-compat",
      apiKey: "sk-test",
      baseUrl: "https://gateway.example/v1",
    });
    expect(configuredBaseUrl(chat)).toBe("https://gateway.example/v1");
    expect(configuredBaseUrl(actor)).toBe("https://gateway.example/v1");
  });

  it("passes the selected role model to OpenAI Responses chat adapters", () => {
    const provider = createChatProvider({
      type: "openai",
      apiKey: "sk-test",
      model: "gpt-backend",
      actorModel: "gpt-actor",
    });

    expect(configuredModel(provider)).toBe("gpt-backend");
  });
});
