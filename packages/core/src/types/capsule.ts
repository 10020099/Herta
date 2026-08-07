export type CapsuleType =
  | "herta_identity"
  | "herta_style"
  | "coding_behavior"
  | "repo_fact"
  | "project_memory"
  | "user_preference"
  | "tool_recovery"
  | "safety_policy"
  | "final_response_policy"
  | "lore"
  | "voice";

export type CapsuleSourceKind =
  | "built_in"
  | "project"
  | "user_memory"
  | "repo_scan"
  | "tool_observation";

export type CapsuleTrust = "trusted" | "validated" | "untrusted";

export interface CapsuleSource {
  kind: CapsuleSourceKind;
  uri?: string;
  trust: CapsuleTrust;
}

export type CapsuleActivationMode = "always" | "all" | "any" | "not" | "scored";

export interface CapsuleActivation {
  mode: CapsuleActivationMode;
  userMessagePatterns?: ReadonlyArray<string>;
  pathPatterns?: ReadonlyArray<string>;
  languages?: ReadonlyArray<string>;
  taskTypes?: ReadonlyArray<
    "review" | "debug" | "refactor" | "implement" | "test" | "explain"
  >;
  repoSignals?: ReadonlyArray<string>;
  toolSignals?: ReadonlyArray<string>;
  failureSignals?: ReadonlyArray<string>;
}

export type CapsuleInsertionLayer =
  | "system_safety"
  | "herta_core_identity"
  | "herta_voice_profile"
  | "herta_coding_behavior"
  | "active_task_frame"
  | "repo_context"
  | "project_memory"
  | "retrieved_lore"
  | "tool_results"
  | "near_turn_steering"
  | "final_response_policy";

export type CapsuleOverflow = "drop" | "compress" | "summarize" | "must_keep";

export interface CapsuleTokenBudget {
  maxTokens: number;
  overflow: CapsuleOverflow;
}

export interface ContextCapsule {
  id: string;
  type: CapsuleType;
  source: CapsuleSource;
  content: string;
  activation: CapsuleActivation;
  priority: number;
  insertionLayer: CapsuleInsertionLayer;
  tokenBudget: CapsuleTokenBudget;
  conflictGroup?: string;
  deterministic: true;
  enabled: boolean;
}
