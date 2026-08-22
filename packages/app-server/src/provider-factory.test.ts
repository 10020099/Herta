import { describe, expect, it } from "vitest";
import { createChatProvider } from "./provider-factory.js";

/** The provider classes keep constructor options private at the type level,
 * but the regression under test is precisely factory-to-adapter wiring. */
function configuredModel(provider: unknown): string | undefined {
  return (provider as { opts?: { model?: string } }).opts?.model;
}

describe("createChatProvider", () => {
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
