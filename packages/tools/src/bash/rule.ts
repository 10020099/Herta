import type {
  PermissionRule,
  RulePermissionEngine,
  RuleVerdict,
  ToolCallRequest,
  ToolContext,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import { splitShellSegments } from "../run-command/classifier.js";
import { checkReaderArgvPaths } from "../run-command/reader-guard.js";
import { PersistentShell, SHELL_BG_ID } from "./persistent-shell.js";
import { bashInputSchema } from "./schema.js";
import {
  classifyShellCommandDetailed,
  effectivePrograms,
  singleProgramArgv,
  tokenize,
} from "./shell-classifier.js";
import { type ShellPaths, shellPathsFor } from "./shell-paths.js";

export interface BashRuleDeps {
  /** The bash binary the tool runs; used only for path-spelling awareness. */
  bashPath: string | null;
}

/**
 * Permission rule for the minimal contract's `bash` (ADR 0040, D4): the
 * shell-string classifier decides block / ask / allow; on allow, the
 * allow-listed READER segments get the same async realpath guard
 * run_command applies (an innocent-basename symlink whose target leaves the
 * repo, or names a credential, is a hard deny — TOCTOU re-check happens
 * again inside the tool before execution).
 */
export function makeBashRule(deps: BashRuleDeps): PermissionRule {
  const paths: ShellPaths = shellPathsFor(deps.bashPath);
  return async (
    call: ToolCallRequest,
    ctx: ToolContext,
  ): Promise<RuleVerdict> => {
    const parsed = bashInputSchema.safeParse(call.input);
    if (!parsed.success) {
      return {
        kind: "deny",
        code: "invalid_input",
        reason: formatInputIssues(parsed.error),
      };
    }
    const shell = ctx.bg.getInternal(SHELL_BG_ID);
    const cwd =
      shell instanceof PersistentShell ? shell.cwd : ctx.workspaceRoot;
    const { verdict } = classifyShellCommandDetailed(parsed.data.command, {
      workspaceRoot: ctx.workspaceRoot,
      paths,
      cwd,
    });
    if (verdict.kind === "block") {
      return { kind: "deny", code: verdict.code, reason: verdict.reason };
    }
    if (verdict.kind === "ask") {
      // The effective program (ADR 0040): lets the approval cache scope this
      // ask by argv[0] like run_command's (the cache applies its own
      // interpreter/shell exclusion), and lets ADR 0030 project rules derive
      // from it (which DO allow the script-pinned `node scripts/x.mjs:*`
      // shape) — only when the line really runs one program (see
      // singleProgramArgv); otherwise every call re-prompts.
      const scopeOpts = { workspaceRoot: ctx.workspaceRoot, paths, cwd };
      const argv = singleProgramArgv(parsed.data.command, scopeOpts);
      // For the task CACHE only: the distinct programs of a chained line
      // (`git add && git commit && git status` → ["git"]).
      const programs = effectivePrograms(parsed.data.command, scopeOpts);
      return {
        kind: "ask",
        reason: verdict.reason,
        risk: verdict.risk,
        code: verdict.code,
        ...(argv !== null ? { argv } : {}),
        ...(programs !== null && programs.length > 0 ? { programs } : {}),
      };
    }
    // allow → realpath the reader operands of every segment (async guard).
    for (const segment of splitShellSegments(parsed.data.command)) {
      const { words } = tokenize(segment);
      if (words.length === 0) continue;
      const denial = await checkReaderArgvPaths(ctx.workspaceRoot, cwd, words);
      if (denial !== null) {
        return { kind: "deny", code: denial.code, reason: denial.message };
      }
    }
    return { kind: "allow" };
  };
}

export function registerBashRule(
  engine: RulePermissionEngine,
  deps: BashRuleDeps,
): void {
  engine.registerRule("bash", makeBashRule(deps));
}
