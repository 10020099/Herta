import type { PromptTrace } from "../capsule/types.js";
import type { ToolSchema } from "./tool.js";
import type { Message } from "./transcript.js";

export interface PromptFrame {
  stableSystem: string;
  repoInstructions: string;
  memoryContext: string;
  retrievedLore: string;
  messages: Message[];
  toolSchemas: ToolSchema[];
  trace: PromptTrace;
}

/**
 * Alias for the legacy `PromptFrame`, used when the actor-vs-backend
 * distinction matters at the call site. Identical shape — `PromptFrame`
 * is what the Herta actor consumes today.
 */
export type ActorPromptFrame = PromptFrame;

/**
 * Prompt frame produced for the silent coding agent backend per ADR 0007.
 * Deliberately has no Herta-identity slot, no lore slot, and no
 * `retrievedLore` field — the backend must not see Herta's voice or
 * relationship state. The `backendSystem` field carries the fixed
 * execution contract plus the serialized `HertaToAgentBrief`.
 */
export interface BackendPromptFrame {
  backendSystem: string;
  scopedRepoInstructions: string;
  scopedMemory: string;
  toolSchemas: ToolSchema[];
  messages: Message[];
  /**
   * Per-iteration todo reminder (ADR 0025 §2): the rendered current todo
   * list, recomputed by the turn loop on every provider call and appended
   * by `translateBackend` as a trailing system message AFTER `messages`.
   * Transient — never persisted into the durable transcript. Omitted /
   * empty when the todo list is empty. Sits at the very end of the wire
   * messages so the stable prefix (system + scoped + transcript) keeps
   * its prompt-cache prefix intact.
   */
  todoState?: string;
  trace: PromptTrace;
}
