import type { CapsuleType, ContextCapsule } from "../types/capsule.js";

export interface TraceEntry {
  capsuleId: string;
  type: CapsuleType;
  insertionLayer: ContextCapsule["insertionLayer"];
  priority: number;
  tokensEstimated: number;
  reason: string;
}

export interface BudgetSummary {
  insertionLayer: ContextCapsule["insertionLayer"];
  tokensUsed: number;
  tokensCap: number | null;
  droppedCount: number;
}

export interface PromptTrace {
  readonly ts: string;
  readonly activated: readonly TraceEntry[];
  readonly suppressed: readonly TraceEntry[];
  readonly budgets: readonly BudgetSummary[];
}

export const EMPTY_PROMPT_TRACE: PromptTrace = Object.freeze({
  ts: "1970-01-01T00:00:00.000Z",
  activated: Object.freeze([]),
  suppressed: Object.freeze([]),
  budgets: Object.freeze([]),
});

export interface Evidence {
  userMessage: string;
  workspaceRoot: string;
  loreExplicit: boolean;
  recentToolFailures?: ReadonlyArray<string>;
  visiblePaths?: ReadonlyArray<string>;
}

export interface CapsuleProducer {
  /** Called once per turn before activation. May return zero or more capsules. */
  produce(evidence: Evidence): ContextCapsule[];
}
