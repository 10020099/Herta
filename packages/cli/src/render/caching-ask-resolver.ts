import {
  type AskResolver,
  deriveProjectCommandRule,
  isRuleEligibleAskCode,
  type PermissionRequest,
  type ProjectCommandRuleStore,
  permissionCacheScope,
  ruleDisplay,
  type SessionApprovalCache,
} from "@herta/core";
import type { CliAskResolver } from "./permission-prompt.js";
import type { Style } from "./style.js";

/**
 * AskResolver wrapper that short-circuits permission prompts when the
 * (tool, risk) pair was previously approved with "yes-and-remember"
 * (the 'a' option) in this session, or when a persisted PROJECT command
 * rule covers the argv (the 'p' option, ADR 0030). On either hit, returns
 * "allow" immediately and writes a dim auto-allow marker so the user can
 * see their earlier choice is still in effect.
 *
 * Cache writes happen only when the inner resolver returns
 * `allow_remember`, AND only when the (tool, risk) pair is in the
 * cache's allow-list (defense-in-depth). Project-rule writes happen only
 * on `allow_project`, re-derived from the live request — the inner
 * resolver only offers 'p' when a rule is derivable, and derivation
 * re-runs all its guards here anyway.
 */
export class CachingAskResolver implements AskResolver {
  constructor(
    private readonly inner: CliAskResolver,
    private readonly cache: SessionApprovalCache,
    private readonly stdout: NodeJS.WritableStream,
    private readonly style: Style,
    private readonly rules?: ProjectCommandRuleStore,
  ) {}

  async present(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<"allow" | "deny"> {
    const tool = request.call.tool;
    const risk = request.risk;
    // The per-call scope: argv[0] for run_command, the resolved write path for
    // edit_file/write_new_file (audit T3.4). One "remember" now covers only
    // that binary / that file, not the whole risk class.
    const scope = permissionCacheScope(request);
    const label =
      scope === undefined ? `${tool} ${risk}` : `${tool} ${scope} ${risk}`;

    if (this.cache.has(tool, risk, scope)) {
      this.stdout.write(
        this.style.dim(`  auto-allow: ${label} (cached for this task)\n`),
      );
      return "allow";
    }

    // Project-rule hit (ADR 0030): persistent auto-allow, gated on the LIVE
    // ask code being rule-eligible — a hand-edited rule can never cover a
    // destructive/network/reader ask, whatever the file says.
    const argv = extractArgv(request);
    // The cwd is part of the grant (audit BL15) — the same `node src/index.mjs`
    // in a different directory is a different script.
    const cwd = extractCwd(request);
    const eligible = argv !== null && isRuleEligibleAskCode(request.code);
    if (eligible && this.rules?.matches(argv, cwd) === true) {
      this.stdout.write(
        this.style.dim(`  auto-allow: project rule covers ${argv.join(" ")}\n`),
      );
      return "allow";
    }

    const showRemember = this.cache.isCacheable(tool, risk, scope);
    const derived =
      eligible && this.rules !== undefined
        ? deriveProjectCommandRule(argv)
        : null;
    const outcome = await this.inner.presentDetailed(request, signal, {
      showRemember,
      ...(derived !== null ? { projectRule: ruleDisplay(derived) } : {}),
    });
    if (outcome === "allow_remember") {
      this.cache.add(tool, risk, scope);
      return "allow";
    }
    if (outcome === "allow_project") {
      if (derived !== null) this.rules?.add({ ...derived, cwd });
      return "allow";
    }
    return outcome === "allow" ? "allow" : "deny";
  }
}

/** The call's cwd (workspace-relative, model-supplied), or undefined for the
 *  workspace root — `run_command`'s own default (audit BL15). */
function extractCwd(request: PermissionRequest): string | undefined {
  const input = request.call.input;
  if (typeof input !== "object" || input === null) return undefined;
  const cwd = (input as { cwd?: unknown }).cwd;
  return typeof cwd === "string" ? cwd : undefined;
}

/** The argv of a run_command permission request, or null for other tools /
 *  malformed input. Fail-closed: any non-string token → null. */
function extractArgv(request: PermissionRequest): string[] | null {
  // Minimal contract (ADR 0040): the bash rule's derived effective argv —
  // same shape as run_command's, same rule/cache path (mirrors app-server).
  if (request.call.tool === "bash") {
    const argv = request.argv;
    return argv !== undefined && argv.length > 0 ? [...argv] : null;
  }
  if (request.call.tool !== "run_command") return null;
  const input = request.call.input;
  if (typeof input !== "object" || input === null) return null;
  const argv = (input as { argv?: unknown }).argv;
  if (!Array.isArray(argv) || argv.length === 0) return null;
  if (!argv.every((a): a is string => typeof a === "string")) return null;
  return argv;
}
