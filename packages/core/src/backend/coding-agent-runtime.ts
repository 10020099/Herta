import { mkdirSync } from "node:fs";
import { ExecutionReportBuilder } from "../bridge/report-builder.js";
import type {
  AgentExecutionReport,
  HertaToAgentBrief,
  RunCommandData,
  TestRunSummary,
} from "../bridge/types.js";
import type { EventBus } from "../event-bus.js";
import { FindingsLedger } from "../findings-ledger.js";
import type { MemoryManager } from "../memory-manager.js";
import type { PermissionEngine, RiskLevel } from "../permission-engine.js";
import { ReadLedger } from "../read-ledger.js";
import { TodoStore } from "../todo-store.js";
import type { ToolRegistry } from "../tool-registry.js";
import { TranscriptStore } from "../transcript-store.js";
import type { AgentEvent } from "../types/events.js";
import type { ProviderAdapter } from "../types/provider.js";
import type { BackendContextBuilder } from "./backend-context-builder.js";
import { runBackendTurnLoop } from "./backend-turn-loop.js";
import { BackgroundHost } from "./background-host.js";
import type { BackendPromptBudget } from "./context-budget.js";

/**
 * Tools whose SUCCESS argues that the task advanced (audit 2026-07-24, 1.2).
 * Read-only and bookkeeping tools — read_file, list_files, search_text, glob,
 * git_status, git_diff, todo_write, command_output — execute successfully
 * while changing nothing, so counting them as completion evidence let a
 * backend that merely investigated report 完成.
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "edit_file",
  "write_new_file",
  "run_command",
  "command_stop",
  "memory_save",
]);

export interface CodingAgentRuntimeDeps {
  sessionId: string;
  provider: ProviderAdapter;
  tools: ToolRegistry;
  permissions: PermissionEngine;
  backendBuilder: BackendContextBuilder;
  bus: EventBus<AgentEvent>;
  clock: () => Date;
  workspaceRoot: string;
  memory: MemoryManager;
  /** Working-set prompt budget override (ADR 0025 slice 2); defaults to
   *  DEFAULT_BACKEND_PROMPT_BUDGET in the turn loop. */
  budget?: BackendPromptBudget;
}

export interface RunBriefOptions {
  signal?: AbortSignal;
  scopedRepoInstructions?: string;
  scopedMemory?: string;
  /**
   * User-only message history threaded by the actor. The backend reads
   * this as task context in place of the deprecated brief framing.
   * Required for non-trivial dispatches; defaults to `[]` (degrades to
   * a contract-only prompt, useful in test fixtures).
   */
  userMessages?: ReadonlyArray<{ text: string }>;
  /** How many older user messages the caller's caps elided from
   *  `userMessages` (ADR 0025 slice 2); surfaces as an honest elision
   *  note in the serialized history. Defaults to 0. */
  omittedUserMessages?: number;
  /** Pre-rendered recent dialogue since the last dispatch (referent resolution). */
  recentDialogue?: string;
  /** Pre-rendered prior-dispatch working history. */
  workingHistory?: string;
  /** The session's interaction language (ADR 0016). Threaded to the backend
   *  builder so an EN session gets an English backend prompt; absent → "zh". */
  lang?: "zh" | "en";
}

interface PendingPermission {
  tool: string;
  risk: RiskLevel;
}

/**
 * Silent coding-agent runtime per ADR 0007 / D6. Long-lived infrastructure
 * (provider, tools, permissions, backend builder, bus, memory) is owned by
 * the instance; per-brief state (transcript, plan, research, read ledger)
 * is reset on every `runBrief` call. The runtime never speaks to the user
 * and never role-plays Herta — it returns a structured `AgentExecutionReport`.
 */
export class CodingAgentRuntime {
  private readonly deps: CodingAgentRuntimeDeps;
  private briefInFlight = false;

  constructor(deps: CodingAgentRuntimeDeps) {
    this.deps = deps;
  }

  async runBrief(
    brief: HertaToAgentBrief,
    opts: RunBriefOptions = {},
  ): Promise<AgentExecutionReport> {
    if (this.briefInFlight) {
      // A real Error, not an AgentError literal (audit 2026-07-10, finding
      // 22): the plain object had no stack and failed `instanceof Error`, so
      // generic `err instanceof Error ? … : String(err)` handlers rendered
      // "[object Object]". The `kind` property keeps the bridge's AgentError
      // duck-typing working unchanged.
      throw Object.assign(new Error("brief already in progress"), {
        kind: "internal" as const,
      });
    }
    this.briefInFlight = true;
    try {
      // Ensure the managed sandbox exists before any tool runs. A fresh
      // session whose first @板砖 action is read-only (e.g. `git status`)
      // would otherwise run with cwd = a not-yet-created workspace dir and
      // get ENOENT. Idempotent.
      mkdirSync(this.deps.workspaceRoot, { recursive: true });

      const transcript = new TranscriptStore();
      const todos = new TodoStore();
      const reads = new ReadLedger();
      const bg = new BackgroundHost();
      const findings = new FindingsLedger();

      const builder = new ExecutionReportBuilder(brief.taskId);
      const pendingPermissions = new Map<string, PendingPermission>();
      let failed = false;
      /** The KIND of the last turn.failed — `"interrupted"` distinguishes a
       *  deliberate stop from a real failure (audit 2026-07-24, 1.4). */
      let lastErrorKind: string | undefined;
      // Report-integrity trackers (板砖 review 2026-07-04):
      // - changedByPath: files harvested from SUCCESSFUL mutation results
      //   only. The old source was `patch.preview` — which permission RULES
      //   publish BEFORE the user decides — so a denied (or post-approval
      //   failed) edit still entered `changedFiles`, the done-marker read
      //   `完成 · 1 file`, and the false fact flowed into the next
      //   dispatch's working history (ADR 0010 poisoned). Map keyed by path
      //   so a file edited twice counts once (latest wins).
      // - okEvidence: only successful tool results argue for "completed" —
      //   a run whose sole evidence is `denied`/failures must not claim it.
      // - deniedPermissions: makes the `blocked` status reachable.
      const changedByPath = new Map<
        string,
        { path: string; kind: "created" | "modified"; diffSummary: string }
      >();
      let okEvidence = 0;
      let deniedPermissions = 0;

      const absorb = (event: AgentEvent): void => {
        // Backend-layer only (audit 2026-07-10 §6): the per-session bus is
        // shared with the actor layer. Today no actor-layer event of the
        // absorbed types fires during a brief, but a future actor-layer
        // tool.call.finished / permission.* would silently contaminate this
        // report — filter at the subscription, not by luck.
        if (event.layer !== "backend") return;
        type WithTestRun = { testRun?: TestRunSummary };
        switch (event.type) {
          case "tool.call.finished": {
            // A recorded finding is the backend's own conclusion, not a tool
            // receipt (ADR 0039): its own evidence kind, so the done marker
            // can list conclusions apart from receipts — and it argues for
            // 完成 on a brief whose deliverable IS the conclusion (the 1.2
            // rule below excludes read-only tools because they only prove
            // execution; a cited finding is a delivered result).
            if (event.tool === "report_finding" && event.result.ok) {
              const data = event.result.data as unknown as
                | { claim?: unknown; cites?: unknown }
                | undefined;
              const claim =
                typeof data?.claim === "string"
                  ? data.claim
                  : event.result.summary;
              const cites = Array.isArray(data?.cites)
                ? data.cites.filter((c): c is string => typeof c === "string")
                : [];
              builder.addEvidence({
                kind: "finding",
                summary: claim,
                source: cites.join(", "),
              });
              okEvidence += 1;
              break;
            }
            builder.addEvidence({
              kind: "tool",
              summary: event.result.summary,
              source: event.id,
            });
            // Only tools that CHANGE something count toward a completion
            // claim (audit 2026-07-24, 1.2). `ToolResult.ok` means the tool
            // EXECUTED, not that the task advanced — so read_file, glob,
            // search_text, git_status, todo_write and friends all argued for
            // "completed", and a backend that read three files and said "that
            // function doesn't exist here, I can't do this" reported 完成.
            // That marker is durable, Herta reads it as ground truth
            // (supervisor rule 9), and it re-enters the next dispatch's
            // workingHistory as the fact 完成.
            //
            // run_command carries the same trap one level down: the tool
            // returns ok:true for EVERY exit code (running the command is
            // what succeeded), so a failing build was completion evidence.
            // It argues for 完成 only at exit 0 — a non-zero exit or a
            // background start (exitCode null) proves nothing about the
            // task, only about the shell.
            if (event.result.ok && MUTATING_TOOLS.has(event.tool)) {
              const exit =
                event.tool === "run_command"
                  ? (event.result.data as unknown as RunCommandData | undefined)
                      ?.exitCode
                  : 0;
              if (exit === 0) okEvidence += 1;
            }
            if (event.tool === "run_command" && event.result.ok) {
              const data = event.result.data as unknown as
                | WithTestRun
                | undefined;
              if (data?.testRun !== undefined) {
                builder.addTest(data.testRun);
              }
            }
            if (
              (event.tool === "edit_file" || event.tool === "write_new_file") &&
              event.result.ok
            ) {
              const data = event.result.data as unknown as
                | { relPath?: unknown; diff?: unknown }
                | undefined;
              const path =
                typeof data?.relPath === "string" ? data.relPath : undefined;
              if (path !== undefined) {
                changedByPath.set(path, {
                  path,
                  kind:
                    event.tool === "write_new_file" ? "created" : "modified",
                  diffSummary:
                    typeof data?.diff === "string"
                      ? summarizeDiff(data.diff)
                      : event.result.summary,
                });
              }
            }
            if (event.result.ok === false && event.result.error !== undefined) {
              builder.addResidualRisk(
                `Tool ${event.id} failed: ${event.result.error.message}`,
              );
            }
            break;
          }
          case "permission.requested": {
            pendingPermissions.set(event.request.id, {
              tool: event.request.call.tool,
              risk: event.request.risk,
            });
            break;
          }
          case "permission.resolved": {
            const pending = pendingPermissions.get(event.id);
            // "blocked" (rule-deny) has no matching permission.requested —
            // the event carries its own tool; risk stays "unknown" (the
            // engine denied outright without classifying a risk level).
            const tool = pending?.tool ?? event.tool ?? event.id;
            const risk = pending?.risk ?? "unknown";
            builder.addPermission({
              tool,
              risk,
              decision: event.decision,
              summary: `${tool} ${event.decision}`,
            });
            // Blocked counts like denied for the status gate (finding 6): a
            // run whose mutations were refused — by the user OR by policy —
            // must not report 完成.
            if (event.decision === "deny" || event.decision === "blocked") {
              deniedPermissions += 1;
            }
            pendingPermissions.delete(event.id);
            break;
          }
          default:
            break;
        }
      };

      // Subscribe via bus.onAny so we observe events published directly
      // by tools/permission rules (e.g. patch.preview) in addition to the
      // ones yielded by the turn loop. The turn loop's emit() also routes
      // through the bus, so this single subscription is the canonical
      // channel for absorb.
      const unsubscribe = this.deps.bus.onAny(absorb);

      const turnDeps = {
        sessionId: this.deps.sessionId,
        provider: this.deps.provider,
        tools: this.deps.tools,
        permissions: this.deps.permissions,
        backendBuilder: this.deps.backendBuilder,
        transcript,
        todos,
        bg,
        findings,
        bus: this.deps.bus,
        clock: this.deps.clock,
        workspaceRoot: this.deps.workspaceRoot,
        reads,
        memory: this.deps.memory,
        ...(this.deps.budget !== undefined ? { budget: this.deps.budget } : {}),
      };
      const handle = {
        signal: opts.signal ?? new AbortController().signal,
        userMessages: opts.userMessages ?? [],
        omittedUserMessages: opts.omittedUserMessages ?? 0,
        scopedRepoInstructions: opts.scopedRepoInstructions ?? "",
        scopedMemory: opts.scopedMemory ?? "",
        recentDialogue: opts.recentDialogue ?? "",
        workingHistory: opts.workingHistory ?? "",
        lang: opts.lang ?? "zh",
      };

      let stoppedBackground = 0;
      try {
        for await (const event of runBackendTurnLoop(turnDeps, brief, handle)) {
          if (event.type === "turn.failed") {
            failed = true;
            // Keep the KIND, not just the fact (audit 2026-07-24, 1.4). The
            // loop already separates an interrupt from an internal failure;
            // collapsing both into `failed` is what made a user's Stop read
            // as "板砖 broke".
            lastErrorKind = event.error.kind;
            builder.addResidualRisk(
              event.error.kind === "interrupted"
                ? `Turn interrupted: ${event.error.message}`
                : `Turn failed: ${event.error.message}`,
            );
          }
        }
      } finally {
        unsubscribe();
        // No unmanaged backgrounding (ADR 0025 slice 4): whatever the model
        // left running dies with the brief — on success, failure, AND abort
        // (this finally runs when the loop throws).
        stoppedBackground = await bg.stopAll();
      }
      if (stoppedBackground > 0) {
        builder.addResidualRisk(
          `${stoppedBackground} background command(s) still running at brief end were stopped`,
        );
      }

      // Flush the applied-write harvest (deduped by path) into the report.
      for (const file of changedByPath.values()) {
        builder.addChangedFile(file);
      }

      // Fold unfinished todos into nextActions (ADR 0025 §2) — for every
      // outcome, including failed: an honest unfinished list is exactly
      // what the next dispatch (via the done-marker → workingHistory) and
      // Herta's commentary need to see.
      for (const todo of todos.unfinished()) {
        builder.addNextAction(todo.content);
      }

      if (failed) {
        // An interrupt is a distinct ending, not a failure (1.4).
        builder.setStatus(
          lastErrorKind === "interrupted" ? "interrupted" : "failed",
        );
      } else {
        const partialReport = this.peekReport(builder);
        // tests[] carries failing runs too (that is its job — the report
        // must show them). Only a PASS argues for 完成; a run whose sole
        // evidence is a failing suite is `partial`, exactly like the
        // all-failures comment below says. (The exit-0 gate on okEvidence
        // already covers non-test commands.)
        const hasOkEvidence =
          okEvidence > 0 ||
          partialReport.tests.some((t) => t.status === "passed") ||
          partialReport.changedFiles.length > 0;
        if (deniedPermissions > 0) {
          // A refusal is a FIRST-CLASS term, not a tie-breaker (audit
          // 2026-07-24, 1.3). It used to decide ONLY when nothing landed,
          // and otherwise fell straight through to the completed/partial
          // split with no denial term at all — so a PARTIALLY refused run
          // (model edits file A with approval, user denies file B) reported
          // 完成: the machine claim both the user and Herta read said work
          // they had explicitly refused was done, the denial surviving only
          // as a residual-risk line. A refusal now CAPS the status.
          //
          // "Landed" is mutations/verification — deliberately NOT
          // `hasOkEvidence`, which counts read_file/todo_write/git_status
          // and would call a run that only READ things "partial" instead of
          // 受阻 (and see 1.2 on that counting generally).
          const landed =
            partialReport.changedFiles.length > 0 ||
            partialReport.tests.length > 0;
          builder.setStatus(landed ? "partial" : "blocked");
        } else {
          // Only SUCCESSFUL tool results (or harvested tests/files) argue
          // for completion; a run whose evidence is all failures reports
          // partial rather than claiming success.
          builder.setStatus(hasOkEvidence ? "completed" : "partial");
        }
      }

      return builder.build();
    } finally {
      this.briefInFlight = false;
    }
  }

  private peekReport(builder: ExecutionReportBuilder): AgentExecutionReport {
    return builder.setStatus("partial").build();
  }
}

function summarizeDiff(diff: string): string {
  const lines = diff.split("\n");
  const adds = lines.filter(
    (l) => l.startsWith("+") && !l.startsWith("+++"),
  ).length;
  const dels = lines.filter(
    (l) => l.startsWith("-") && !l.startsWith("---"),
  ).length;
  return `+${adds} -${dels}`;
}
