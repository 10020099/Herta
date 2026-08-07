export interface ToolCallRequest {
  id: string;
  tool: string;
  input: unknown;
}

export interface ToolResult<O = unknown> {
  ok: boolean;
  data?: O;
  error?: { code: string; message: string; retryable: boolean };
  suggestion?: string;
  summary: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: unknown;
}

import type { BackgroundHost } from "../backend/background-host.js";
import type { EventBus } from "../event-bus.js";
import type { MemoryManager } from "../memory-manager.js";
import type { ReadLedger } from "../read-ledger.js";
import type { TodoStore } from "../todo-store.js";
import type { AgentEvent } from "./events.js";

export interface ToolContext {
  sessionId: string;
  signal: AbortSignal;
  workspaceRoot: string;
  reads: ReadLedger;
  todos: TodoStore;
  /** Per-brief managed background commands (ADR 0025 slice 4). */
  bg: BackgroundHost;
  bus: EventBus<AgentEvent>;
  memory: MemoryManager;
}

export type ProgressFn = (event: { id: string; message: string }) => void;

export interface HertaTool {
  name: string;
  /**
   * True = the tool mutates no file/process/store state and is safe to
   * run concurrently with other read-only tools. Consulted by the turn
   * loop's parallel-batch partitioner (ADR 0025 slice 5): consecutive
   * read-only calls in one model iteration execute concurrently;
   * anything unmarked stays strictly serial. Default: absent = serial.
   */
  readOnly?: boolean;
  schema(): ToolSchema;
  run(
    call: ToolCallRequest,
    ctx: ToolContext,
    progress: ProgressFn,
  ): Promise<ToolResult>;
}
