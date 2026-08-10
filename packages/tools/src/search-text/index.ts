import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type {
  HertaTool,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import { resolveSafePath } from "../path-safety.js";
import { redactSecrets } from "../run-command/redactor.js";
import { walkDir } from "../walker.js";
import { hasCatastrophicQuantifier } from "./redos-guard.js";
import { detectRg, type RgFindings, runRgFinder } from "./rg-engine.js";
import { searchTextInputSchema, searchTextJsonSchema } from "./schema.js";

const MAX_FILE_BYTES = 1 * 1024 * 1024;
const SNIFF_BYTES = 4096;

/** The attachment subtree (ADR 0033). A search rooted here gets two special
 *  behaviors, both found in the 2026-08-10 review of the carve-out:
 *
 *  1. The JS engine, always. rg's arg list mirrors SKIP_DIR_NAMES as
 *     `-g !.herta/**` and rg respects the BL6 `.herta/.gitignore` (`*`), so an
 *     rg-backed search into this subtree returned ZERO candidates while the JS
 *     scanner found matches — silent engine divergence, the exact failure the
 *     slice-3 design ("results are engine-independent") forbids. Attachment
 *     dirs hold at most a handful of files, so the JS scanner's performance
 *     is a non-issue; skipping rg makes the equivalence structural.
 *  2. A lifted per-file cap. The 1 MiB scan cap exists to bound a
 *     whole-workspace walk, but the files this carve-out exists FOR are the
 *     over-2MB ones the ingest stored WITHOUT an excerpt on the promise that
 *     they stay searchable — a promise the cap silently broke for both
 *     engines (rg carries its own `--max-filesize=1048576`). An explicit
 *     search into the attachment dir reads one file of at most the storage
 *     ceiling; `ATTACHMENT_SEARCH_MAX_BYTES` must equal that ceiling, and an
 *     app-server test pins the two together.
 */
const ATTACHMENT_PREFIX = ".herta/attachments/";
export const ATTACHMENT_SEARCH_MAX_BYTES = 64 * 1024 * 1024;

/** Whether a canonical workspace-relative search root is inside the
 *  attachment subtree. Exported for the lockstep test. */
export function isAttachmentSearchRoot(rel: string): boolean {
  return rel.startsWith(ATTACHMENT_PREFIX);
}
/** Wall-clock budget for one search (audit 2026-07-13 T2.3): the backstop
 *  for slow-but-not-rejected patterns — polynomial backtracking, huge trees.
 *  Checked between lines; on expiry the scan stops and returns what it has
 *  as a truncated result. */
const SCAN_DEADLINE_MS = 10_000;
/** Cap on how much of ONE line a `.test()` sees. A 1MB single-line file is
 *  under the file-size gate, and a polynomial pattern over a line that long
 *  blocks the event loop in a single uninterruptible call; capping the
 *  probe bounds the worst case to roughly a second. Matches beyond the cap
 *  in minified one-liners are lost — acceptable for a code-search tool. */
const LINE_TEST_CAP = 32 * 1024;

export interface SearchMatch {
  path: string;
  line: number;
  content: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface SearchTextData {
  matches: SearchMatch[];
  truncated: boolean;
}

export interface SearchTextToolOpts {
  /**
   * "auto" (default): use ripgrep as a fast candidate finder when a `rg`
   * binary is on PATH, falling back to the JS scanner when it is absent
   * or rejects the pattern dialect. "js": always the JS scanner
   * (also forced by env HERTA_SEARCH_ENGINE=js). ADR 0025 slice 3.
   */
  engine?: "auto" | "js";
}

interface ScanOutcome {
  matches: SearchMatch[];
  truncated: boolean;
  timedOut: boolean;
}

/** Load + redact + split a file for line verification; null → skip file
 *  (unsafe path, unreadable, too large, or binary). One loader per run,
 *  caching per path, so rg-candidate verification reads each file once. */
function makeFileLoader(
  ctx: ToolContext,
): (relPath: string) => Promise<string[] | null> {
  const cache = new Map<string, string[] | null>();
  return async (relPath: string): Promise<string[] | null> => {
    const hit = cache.get(relPath);
    if (hit !== undefined) return hit;
    const out = await (async (): Promise<string[] | null> => {
      // Per-file gate (2026-07-10 audit, finding 1): realpaths the entry
      // (closing symlink escapes) and applies the credential denylist;
      // denied files are skipped like unreadable ones.
      // allowAttachmentPaths must match the root gate below, or an explicit
      // search INTO the attachments dir would pass the root check and then
      // silently skip every file it walked.
      const safeEntry = await resolveSafePath(ctx.workspaceRoot, relPath, {
        allowAttachmentPaths: true,
      });
      if (!safeEntry.ok) return null;
      let fileInfo: Stats;
      try {
        fileInfo = await stat(safeEntry.resolved);
      } catch {
        return null;
      }
      // Attachments get the lifted cap — the stored-without-excerpt files are
      // over the 1 MiB scan cap BY DEFINITION (that is why they had no
      // excerpt), and the searchable promise is the reason they were stored.
      const cap = relPath.startsWith(ATTACHMENT_PREFIX)
        ? ATTACHMENT_SEARCH_MAX_BYTES
        : MAX_FILE_BYTES;
      if (fileInfo.size > cap) return null;
      let buf: Buffer;
      try {
        buf = await readFile(safeEntry.resolved);
      } catch {
        return null;
      }
      const sniff = buf.subarray(0, Math.min(SNIFF_BYTES, buf.length));
      if (sniff.includes(0)) return null;
      let text = buf.toString("utf-8");
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      // Redact BEFORE matching, not after: redacting only the returned
      // content would leave a probe oracle (search for a secret's prefix,
      // extend one character per call, read the match count). Match lines
      // and context lines both come from the redacted text.
      return redactSecrets(text).split("\n");
    })();
    cache.set(relPath, out);
    return out;
  };
}

function probeLine(regex: RegExp, lineContent: string): boolean {
  const probe =
    lineContent.length > LINE_TEST_CAP
      ? lineContent.slice(0, LINE_TEST_CAP)
      : lineContent;
  return regex.test(probe);
}

function buildMatch(
  relPath: string,
  lines: string[],
  lineIdx: number,
  contextLines: number,
): SearchMatch {
  const m: SearchMatch = {
    path: relPath,
    line: lineIdx + 1,
    content: lines[lineIdx] ?? "",
  };
  if (contextLines > 0) {
    const beforeStart = Math.max(0, lineIdx - contextLines);
    const afterEnd = Math.min(lines.length, lineIdx + 1 + contextLines);
    m.contextBefore = lines.slice(beforeStart, lineIdx);
    m.contextAfter = lines.slice(lineIdx + 1, afterEnd);
  }
  return m;
}

/** Verify rg candidates through the SAME pipeline the JS scanner uses —
 *  redacted lines, JS-regex probe, context slicing — so nothing rg read
 *  can surface unvetted and the result shape is engine-independent. */
async function verifyRgCandidates(opts: {
  findings: RgFindings;
  regex: RegExp;
  contextLines: number;
  maxMatches: number;
  deadline: number;
  ctx: ToolContext;
}): Promise<ScanOutcome> {
  const { findings, regex, contextLines, maxMatches, deadline, ctx } = opts;
  const load = makeFileLoader(ctx);
  const matches: SearchMatch[] = [];
  let truncated = findings.capped || findings.timedOut;
  let timedOut = findings.timedOut;
  const seen = new Set<string>();

  for (const cand of findings.candidates) {
    ctx.signal.throwIfAborted();
    if (Date.now() > deadline) {
      timedOut = true;
      truncated = true;
      break;
    }
    const key = `${cand.relPath}\n${cand.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lines = await load(cand.relPath);
    if (lines === null) continue;
    const idx = cand.line - 1;
    if (idx < 0 || idx >= lines.length) continue;
    if (!probeLine(regex, lines[idx] ?? "")) continue;
    matches.push(buildMatch(cand.relPath, lines, idx, contextLines));
    if (matches.length >= maxMatches) {
      if (matches.length < findings.candidates.length) truncated = true;
      break;
    }
  }
  return { matches, truncated, timedOut };
}

/** The original walk-everything JS scanner — the fallback engine and the
 *  behavior baseline the rg path must agree with. */
async function searchWithJs(opts: {
  regex: RegExp;
  resolvedRoot: string;
  contextLines: number;
  maxMatches: number;
  deadline: number;
  ctx: ToolContext;
}): Promise<ScanOutcome> {
  const { regex, resolvedRoot, contextLines, maxMatches, deadline, ctx } = opts;
  const load = makeFileLoader(ctx);
  const matches: SearchMatch[] = [];
  let truncated = false;
  let timedOut = false;

  // ctx.signal threads into the walk AND gates each file scan (audit M4):
  // pre-fix this loop was unabortable — a Ctrl-C mid-search over a large
  // tree only bit at the NEXT provider call. The AbortError propagates to
  // the turn loop, which classifies it as `interrupted`.
  for await (const entry of walkDir(ctx.workspaceRoot, resolvedRoot, {
    recursive: true,
    signal: ctx.signal,
  })) {
    if (entry.type !== "file") continue;
    if (truncated) break;
    ctx.signal.throwIfAborted();

    const lines = await load(entry.path);
    if (lines === null) continue;

    for (let i = 0; i < lines.length; i++) {
      // Per-LINE abort + budget (audit 2026-07-13 T2.3): the per-file
      // check above left a many-line file scan uninterruptible, and a
      // slow pattern could run unbounded across the tree.
      ctx.signal.throwIfAborted();
      if (Date.now() > deadline) {
        timedOut = true;
        truncated = true;
        break;
      }
      if (probeLine(regex, lines[i] ?? "")) {
        matches.push(buildMatch(entry.path, lines, i, contextLines));
        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }
      }
    }
  }
  return { matches, truncated, timedOut };
}

export function searchTextTool(opts: SearchTextToolOpts = {}): HertaTool {
  return {
    name: "search_text",
    readOnly: true,
    schema(): ToolSchema {
      return {
        name: "search_text",
        description:
          "Search workspace files for a JS RegExp pattern. Returns matches sorted by path then line. Skips binary files (NUL byte sniff) and files >1MB. Uses ripgrep when available (respects .gitignore); falls back to a JS scanner.",
        inputSchema: searchTextJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<SearchTextData>> {
      const parsed = searchTextInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: formatInputIssues(parsed.error),
            retryable: false,
          },
          suggestion:
            "usage: {pattern, path?, caseSensitive?, contextLines?, maxMatches?}",
          summary: "invalid input",
        };
      }
      const {
        pattern,
        path = ".",
        caseSensitive = true,
        contextLines = 0,
        maxMatches = 100,
      } = parsed.data;

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, caseSensitive ? "" : "i");
      } catch (err: unknown) {
        return {
          ok: false,
          error: {
            code: "invalid_pattern",
            message: (err as Error).message ?? "bad regex",
            retryable: false,
          },
          summary: "invalid pattern",
        };
      }
      // ReDoS gate (audit 2026-07-13 T2.3): the pattern is model-supplied,
      // and one catastrophic `.test()` blocks the event loop beyond any
      // abort. Rejected up front so the model rewrites the pattern. Applied
      // to BOTH engines: even with rg (linear Rust regex) as the finder,
      // candidate verification probes lines with the JS regex.
      if (hasCatastrophicQuantifier(pattern)) {
        return {
          ok: false,
          error: {
            code: "invalid_pattern",
            message:
              "pattern rejected: quantified group inside an unbounded quantifier " +
              "(catastrophic backtracking risk) — rewrite without nesting " +
              "quantifiers, e.g. use [^x]+ character classes instead",
            retryable: false,
          },
          summary: "invalid pattern",
        };
      }

      // allowAttachmentPaths (ADR 0033, amended 2026-08-10): a document the
      // 开拓者 attached is stored but may be too large or too binary for a
      // head excerpt, and both the ADR and the backend's own citation line
      // told 板砖 it could still SEARCH such a file. That was false until
      // here — search_text took the ordinary guard, so `.herta` denied it,
      // and the promise could not be kept. Reaching an attachment still
      // requires pointing `path` AT it: the walker skips any `.herta`
      // directory it meets, so a workspace-root search never descends here.
      const safe = await resolveSafePath(ctx.workspaceRoot, path, {
        allowAttachmentPaths: true,
      });
      if (!safe.ok) {
        return {
          ok: false,
          error: { code: safe.code, message: safe.message, retryable: false },
          summary: `denied: ${safe.message}`,
        };
      }

      let info: Stats;
      try {
        info = await stat(safe.resolved);
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === "ENOENT") {
          return {
            ok: false,
            error: {
              code: "not_found",
              message: `not found: ${safe.relative || path}`,
              retryable: false,
            },
            summary: `not found: ${safe.relative || path}`,
          };
        }
        return {
          ok: false,
          error: {
            code: "read_failed",
            message: (err as Error).message ?? "stat failed",
            retryable: false,
          },
          summary: "read failed",
        };
      }

      if (!info.isDirectory()) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: `not a directory: ${safe.relative || path}`,
            retryable: false,
          },
          summary: "not a directory",
        };
      }

      const deadline = Date.now() + SCAN_DEADLINE_MS;

      // Engine selection (ADR 0025 slice 3): rg as fast finder when
      // available; JS scanner as baseline/fallback. null from the finder
      // (no binary, pattern dialect rejected, spawn failure) falls through.
      let outcome: ScanOutcome | null = null;
      const engine =
        process.env.HERTA_SEARCH_ENGINE === "js" ||
        isAttachmentSearchRoot(safe.relative)
          ? "js"
          : (opts.engine ?? "auto");
      if (engine === "auto") {
        const rgBin = await detectRg();
        if (rgBin !== null) {
          const findings = await runRgFinder({
            rgBin,
            pattern,
            caseSensitive,
            relRoot: safe.relative,
            workspaceRoot: ctx.workspaceRoot,
            candidateCap: maxMatches * 2 + 50,
            deadlineMs: deadline,
            signal: ctx.signal,
          });
          ctx.signal.throwIfAborted();
          if (findings !== null) {
            outcome = await verifyRgCandidates({
              findings,
              regex,
              contextLines,
              maxMatches,
              deadline,
              ctx,
            });
          }
        }
      }
      if (outcome === null) {
        outcome = await searchWithJs({
          regex,
          resolvedRoot: safe.resolved,
          contextLines,
          maxMatches,
          deadline,
          ctx,
        });
      }
      const { matches, truncated, timedOut } = outcome;

      matches.sort((a, b) => {
        if (a.path !== b.path) return a.path < b.path ? -1 : 1;
        return a.line - b.line;
      });

      const fileCount = new Set(matches.map((m) => m.path)).size;
      const flags = caseSensitive ? "" : "i";
      const summary = timedOut
        ? `found ${matches.length} matches (stopped at the ${SCAN_DEADLINE_MS / 1000}s scan budget; narrow scope or simplify the pattern) for /${pattern}/${flags}`
        : truncated
          ? `found ${matches.length} matches (truncated; narrow scope) for /${pattern}/${flags}`
          : matches.length === 0
            ? `found 0 matches for /${pattern}/${flags}`
            : `found ${matches.length} matches in ${fileCount} files for /${pattern}/${flags}`;

      return { ok: true, data: { matches, truncated }, summary };
    },
  };
}
