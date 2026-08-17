import { randomUUID } from "node:crypto";
import type { PermissionRequest } from "./types/events.js";
import type { ToolCallRequest, ToolContext } from "./types/tool.js";

export type RiskLevel =
  | "workspace_read"
  | "workspace_write"
  | "workspace_destructive"
  | "network";

export type RuleVerdict =
  | { kind: "allow" }
  | {
      kind: "ask";
      reason: string;
      risk: RiskLevel;
      /** Stable machine code for the ask class (e.g. "command_ask_unknown").
       *  Renderers localize the user-facing summary by this code (the reason
       *  string stays the neutral-English machine contract per D2). */
      code?: string;
      diff?: string;
      files?: readonly string[];
    }
  | {
      kind: "deny";
      reason: string;
      code?: string;
      /** Model-facing text for the refusal (ADR 0040): the minimal
       *  contract's rules answer in the trained shape's own strings, which
       *  the loop sends verbatim instead of `failed: <code>` + JSON. Absent
       *  → the loop's default rendering (unchanged for every other rule). */
      modelText?: string;
    };

export type PermissionRule = (
  call: ToolCallRequest,
  ctx: ToolContext,
) => RuleVerdict | Promise<RuleVerdict>;

export interface AskResolver {
  present(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<"allow" | "deny">;
}

export type PermissionDecision =
  | { kind: "allow" }
  | {
      kind: "ask";
      request: PermissionRequest;
      decision: Promise<"allow" | "deny">;
    }
  | { kind: "deny"; reason: string; code?: string; modelText?: string };

export interface PermissionEngine {
  check(call: ToolCallRequest, ctx: ToolContext): Promise<PermissionDecision>;
  resolve(requestId: string, decision: "allow" | "deny"): void;
}

export class NoopPermissionEngine implements PermissionEngine {
  async check(
    _call: ToolCallRequest,
    _ctx: ToolContext,
  ): Promise<PermissionDecision> {
    return { kind: "allow" };
  }
  resolve(_requestId: string, _decision: "allow" | "deny"): void {
    // unreachable in slice B
  }
}

export class RulePermissionEngine implements PermissionEngine {
  private readonly rules = new Map<string, PermissionRule>();
  private readonly ask: AskResolver;

  constructor(deps: { ask: AskResolver }) {
    this.ask = deps.ask;
  }

  registerRule(toolName: string, rule: PermissionRule): void {
    if (this.rules.has(toolName)) {
      throw new Error(`duplicate rule for tool: ${toolName}`);
    }
    this.rules.set(toolName, rule);
  }

  async check(
    call: ToolCallRequest,
    ctx: ToolContext,
  ): Promise<PermissionDecision> {
    const rule = this.rules.get(call.tool);
    const verdict: RuleVerdict = rule
      ? await rule(call, ctx)
      : { kind: "allow" };

    if (verdict.kind === "allow") return { kind: "allow" };
    if (verdict.kind === "deny") {
      return {
        kind: "deny",
        reason: verdict.reason,
        code: verdict.code,
        ...(verdict.modelText !== undefined
          ? { modelText: verdict.modelText }
          : {}),
      };
    }

    const id = randomUUID();
    const request: PermissionRequest = {
      id,
      call,
      reason: verdict.reason,
      risk: verdict.risk,
      code: verdict.code,
      diff: verdict.diff,
      files: verdict.files,
    };
    const decision = this.ask.present(request, ctx.signal);
    return { kind: "ask", request, decision };
  }

  resolve(_requestId: string, _decision: "allow" | "deny"): void {
    // no-op; reserved for out-of-band resolution flows
  }
}
