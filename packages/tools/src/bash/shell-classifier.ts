import { isAbsolute, relative, resolve } from "node:path";
import type { RiskLevel } from "@herta/core";
import { isCredentialPath } from "../credential-denylist.js";
import {
  classifyCommand,
  classifyShellBody,
  splitShellSegments,
  type Verdict,
} from "../run-command/classifier.js";
import { findDisallowedEnvKey } from "../run-command/env-guard.js";
import type { ShellPaths } from "./shell-paths.js";

/**
 * Allow / Ask / Block for a whole shell COMMAND STRING (ADR 0040, D4).
 *
 * The argv classifier (`classifyCommand`) already knows the tiers for one
 * program; the minimal contract hands the model a shell, so a call is a
 * pipeline of programs plus shell syntax. This decomposes the string into
 * what actually runs and takes the WORST tier:
 *
 *   1. block scan of the raw body (catastrophic commands, fork bomb, nested
 *      interpreters) — `classifyShellBody`, no override;
 *   2. heredoc bodies stripped (data, not commands); `$(…)` / backtick
 *      substitutions extracted and classified as commands of their own;
 *   3. each `;` / `&&` / `||` / `|` / newline segment tokenized shell-style
 *      (quotes, escapes), leading `VAR=value` assignments removed and their
 *      KEYS put through the run_command env denylist, then:
 *        - `cd`/`pushd`: a target that leaves the workspace (absolute
 *          outside, `..`, `~`, `-`, a variable) ASKS — the persistent shell
 *          keeps relative-path reasoning honest only inside the workspace;
 *        - `source`/`.`/`eval`/`exec` ASK (they run text the classifier
 *          cannot see);
 *        - other builtins (`export`, `set`, `unset`, `alias`, `shopt`,
 *          `exit`, `true`, `:`, `[`/`test`, `printf`, `read`…) allow;
 *        - everything else → `classifyCommand(argv)` after ABSOLUTE PATHS
 *          INSIDE THE WORKSPACE are rewritten relative (the model spells
 *          `/e/repo/src/x` because that is what `pwd` printed; the reader
 *          guard would otherwise ask on every one);
 *   4. output redirections (`>`, `>>`, `>|`, `&>`) to anything but
 *      `/dev/null` ASK as workspace writes; `<` from a credential/outside
 *      path ASKS as a read.
 *
 * Aggregation: any block → block; else any ask → ONE ask carrying the
 * highest risk and the joined reasons (the user sees the whole command in
 * the prompt anyway); else allow. `code` follows the highest-risk ask so
 * ADR 0030 project rules (`command_ask_unknown` / `_interpreter`) can still
 * be derived when that is the only ask in the line.
 */
export interface ShellClassifyOpts {
  workspaceRoot: string;
  /** Path spelling of the shell (MSYS on Windows). */
  paths: ShellPaths;
  /** The shell's current cwd (native); relative paths resolve against it. */
  cwd?: string;
}

const RISK_RANK: Record<RiskLevel, number> = {
  workspace_read: 1,
  workspace_write: 2,
  network: 3,
  workspace_destructive: 4,
};

/** Builtins that only touch shell state — allowed outright. */
const STATE_BUILTINS = new Set([
  "export",
  "unset",
  "set",
  "shopt",
  "alias",
  "unalias",
  "declare",
  "typeset",
  "local",
  "readonly",
  "exit",
  "return",
  "true",
  "false",
  ":",
  "test",
  "[",
  "[[",
  "printf",
  "echo",
  "read",
  "wait",
  "jobs",
  "fg",
  "bg",
  "type",
  "command",
  "hash",
  "umask",
  "ulimit",
  "times",
  "history",
  "let",
  "getopts",
  "shift",
  "break",
  "continue",
  "pwd",
  "dirs",
  "popd",
  "trap",
  "help",
  "sleep",
]);

/** Builtins that execute text the classifier cannot see. */
const OPAQUE_BUILTINS = new Set(["source", ".", "eval", "exec"]);

/** Redirection operators (with an optional fd prefix stripped by caller). */
const OUT_REDIRECT = /^(&>>?|\d*>{1,2}\|?)$/;

export interface ShellVerdictDetail {
  verdict: Verdict;
  /** Segments actually classified (for tests / diagnostics). */
  segments: string[];
  /** For an ask: the DISTINCT ask-class codes of every asking segment,
   *  highest-risk first (the verdict's `code` is the first). A chained line
   *  is the minimal contract's normal shape, and `kill 574; curl localhost`
   *  labelled only 「该命令会访问网络」 hid the kill (permission lab
   *  2026-08-17) — the card names the rest from this. */
  codes?: string[];
}

export function classifyShellCommand(
  body: string,
  opts: ShellClassifyOpts,
): Verdict {
  return classifyShellCommandDetailed(body, opts).verdict;
}

export function classifyShellCommandDetailed(
  body: string,
  opts: ShellClassifyOpts,
): ShellVerdictDetail {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return {
      verdict: {
        kind: "block",
        code: "command_blocked",
        reason: "empty command",
      },
      segments: [],
    };
  }

  // 1. block scan on the raw body (fork bomb, catastrophic, nested wrappers)
  const blocked = classifyShellBody(trimmed);
  if (blocked.hit) {
    return {
      verdict: {
        kind: "block",
        code: "command_blocked",
        reason: blocked.reason,
      },
      segments: [],
    };
  }

  // 2. strip heredoc bodies; pull substitutions out as their own commands
  const withoutHeredocs = stripHeredocBodies(trimmed);
  const { text, inner } = extractSubstitutions(withoutHeredocs);
  const segments = [
    ...splitShellSegments(normalizeFdRedirects(text)),
    ...inner.flatMap((s) => splitShellSegments(normalizeFdRedirects(s))),
  ];

  const asks: Array<Extract<Verdict, { kind: "ask" }>> = [];
  const classified: string[] = [];
  // A `cd` INSIDE the workspace moves the cwd for the segments after it on
  // this line (`cd src/lib; cd ../../test` is fine; `cd src && cd ../..` is
  // not) — the classifier follows the shell as far as it can see.
  let cwd = opts.cwd ?? opts.workspaceRoot;
  for (const segment of segments) {
    const seg = segment.trim();
    if (seg.length === 0) continue;
    classified.push(seg);
    const r = classifySegment(seg, { ...opts, cwd });
    if (r.verdict.kind === "block")
      return { verdict: r.verdict, segments: classified };
    if (r.verdict.kind === "ask") asks.push(r.verdict);
    if (r.cwd !== undefined) cwd = r.cwd;
  }
  if (asks.length === 0)
    return { verdict: { kind: "allow" }, segments: classified };
  // Highest risk wins; reasons joined (deduped) so the prompt says it all.
  asks.sort((a, b) => RISK_RANK[b.risk] - RISK_RANK[a.risk]);
  const top = asks[0] as Extract<Verdict, { kind: "ask" }>;
  const reasons = [...new Set(asks.map((a) => a.reason))];
  const codes = [...new Set(asks.map((a) => a.code))];
  return {
    verdict: {
      kind: "ask",
      risk: top.risk,
      code: top.code,
      reason: reasons.join("; "),
    },
    segments: classified,
    codes,
  };
}

/**
 * The single program a command line really runs, as argv — or null.
 *
 * Feeds the approval cache and ADR 0030 project rules for `bash` the way
 * run_command's argv does. Deliberately narrow (fail-closed): after dropping
 * leading `cd`/`pushd` segments whose target is the WORKSPACE ROOT itself
 * (the model's habit; a cd into a subdirectory would change what a
 * cwd-scoped rule means, so it disqualifies), exactly ONE segment may
 * remain, with no command substitution, no redirect that leaves the
 * workspace, and a non-empty argv. In-workspace absolute paths are
 * relativized so the argv is the one a run_command call would carry.
 */
export function singleProgramArgv(
  body: string,
  opts: ShellClassifyOpts,
): string[] | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  const { text, inner } = extractSubstitutions(stripHeredocBodies(trimmed));
  if (inner.length > 0) return null;
  const segments = splitShellSegments(normalizeFdRedirects(text))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const root = resolve(opts.workspaceRoot);
  let i = 0;
  while (i < segments.length) {
    const seg = (segments[i] as string).replace(/^[({\s]+/, "");
    const { words } = tokenize(seg);
    const name = words[0]?.toLowerCase();
    if ((name === "cd" || name === "pushd") && words.length === 2) {
      const dest = destinationOf(words[1] as string, { ...opts, cwd: root });
      if (dest !== null && resolve(dest) === root) {
        i += 1;
        continue;
      }
    }
    break;
  }
  const rest = segments.slice(i);
  if (rest.length !== 1) return null;
  const seg = (rest[0] as string)
    .replace(/^[({\s]+/, "")
    .replace(/[)}\s]+$/, "");
  const { words, redirects } = tokenize(seg);
  for (const r of redirects) {
    if (r.kind === "out" && isDevNull(r.target)) continue;
    if (leavesWorkspace(r.target, { ...opts, cwd: root })) return null;
  }
  if (words.length === 0) return null;
  if (PREFIX_KEYWORDS.has(words[0] as string)) return null;
  return words.map((w, idx) =>
    idx === 0 ? w : relativizeInsideWorkspace(w, { ...opts, cwd: root }),
  );
}

/** Allow-listed readers and shell builtins that never make a line a
 *  DIFFERENT program for cache-scoping purposes: `git add && git commit &&
 *  echo done && git status` is a "git" line. (Their own asks, if any, are
 *  workspace_read and the cache only remembers workspace_write — a
 *  remembered "git" can never cover them.) */
let scopeNoiseSet: Set<string> | null = null;
function scopeNoise(): Set<string> {
  // Lazy: PREFIX_KEYWORDS / STANDALONE_KEYWORDS are declared further down
  // (module init order), and this is only consulted at call time.
  scopeNoiseSet ??= new Set([
    ...STATE_BUILTINS,
    ...PREFIX_KEYWORDS,
    ...STANDALONE_KEYWORDS,
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "grep",
    "rg",
    "find",
    "date",
    "whoami",
    "cd",
    "pushd",
  ]);
  return scopeNoiseSet;
}

/**
 * The distinct program identities a command line runs — for the approval
 * cache's scope only (ADR 0040; see `permissionCacheScope`). Null when the
 * line cannot be characterized: command substitution, or an output redirect
 * that leaves the workspace. Readers/builtins are noise (see SCOPE_NOISE);
 * a `cd` anywhere is fine here (the task cache, like run_command's argv[0]
 * scope, is cwd-independent) — rules use `singleProgramArgv` instead.
 */
export function effectivePrograms(
  body: string,
  opts: ShellClassifyOpts,
): string[] | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  const { text, inner } = extractSubstitutions(stripHeredocBodies(trimmed));
  if (inner.length > 0) return null;
  const programs: string[] = [];
  const root = resolve(opts.workspaceRoot);
  for (const raw of splitShellSegments(normalizeFdRedirects(text))) {
    const seg = raw
      .replace(/^[({\s]+/, "")
      .replace(/[)}\s]+$/, "")
      .trim();
    if (seg.length === 0) continue;
    const { words, redirects } = tokenize(seg);
    for (const r of redirects) {
      if (r.kind === "out" && isDevNull(r.target)) continue;
      if (leavesWorkspace(r.target, { ...opts, cwd: root })) return null;
    }
    let ws = words;
    while (ws.length > 0 && PREFIX_KEYWORDS.has(ws[0] as string))
      ws = ws.slice(1);
    const a0 = ws[0];
    if (a0 === undefined) continue;
    const name =
      a0
        .split(/[\\/]/)
        .pop()
        ?.toLowerCase()
        .replace(/\.exe$/, "") ?? a0;
    if (scopeNoise().has(name)) continue;
    if (!programs.includes(a0)) programs.push(a0);
  }
  return programs;
}

// ───────────────────────── segment classification ─────────────────────────

/** Control-flow words that PREFIX a command (`if cmd`, `while ! cmd`,
 *  `time cmd`, `{ cmd`) — skipped so the command behind them classifies. */
const PREFIX_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "time",
  "{",
  "}",
]);
/** Control-flow words that ARE the whole segment (or head an iteration
 *  header) — no program runs from them; their bodies are separate segments. */
const STANDALONE_KEYWORDS = new Set([
  "fi",
  "done",
  "esac",
  "for",
  "select",
  "case",
  "in",
  "function",
]);

interface SegmentVerdict {
  verdict: Verdict;
  /** New cwd for later segments when this one was an in-workspace `cd`. */
  cwd?: string;
}

/** The env-key rule is run_command's ALLOW-list (fail closed): a key that
 *  is not on it asks — the user sees `FOO=bar cmd` and decides. */
function envAsk(verb: string, key: string): Extract<Verdict, { kind: "ask" }> {
  return {
    kind: "ask",
    risk: "workspace_write",
    code: "command_ask_env",
    reason: `${verb} the environment variable ${key} (not on the run_command env allow-list — review it)`,
  };
}

function classifySegment(
  rawSeg: string,
  opts: ShellClassifyOpts,
): SegmentVerdict {
  // subshell / group punctuation glued to the segment: `(cd x`, `ls)`
  const seg = rawSeg
    .replace(/^[({\s]+/, "")
    .replace(/[)}\s]+$/, "")
    .trim();
  if (seg.length === 0) return { verdict: { kind: "allow" } };
  const tokenized = tokenize(seg);
  let { words } = tokenized;
  const { assignments, redirects } = tokenized;
  while (words.length > 0 && PREFIX_KEYWORDS.has(words[0] as string)) {
    words = words.slice(1);
  }
  if (words.length > 0 && STANDALONE_KEYWORDS.has(words[0] as string)) {
    return { verdict: { kind: "allow" } };
  }
  // `case x in pattern) cmd ;;` — the pattern label rides the command word
  if (words.length > 0 && /\)$/.test(words[0] as string) && words.length > 1) {
    words = words.slice(1);
  }

  const asks: Array<Extract<Verdict, { kind: "ask" }>> = [];
  // env assignments (prefix `K=V …` or bare `K=V`)
  if (assignments.length > 0) {
    const env: Record<string, string> = {};
    for (const a of assignments) env[a.key] = a.value;
    const bad = findDisallowedEnvKey(env);
    if (bad !== null) asks.push(envAsk("sets", bad));
  }
  // redirections
  for (const r of redirects) {
    if (r.kind === "out") {
      if (isDevNull(r.target)) continue;
      const outside = leavesWorkspace(r.target, opts);
      asks.push({
        kind: "ask",
        risk: "workspace_write",
        code: "command_ask_write",
        reason: outside
          ? `redirects output outside the workspace: ${r.target}`
          : `redirects output to ${r.target}`,
      });
    } else if (r.kind === "in") {
      if (leavesWorkspace(r.target, opts) || isCredentialPath(r.target)) {
        asks.push({
          kind: "ask",
          risk: "workspace_read",
          code: "command_ask_reader_path",
          reason: `reads a sensitive or out-of-workspace path: ${r.target}`,
        });
      }
    }
  }

  if (words.length === 0) {
    // bare assignment or bare redirect
    return { verdict: combine(asks) };
  }
  const a0 = words[0] as string;
  const name =
    a0
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, "") ?? a0;

  // `export K=V` also goes through the env allow-list
  if (name === "export" || name === "declare" || name === "typeset") {
    const env: Record<string, string> = {};
    for (const w of words.slice(1)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w);
      if (m) env[m[1] as string] = m[2] as string;
    }
    const bad = Object.keys(env).length > 0 ? findDisallowedEnvKey(env) : null;
    if (bad !== null) asks.push(envAsk("exports", bad));
    return { verdict: combine(asks) };
  }

  if (name === "cd" || name === "pushd") {
    const target = words[1];
    if (
      target === undefined ||
      target === "~" ||
      target === "-" ||
      target.startsWith("~/") ||
      /[$`]/.test(target)
    ) {
      asks.push(cdAsk(target ?? "(home)"));
      return { verdict: combine(asks) };
    }
    const dest = destinationOf(target, opts);
    if (dest === null) {
      asks.push(cdAsk(target));
      return { verdict: combine(asks) };
    }
    return { verdict: combine(asks), cwd: dest };
  }

  if (OPAQUE_BUILTINS.has(name)) {
    asks.push({
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_interpreter",
      reason: `${name} runs text the harness cannot classify — review it`,
    });
    return { verdict: combine(asks) };
  }

  if (STATE_BUILTINS.has(name)) return { verdict: combine(asks) };

  // Everything else: the argv classifier, with in-workspace absolute paths
  // rewritten relative so `cat /e/repo/src/x` classifies as `cat src/x`.
  const argv = words.map((w, i) =>
    i === 0 ? w : relativizeInsideWorkspace(w, opts),
  );
  const v = classifyCommand(argv);
  if (v.kind === "block") return { verdict: v };
  if (v.kind === "ask") asks.push(v);
  return { verdict: combine(asks) };
}

/** Native path a `cd` target lands on when it stays inside the workspace;
 *  null when it leaves (or cannot be resolved as a path). */
function destinationOf(token: string, opts: ShellClassifyOpts): string | null {
  const t = token.replace(/^["']|["']$/g, "");
  const native = opts.paths.toNative(t);
  if (native !== null)
    return isInside(opts.workspaceRoot, native) ? native : null;
  if (/^[\\/]/.test(t)) return null;
  const resolved = resolveNative(opts.cwd ?? opts.workspaceRoot, t);
  return isInside(opts.workspaceRoot, resolved) ? resolved : null;
}

/** A `cd` that leaves the workspace. WRITE risk and its own class
 *  (2026-08-17): the classifier cannot follow relative paths after it, so
 *  everything later on the line may read OR write outside the workspace —
 *  the permission lab saw `cd .. && cp -r ws ws-copy` labelled by its `cp`
 *  ("filesystem operation") with the escape only in the raw reason. As a
 *  write-tier ask it competes for the top label and reads as what it is. */
function cdAsk(target: string): Extract<Verdict, { kind: "ask" }> {
  return {
    kind: "ask",
    risk: "workspace_write",
    code: "command_ask_cwd_escape",
    reason: `cd leaves the workspace: ${target} — later relative paths would resolve outside it`,
  };
}

function combine(asks: Array<Extract<Verdict, { kind: "ask" }>>): Verdict {
  if (asks.length === 0) return { kind: "allow" };
  asks.sort((a, b) => RISK_RANK[b.risk] - RISK_RANK[a.risk]);
  const top = asks[0] as Extract<Verdict, { kind: "ask" }>;
  return {
    kind: "ask",
    risk: top.risk,
    code: top.code,
    reason: [...new Set(asks.map((a) => a.reason))].join("; "),
  };
}

// ───────────────────────── path helpers ─────────────────────────

function isDevNull(target: string): boolean {
  return target === "/dev/null" || target === "NUL" || target === "nul";
}

/** True when a path token resolves outside the workspace (absolute outside,
 *  `..` escape, `~`); relative paths resolve against the shell cwd. */
function leavesWorkspace(token: string, opts: ShellClassifyOpts): boolean {
  const t = token.replace(/^["']|["']$/g, "");
  if (t.startsWith("~")) return true;
  if (/[$`]/.test(t)) return false; // variables: unknowable, not a path claim
  const native = opts.paths.toNative(t);
  if (native !== null) return !isInside(opts.workspaceRoot, native);
  if (/^[\\/]/.test(t)) return true; // some other absolute spelling
  const base = opts.cwd ?? opts.workspaceRoot;
  const resolved = resolveNative(base, t);
  return !isInside(opts.workspaceRoot, resolved);
}

/**
 * A path token as the WORKSPACE sees it: `{ native, relative }` when the
 * token (shell or native spelling, or relative to the shell cwd) resolves to
 * a location inside the workspace; null when it leaves it, is `~`, carries
 * a variable/substitution, or is not a path claim at all. Shared by the
 * heredoc-write preview (bash/heredoc-write.ts), which needs the same
 * answer the redirect classifier gives.
 */
export function resolveWorkspacePath(
  token: string,
  opts: ShellClassifyOpts,
): { native: string; relative: string } | null {
  const t = token.replace(/^["']|["']$/g, "");
  if (t.length === 0 || t.startsWith("~") || /[$`]/.test(t)) return null;
  const nativeAbs = opts.paths.toNative(t);
  const native =
    nativeAbs ??
    (/^[\\/]/.test(t)
      ? null
      : resolveNative(opts.cwd ?? opts.workspaceRoot, t));
  if (native === null || !isInside(opts.workspaceRoot, native)) return null;
  const rel = relativePath(opts.workspaceRoot, native);
  return { native, relative: rel === "" ? "." : rel };
}

/** `/e/repo/src/x` (or `E:\repo\src\x`) → `src/x` when inside the workspace;
 *  otherwise the token unchanged (so the argv classifier's own guards see
 *  the absolute form and ask). */
function relativizeInsideWorkspace(
  token: string,
  opts: ShellClassifyOpts,
): string {
  const native = opts.paths.toNative(token);
  if (native === null) return token;
  if (!isInside(opts.workspaceRoot, native)) return token;
  const rel = relativePath(opts.workspaceRoot, native);
  return rel === "" ? "." : rel;
}

function isInside(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function resolveNative(base: string, p: string): string {
  return resolve(base, p);
}
function relativePath(root: string, p: string): string {
  return relative(resolve(root), resolve(p)).split("\\").join("/");
}

// ───────────────────────── lexical helpers ─────────────────────────

/** Remove heredoc BODIES (`<<WORD` … `WORD`), keep the command lines. */
export function stripHeredocBodies(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let terminator: string | null = null;
  let stripTabs = false;
  for (const line of lines) {
    if (terminator !== null) {
      const probe = stripTabs ? line.replace(/^\t+/, "") : line;
      if (probe === terminator) terminator = null;
      continue;
    }
    out.push(line);
    const m =
      /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
    if (m) {
      stripTabs = m[1] === "-";
      terminator = (m[2] ?? m[3] ?? m[4]) as string;
    }
  }
  return out.join("\n");
}

/** Pull `$( … )` and backtick substitutions out (nesting-aware); the text
 *  keeps a placeholder so the outer command still classifies. */
export function extractSubstitutions(body: string): {
  text: string;
  inner: string[];
} {
  const inner: string[] = [];
  let text = "";
  let i = 0;
  let quote: "'" | '"' | null = null;
  while (i < body.length) {
    const ch = body[i] as string;
    const prev = i > 0 ? body[i - 1] : "";
    if (quote === "'") {
      text += ch;
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" && quote === null && prev !== "\\") {
      quote = "'";
      text += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && prev !== "\\") {
      quote = quote === '"' ? null : '"';
      text += ch;
      i += 1;
      continue;
    }
    if (ch === "$" && body[i + 1] === "(" && prev !== "\\") {
      // find the matching paren, nesting-aware
      let depth = 0;
      let j = i + 1;
      for (; j < body.length; j += 1) {
        const c = body[j];
        if (c === "(") depth += 1;
        else if (c === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const content = body.slice(i + 2, j);
      const nested = extractSubstitutions(content);
      inner.push(nested.text, ...nested.inner);
      text += "__SUBST__";
      i = j + 1;
      continue;
    }
    if (ch === "`" && prev !== "\\") {
      const j = body.indexOf("`", i + 1);
      if (j === -1) {
        text += ch;
        i += 1;
        continue;
      }
      inner.push(body.slice(i + 1, j));
      text += "__SUBST__";
      i = j + 1;
      continue;
    }
    text += ch;
    i += 1;
  }
  return { text, inner: inner.filter((s) => s.trim().length > 0) };
}

/** `2>&1`, `>&2`, `1>&2` are fd duplications, not writes; blank them so the
 *  segment splitter's `&` does not cut the line and the redirect scan does
 *  not read a target from them. */
export function normalizeFdRedirects(text: string): string {
  return text.replace(/\d*>&\d+/g, " ").replace(/&>\s*\/dev\/null/g, " ");
}

export interface Tokenized {
  words: string[];
  assignments: Array<{ key: string; value: string }>;
  redirects: Array<{ kind: "out" | "in"; target: string }>;
}

/** Shell-style word split of ONE simple command: quotes and backslash
 *  escapes honoured, leading `K=V` assignments separated, redirections
 *  pulled out with their targets. */
export function tokenize(segment: string): Tokenized {
  const raw: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  const s = segment.trim();
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      has = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (
        ch === "\\" &&
        i + 1 < s.length &&
        /["\\$`]/.test(s[i + 1] as string)
      ) {
        cur += s[i + 1];
        i += 1;
      } else cur += ch;
      has = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      cur += s[i + 1];
      has = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        raw.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    // split redirection operators glued to words: `>file`, `2>>x`, `<in`
    if (ch === ">" || ch === "<" || (ch === "&" && s[i + 1] === ">")) {
      // flush a preceding word unless it is a bare fd number
      if (has && !/^\d+$/.test(cur)) {
        raw.push(cur);
        cur = "";
        has = false;
      }
      let op = has ? cur : ""; // fd prefix
      cur = "";
      has = false;
      op += ch;
      if (ch === "&") {
        op += ">";
        i += 1;
      }
      if (s[i + 1] === ">" || (ch === "<" && s[i + 1] === "<")) {
        op += s[i + 1];
        i += 1;
        if (s[i + 1] === "<") {
          op += "<";
          i += 1;
        }
      }
      if (s[i + 1] === "|") {
        op += "|";
        i += 1;
      }
      raw.push(op);
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) raw.push(cur);

  const words: string[] = [];
  const assignments: Tokenized["assignments"] = [];
  const redirects: Tokenized["redirects"] = [];
  let leading = true;
  for (let i = 0; i < raw.length; i += 1) {
    const w = raw[i] as string;
    if (OUT_REDIRECT.test(w)) {
      const target = raw[i + 1];
      if (target !== undefined) redirects.push({ kind: "out", target });
      i += 1;
      leading = false;
      continue;
    }
    if (/^\d*<$/.test(w)) {
      const target = raw[i + 1];
      if (target !== undefined) redirects.push({ kind: "in", target });
      i += 1;
      leading = false;
      continue;
    }
    if (/^\d*<<-?$/.test(w) || w === "<<<") {
      // heredoc terminator word / here-string: data, not a path
      i += 1;
      leading = false;
      continue;
    }
    if (leading) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w);
      if (m) {
        assignments.push({ key: m[1] as string, value: m[2] as string });
        continue;
      }
      leading = false;
    }
    words.push(w);
  }
  return { words, assignments, redirects };
}
