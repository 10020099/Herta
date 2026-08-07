import { describe, expect, it } from "vitest";
import { EMPTY_PROMPT_TRACE } from "../capsule/types.js";
import type {
  ActorPromptFrame,
  BackendPromptFrame,
  PromptFrame,
} from "./prompt.js";

describe("prompt frame types", () => {
  it("ActorPromptFrame is the existing PromptFrame shape", () => {
    const actor: ActorPromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [],
      toolSchemas: [],
      trace: EMPTY_PROMPT_TRACE,
    };
    // Round-trip: an ActorPromptFrame is structurally a PromptFrame.
    const asLegacy: PromptFrame = actor;
    expect(asLegacy.stableSystem).toBe("");
  });

  it("BackendPromptFrame has the prescribed fields and no actor-only fields", () => {
    const backend: BackendPromptFrame = {
      backendSystem: "",
      scopedRepoInstructions: "",
      scopedMemory: "",
      toolSchemas: [],
      messages: [],
      trace: EMPTY_PROMPT_TRACE,
    };
    expect(backend.backendSystem).toBe("");

    // Compile-time guards: confirm BackendPromptFrame omits the actor-only
    // fields. A future contributor adding `stableSystem` or `retrievedLore`
    // to BackendPromptFrame breaks these assignments at compile time.
    type HasStableSystem = "stableSystem" extends keyof BackendPromptFrame
      ? true
      : false;
    const noStableSystem: HasStableSystem = false;
    expect(noStableSystem).toBe(false);

    type HasRetrievedLore = "retrievedLore" extends keyof BackendPromptFrame
      ? true
      : false;
    const noLore: HasRetrievedLore = false;
    expect(noLore).toBe(false);
  });
});
