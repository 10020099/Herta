import type { ToolSchema } from "./tool.js";
import type { Message } from "./transcript.js";

/**
 * Chat-mode prompt frame for the actor-side SIDECAR calls (mood router,
 * supervisor judge, session title, recap summarizer) — the v0.1 actor's
 * frame shape, kept because `translate.ts` maps it onto the OpenAI wire
 * format. The narrative-completion actor itself (D8) does not use it.
 */
export interface PromptFrame {
  stableSystem: string;
  /**
   * Repo instruction files for the chat-mode sidecar calls. Upstream removed
   * the slot (2026-10-12, "the unused repo-instruction slots are removed" —
   * nothing populated it there); THIS fork keeps it because the project-rule
   * store (`.herta/rules*.md`) renders into it. Optional: every caller that
   * has nothing to say omits it.
   */
  repoInstructions?: string;
  memoryContext: string;
  retrievedLore: string;
  messages: Message[];
  toolSchemas: ToolSchema[];
}

/**
 * Alias for the legacy `PromptFrame`, used when the actor-vs-backend
 * distinction matters at the call site. Identical shape.
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
  /**
   * The fork's project rules (`.herta/rules*.md`, rendered by
   * `BackendContextBuilder` from its `projectRules` getter). Upstream removed
   * this slot on 2026-10-12 — in their tree nothing populated it — and with
   * it the two `translateBackend` system branches. Here it is populated on
   * every dispatch, so the slot, the budget estimate and the translation
   * branch all stay. Always set by the builder; optional so a frame literal
   * that has nothing to add need not spell it.
   */
  scopedRepoInstructions?: string;
  scopedMemory: string;
  toolSchemas: ToolSchema[];
  messages: Message[];
  /**
   * The per-iteration state trailer, recomputed by the turn loop on every
   * provider call and appended by `translateBackend` as a trailing system
   * message AFTER `messages`: once old
   * iterations have been dropped from the transcript, the working state the
   * harness keeps (files changed, live background commands, findings, the
   * user's steers — `working-state.ts`); and, near the step limit, the
   * steps left. Transient — never persisted into the durable transcript.
   * Omitted / empty when there is nothing to say. Sits at the very end of
   * the wire messages so the stable prefix (system + scoped + transcript)
   * keeps its prompt-cache prefix intact.
   */
  trailingState?: string;
}
