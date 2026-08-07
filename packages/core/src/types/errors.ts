export type AgentErrorKind =
  | "interrupted"
  | "provider_failed"
  | "tool_failed"
  | "permission_denied"
  | "invalid_tool_call"
  | "internal";

export interface AgentError {
  kind: AgentErrorKind;
  message: string;
  cause?: unknown;
}
