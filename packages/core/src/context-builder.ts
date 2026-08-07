import { EMPTY_PROMPT_TRACE } from "./capsule/types.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { TranscriptStore } from "./transcript-store.js";
import type { PromptFrame } from "./types/prompt.js";

export interface ContextBuilder {
  build(transcript: TranscriptStore, tools: ToolRegistry): PromptFrame;
}

export class StubContextBuilder implements ContextBuilder {
  build(transcript: TranscriptStore, tools: ToolRegistry): PromptFrame {
    return {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [...transcript.all()],
      toolSchemas: tools.list().map((t) => t.schema()),
      trace: EMPTY_PROMPT_TRACE,
    };
  }
}
