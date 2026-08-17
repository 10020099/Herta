import { type RiskLevel, SCRIPT_INTERPRETERS } from "@herta/core";
import { isCredentialPath } from "../credential-denylist.js";

export type Verdict =
  | { kind: "allow" }
  | { kind: "ask"; risk: RiskLevel; reason: string; code: string }
  | { kind: "block"; reason: string; code: "command_blocked" };

const ROOT_PATHS = new Set(["/", "//", "/*"]);
const HOME_PATHS = new Set(["~", "~/", "~/*"]);

/** System-root-ish paths across platforms. Windows shells name roots as
 *  `C:\` / `C:/` / bare `\`, never `/` — the decoded shell bodies below hand
 *  these to the catastrophic check, so the POSIX-only set was a blind spot. */
function isSystemRootPath(a: string): boolean {
  if (ROOT_PATHS.has(a) || HOME_PATHS.has(a)) return true;
  if (/^[A-Za-z]:[\\/]?\*?$/.test(a)) return true;
  return a === "\\" || a === "\\*" || a === "\\\\";
}

function hasRecursiveForce(argv: readonly string[]): boolean {
  for (const a of argv) {
    if (a === "-rf" || a === "-fr" || a === "-Rf" || a === "-fR") return true;
  }
  let r = false;
  let f = false;
  for (const a of argv) {
    if (a === "-r" || a === "-R" || a === "--recursive") r = true;
    if (a === "-f" || a === "--force") f = true;
  }
  return r && f;
}

function shellBodyTokens(body: string): string[] {
  return body
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^["']+|["']+$/g, ""))
    .filter((t) => t.length > 0);
}

/** Escape-hatch guard for allow-listed read-only commands: their ARGUMENTS
 *  took no path check at all, so absolute/parent-escaping paths and
 *  credential files rode the auto-allow. Returns an `ask` verdict when an
 *  arg looks like it leaves the workspace or names credential material
 *  (via the shared credential denylist — same set read_file enforces,
 *  now segment-aware so `cat .ssh/config` is caught); null → the caller's
 *  allow stands. Deliberately shallow (no fs access — the classifier is
 *  synchronous and cwd-relative args stay allowed). The fs-based half — an
 *  innocent-basename symlink whose realpath leaves the repo — is caught by
 *  the async checkReaderArgvPaths (reader-guard.ts) in the rule/tool, which
 *  the classifier structurally cannot see (audit T3.4). */
function readerArgvGuard(argv: readonly string[]): Verdict | null {
  for (const a of argv.slice(1)) {
    if (a.startsWith("-")) continue; // flags
    // Match a Windows drive prefix WITH OR WITHOUT a separator: `E:.env` is
    // DRIVE-RELATIVE (resolves against drive E's cwd, i.e. the workspace) yet
    // has no separator, so it slipped the old `X:[\/]` form and read a
    // workspace credential unprompted (audit T3.4 review).
    const absolute = /^([A-Za-z]:|[\\/]|~)/.test(a);
    const parentEscape = a === ".." || a.includes("../") || a.includes("..\\");
    if (absolute || parentEscape || isCredentialPath(a)) {
      return {
        kind: "ask",
        risk: "workspace_read",
        code: "command_ask_reader_path",
        reason: `read-only command targets a sensitive or out-of-workspace path: ${a}`,
      };
    }
  }
  return null;
}

/** Allow-listed readers that take FILE-PATH operands (content or listing
 *  disclosure). Excludes echo/pwd/date/whoami/true/false, whose args are not
 *  read targets — realpath-checking them would false-deny e.g.
 *  `echo /etc/hostname`. Consumed by readerPathCandidates. */
const PATH_READER_CMDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "ripgrep",
  "find",
]);

/** The non-flag path operands of a file-reading allow-listed command, or null
 *  when argv[0] is not such a command. The async reader guard realpaths each
 *  candidate that ACTUALLY EXISTS and denies any whose real target leaves the
 *  workspace or names credential material — so grep/find PATTERN operands
 *  (which don't resolve to files) are skipped and never cause a false deny.
 *  Tokens after `--` are operands even if they start with `-`. */
export function readerPathCandidates(argv: readonly string[]): string[] | null {
  const a0 = argv[0];
  if (typeof a0 !== "string" || !PATH_READER_CMDS.has(a0)) return null;
  const out: string[] = [];
  let afterDashDash = false;
  for (const a of argv.slice(1)) {
    if (afterDashDash) {
      out.push(a);
      continue;
    }
    if (a === "--") {
      afterDashDash = true;
      continue;
    }
    if (a.startsWith("-")) continue; // flags (and unparseable flag-values)
    out.push(a);
  }
  return out;
}

/** 2026-07-10 audit (finding 2a): `grep -r PATTERN .` rode the reader
 *  auto-allow — readerArgvGuard checks only argv PATHS, and `.` is neither
 *  absolute nor parent-escaping — then grep recursed into `.env` itself,
 *  composing with the redactor's gaps into a zero-prompt credential exfil
 *  chain. A recursive content read can't be path-guarded synchronously (the
 *  classifier does no fs access), so it prompts instead; `search_text` is
 *  the sanctioned recursive reader (per-file denylist + redaction). Plain rg
 *  stays allowed — its defaults skip hidden and ignored files — but flags
 *  that defeat those filters prompt. `find` discloses names, not contents,
 *  and keeps its existing guard. */
function recursiveContentRead(argv: readonly string[]): Verdict | null {
  const a0 = argv[0] as string;
  let hit = false;
  if (a0 === "grep") {
    let prev = "";
    for (const a of argv.slice(1)) {
      if (
        a === "--recursive" ||
        a === "--dereference-recursive" ||
        a === "--directories=recurse" ||
        (prev === "-d" && a === "recurse") ||
        /^-[A-Za-z]*[rR][A-Za-z]*$/.test(a)
      ) {
        hit = true;
        break;
      }
      prev = a;
    }
  } else if (a0 === "rg" || a0 === "ripgrep") {
    for (const a of argv.slice(1)) {
      if (
        a === "--hidden" ||
        a === "--unrestricted" ||
        a === "--binary" ||
        a.startsWith("--no-ignore") ||
        // `-L`/`--follow` defeat ripgrep's default of NOT following symlinks,
        // so recursion escapes the repo through an in-workspace directory
        // symlink — the operand-only reader guard never sees those
        // transitively-discovered files (audit T3.4 review). `[uL]` also
        // catches bundled `-Ln`/`-nL`.
        a === "--follow" ||
        /^-[a-zA-Z]*[uL][a-zA-Z]*$/.test(a)
      ) {
        hit = true;
        break;
      }
    }
  }
  if (!hit) return null;
  return {
    kind: "ask",
    risk: "workspace_read",
    code: "command_ask_recursive_read",
    reason: `${a0} recursive/unfiltered content read bypasses the credential denylist — prefer search_text`,
  };
}

const SH_FAMILY = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const POWERSHELL_FAMILY = new Set(["powershell", "pwsh"]);

/** Deletion commands Windows shells reach for; `Remove-Item -Recurse -Force
 *  C:\` is `rm -rf /` in a different coat. `ri` is the PowerShell alias. */
const WINDOWS_DELETE_CMDS = new Set([
  "remove-item",
  "ri",
  "rd",
  "rmdir",
  "del",
  "erase",
]);

/** Normalize an interpreter argv[0]: basename, lowercase, `.exe` stripped —
 *  `C:\Windows\System32\cmd.exe` and `CMD` both classify as `cmd`. */
function interpreterName(a0: string): string {
  const base = a0.split(/[\\/]/).pop() ?? a0;
  return base.toLowerCase().replace(/\.exe$/, "");
}

type Reentry =
  | { kind: "body"; via: string; body: string }
  | { kind: "refused"; via: string; reason: string };

/** 2026-07-10 audit (finding 3): shell re-entry matched ONLY `sh`/`bash`
 *  with argv[1] === "-c" exactly, so wrapping a catastrophic command in
 *  `cmd /c`, `powershell -Command`, `bash -lc`, or an -EncodedCommand
 *  payload downgraded the no-override BLOCK tier to a user-approvable ASK.
 *  This extracts the inner command for any known interpreter so the block
 *  check can re-enter it. Extraction only ever ESCALATES to block — a benign
 *  body never upgrades the wrapper to allow (shell chaining inside the body
 *  is exactly what the argv contract exists to avoid). */
function extractShellReentry(argv: readonly string[]): Reentry | null {
  if (argv.length === 0) return null;
  const name = interpreterName(argv[0] as string);

  if (SH_FAMILY.has(name)) {
    // POSIX shells bundle short options (`-lc`, `-xec`); the command string
    // is the first operand after the option group when any bundle had `c`.
    let sawC = false;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i] as string;
      if (a === "--") continue;
      if (/^-[A-Za-z]+$/.test(a)) {
        if (a.includes("c")) sawC = true;
        continue;
      }
      return sawC ? { kind: "body", via: `${name} -c`, body: a } : null;
    }
    return null;
  }

  if (name === "cmd") {
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i] as string;
      if (/^[/-][ckCK]$/.test(a)) {
        return {
          kind: "body",
          via: "cmd /c",
          body: argv.slice(i + 1).join(" "),
        };
      }
    }
    return null;
  }

  if (POWERSHELL_FAMILY.has(name)) {
    for (let i = 1; i < argv.length; i++) {
      const raw = argv[i] as string;
      if (!/^[-/][A-Za-z]+$/.test(raw)) continue;
      const flag = raw.slice(1).toLowerCase();
      // PowerShell accepts any unambiguous parameter PREFIX (`-c`, `-com`,
      // `-enc`, …) — match by prefix, not by exact spelling.
      if ("encodedcommand".startsWith(flag)) {
        const b64 = argv[i + 1];
        if (typeof b64 !== "string" || b64.length === 0) {
          return {
            kind: "refused",
            via: name,
            reason: `${name} -EncodedCommand without a payload`,
          };
        }
        // PowerShell encodes the command as base64 over UTF-16LE.
        // Buffer.from(_, "base64") never throws (invalid input is silently
        // skipped), so gate on the decode LOOKING like a command: an empty
        // or control-character-ridden decode is an opaque payload — refuse
        // it rather than classify garbage.
        const decoded = Buffer.from(b64, "base64").toString("utf16le");
        const looksBinary = Array.from(decoded).some((ch) => {
          const c = ch.charCodeAt(0);
          return c < 32 && c !== 9 && c !== 10 && c !== 13;
        });
        if (decoded.trim().length === 0 || looksBinary) {
          return {
            kind: "refused",
            via: name,
            reason: `${name} -EncodedCommand payload does not decode to a command`,
          };
        }
        return {
          kind: "body",
          via: `${name} -EncodedCommand`,
          body: decoded,
        };
      }
      if ("command".startsWith(flag)) {
        return {
          kind: "body",
          via: `${name} -Command`,
          body: argv.slice(i + 1).join(" "),
        };
      }
    }
    return null;
  }

  return null;
}

/**
 * The command's IDENTITY for the block / destructive tiers: basename,
 * lowercased, `.exe` stripped — the same normalization `interpreterName`
 * applies to shell re-entry.
 *
 * Audit 2026-08-05 (BL1): these branches used to compare the RAW argv[0],
 * some of them case-sensitively, so the tier depended on spelling —
 * `shutdown` blocked but `/sbin/shutdown` did not, and `rm` blocked but
 * `/bin/rm` and `RM` did not. The misses landed on `command_ask_unknown`,
 * which (unlike `command_ask_destructive`) is BOTH cacheable and
 * rule-eligible, so a path-qualified spelling was weaker in two tiers at
 * once.
 *
 * Deliberately NOT used by the Phase 5 ALLOW list: normalizing there would
 * make a planted `/tmp/evil/git` match the read-only allow tier. Allow must
 * keep matching the raw argv[0]; only the refusing tiers normalize.
 */
function commandIdentity(a0: string): string {
  return interpreterName(a0);
}

function isCatastrophic(argv: readonly string[]): {
  hit: boolean;
  reason: string;
} {
  if (argv.length === 0) return { hit: false, reason: "" };
  const raw = argv[0] as string;
  // `a0` is the normalized identity everywhere below; `raw` is kept only for
  // the human-readable reason strings.
  const a0 = commandIdentity(raw);

  if (a0 === "rm" && hasRecursiveForce(argv)) {
    for (const a of argv.slice(1)) {
      if (isSystemRootPath(a)) {
        return { hit: true, reason: `rm -rf on system path: ${a}` };
      }
    }
  }
  if (WINDOWS_DELETE_CMDS.has(a0)) {
    for (const a of argv.slice(1)) {
      if (isSystemRootPath(a)) {
        return { hit: true, reason: `${raw} on system path: ${a}` };
      }
    }
  }
  if (a0.startsWith("mkfs")) {
    return { hit: true, reason: `mkfs variant: ${raw}` };
  }
  if (a0 === "format" && /^[A-Za-z]:$/.test(argv[1] ?? "")) {
    return { hit: true, reason: `volume format: ${argv[1]}` };
  }
  if (a0 === "dd") {
    for (const a of argv) {
      if (typeof a === "string" && a.startsWith("of=/dev/")) {
        return { hit: true, reason: `dd write to raw device: ${a}` };
      }
    }
  }
  if (
    a0 === "shutdown" ||
    a0 === "reboot" ||
    a0 === "halt" ||
    a0 === "poweroff" ||
    a0 === "stop-computer" ||
    a0 === "restart-computer"
  ) {
    return { hit: true, reason: `system control: ${raw}` };
  }
  if (a0 === "init" && (argv[1] === "0" || argv[1] === "6")) {
    return { hit: true, reason: `init runlevel: ${argv[1]}` };
  }
  return { hit: false, reason: "" };
}

/**
 * Split a shell body into its individual commands on `;`, `&&`, `||`, `|`,
 * `&` and newlines — WITHOUT splitting inside quotes.
 *
 * Audit 2026-08-05 (S4): `classifyShellBody` whitespace-tokenized the whole
 * body and checked it once, and every catastrophic branch keys on the FIRST
 * token — so `bash -c "cd /tmp && rm -rf /"` traced to a plain ask. That is a
 * BLOCK→ASK downgrade of the no-override tier, the same class as the
 * 2026-07-10 finding 3, moved from the wrapper to the body separator.
 *
 * Splitting the TOKEN stream does not work: `cd /tmp;rm -rf /` tokenizes to
 * the glued `/tmp;rm`, so the separator has to be found in the raw string
 * with no whitespace requirement. Quote tracking is what keeps
 * `echo "a; shutdown"` from being blocked — the block tier has no override,
 * so a false positive there is a hard failure with no way past it.
 */
export function splitShellSegments(body: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    const prev = i > 0 ? body[i - 1] : "";
    if (quote !== null) {
      current += ch;
      // A backslash-escaped quote does not close the string (POSIX single
      // quotes take no escapes, but treating them alike only ever keeps the
      // segment together, which is the safe direction here).
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && prev !== "\\") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Block-tier scan of a whole shell body — every segment, nested
 *  interpreters unwrapped. Shared with the minimal contract's shell-string
 *  classifier (ADR 0040), which layers the ask/allow tiers on top. */
export function classifyShellBody(
  body: string,
  depth = 0,
): { hit: boolean; reason: string } {
  if (body.includes(":(){")) {
    return { hit: true, reason: "fork bomb pattern" };
  }
  // EVERY command in the body, not just the first (audit S4).
  for (const segment of splitShellSegments(body)) {
    const tokens = shellBodyTokens(segment);
    if (tokens.length === 0) continue;
    const direct = isCatastrophic(tokens);
    if (direct.hit) return direct;
    // Nested wrapping (`cmd /c "powershell -Command shutdown /s"`) unwraps one
    // interpreter per level; the depth cap bounds a crafted chain.
    if (depth < 3) {
      const nested = extractShellReentry(tokens);
      if (nested?.kind === "body") {
        const inner = classifyShellBody(nested.body, depth + 1);
        if (inner.hit) return inner;
      }
      if (nested?.kind === "refused") {
        return { hit: true, reason: nested.reason };
      }
    }
  }
  return { hit: false, reason: "" };
}

export function classifyCommand(argv: readonly string[]): Verdict {
  if (argv.length === 0) {
    return {
      kind: "block",
      code: "command_blocked",
      reason: "empty argv",
    };
  }
  const a0 = argv[0] as string;

  // PHASE 1 — block (direct argv)
  const direct = isCatastrophic(argv);
  if (direct.hit) {
    return {
      kind: "block",
      code: "command_blocked",
      reason: direct.reason,
    };
  }
  // PHASE 1 — block (shell-body re-entry, any known interpreter)
  const reentry = extractShellReentry(argv);
  if (reentry?.kind === "refused") {
    return {
      kind: "block",
      code: "command_blocked",
      reason: reentry.reason,
    };
  }
  if (reentry?.kind === "body") {
    const inside = classifyShellBody(reentry.body);
    if (inside.hit) {
      return {
        kind: "block",
        code: "command_blocked",
        reason: `${reentry.via} body: ${inside.reason}`,
      };
    }
  }

  // PHASE 2 — ASK destructive
  // Normalized identity, same reasoning as the block tier (audit BL1): a
  // path-qualified `/bin/rm -rf build/` must not slip past the destructive
  // ask into the cacheable, rule-eligible unknown class.
  const id = commandIdentity(a0);
  if (id === "rm" && hasRecursiveForce(argv)) {
    return {
      kind: "ask",
      risk: "workspace_destructive",
      code: "command_ask_destructive",
      reason: `rm -rf inside repo: ${argv.slice(1).join(" ")}`,
    };
  }
  if (id === "git" && argv[1] === "reset" && argv.includes("--hard")) {
    return {
      kind: "ask",
      risk: "workspace_destructive",
      code: "command_ask_destructive",
      reason: "git reset --hard",
    };
  }
  if (
    id === "git" &&
    argv[1] === "clean" &&
    (argv.includes("-f") || argv.includes("--force"))
  ) {
    return {
      kind: "ask",
      risk: "workspace_destructive",
      code: "command_ask_destructive",
      reason: "git clean -f",
    };
  }
  if (id === "chmod") {
    return {
      kind: "ask",
      risk: "workspace_destructive",
      code: "command_ask_destructive",
      reason: `chmod: ${argv.slice(1).join(" ")}`,
    };
  }

  // PHASE 3 — ASK network
  if (a0 === "curl" || a0 === "wget") {
    return {
      kind: "ask",
      risk: "network",
      code: "command_ask_network",
      reason: `${a0} network call`,
    };
  }
  if (
    (a0 === "npm" || a0 === "pnpm") &&
    (argv[1] === "install" || argv[1] === "add" || argv[1] === "i")
  ) {
    return {
      kind: "ask",
      risk: "network",
      code: "command_ask_network",
      reason: `${a0} ${argv[1]}`,
    };
  }
  if (a0 === "pip" && argv[1] === "install") {
    return {
      kind: "ask",
      risk: "network",
      code: "command_ask_network",
      reason: "pip install",
    };
  }
  if (a0 === "cargo" && argv[1] === "install") {
    return {
      kind: "ask",
      risk: "network",
      code: "command_ask_network",
      reason: "cargo install",
    };
  }
  if (a0 === "go" && argv[1] === "install") {
    return {
      kind: "ask",
      risk: "network",
      code: "command_ask_network",
      reason: "go install",
    };
  }

  // PHASE 4 — ASK workspace_write (redirection inside any shell body)
  if (reentry?.kind === "body" && /(?<!\\)>>?/.test(reentry.body)) {
    return {
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_write",
      reason: `${reentry.via} with redirection`,
    };
  }
  if (a0 === "find" && (argv.includes("-delete") || argv.includes("-exec"))) {
    return {
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_write",
      reason: "find with -delete or -exec",
    };
  }

  // PHASE 5 — ALLOW
  if (
    (a0 === "npm" || a0 === "pnpm") &&
    (argv[1] === "test" ||
      (argv[1] === "run" && (argv[2] === "test" || argv[2] === "lint")))
  ) {
    return { kind: "allow" };
  }
  if (a0 === "pytest") return { kind: "allow" };
  if (
    a0 === "cargo" &&
    (argv[1] === "test" || argv[1] === "build" || argv[1] === "check")
  ) {
    return { kind: "allow" };
  }
  if (a0 === "go" && argv[1] === "test") return { kind: "allow" };
  if (
    a0 === "git" &&
    typeof argv[1] === "string" &&
    [
      "status",
      "diff",
      "log",
      "show",
      "branch",
      "rev-parse",
      "ls-files",
    ].includes(argv[1])
  ) {
    // `git diff --no-index <p1> <p2>` is git's arbitrary-filesystem compare —
    // it works outside any repo and, against /dev/null, prints a whole file
    // verbatim. That is a zero-prompt read of ANY path (credentials, out of
    // repo) the reader guard cannot see (git is not a reader). ASK: the
    // displayed paths are visible, so the user can knowingly approve/deny
    // (audit T3.4 review). Regular git diff/show stay repo-confined → allow.
    if (argv[1] === "diff" && argv.includes("--no-index")) {
      return {
        kind: "ask",
        risk: "workspace_read",
        code: "command_ask_reader_path",
        reason:
          "git diff --no-index reads arbitrary filesystem paths — review the targets",
      };
    }
    return { kind: "allow" };
  }
  if (a0 === "grep" || a0 === "rg" || a0 === "ripgrep") {
    return (
      recursiveContentRead(argv) ?? readerArgvGuard(argv) ?? { kind: "allow" }
    );
  }
  if (a0 === "find") {
    // `-L`/`-follow` dereference symlinks during traversal, so `find` escapes
    // the repo through an in-workspace directory symlink and discloses
    // out-of-workspace/credential file NAMES — the operand-only reader guard
    // never sees the walked tree (audit T3.4 review). ASK (the flag is
    // visible in the command).
    if (argv.includes("-L") || argv.includes("-follow")) {
      return {
        kind: "ask",
        risk: "workspace_read",
        code: "command_ask_reader_path",
        reason:
          "find -L/-follow dereferences symlinks during traversal, escaping the workspace guard",
      };
    }
    return readerArgvGuard(argv) ?? { kind: "allow" };
  }
  if (
    [
      "ls",
      "cat",
      "head",
      "tail",
      "wc",
      "echo",
      "true",
      "false",
      "pwd",
      "date",
      "whoami",
    ].includes(a0)
  ) {
    return readerArgvGuard(argv) ?? { kind: "allow" };
  }

  // PHASE 6 — DEFAULT
  // Known script interpreters get an HONEST ask class before the generic
  // fallback (owner 2026-08-04): `node src/index.mjs` is not "unrecognized" —
  // the harness knows exactly what it is, and asks because an interpreter
  // executes code the argv only names indirectly. The distinct code lets the
  // approval surface say so (and gates project-rule derivation, ADR 0030)
  // instead of the prompt reading as ignorance. Same ask tier, same risk —
  // only the classification is more truthful.
  if (SCRIPT_INTERPRETERS.has(interpreterName(a0))) {
    return {
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_interpreter",
      reason: `${a0} executes a script — review the script path and arguments`,
    };
  }
  return {
    kind: "ask",
    risk: "workspace_write",
    code: "command_ask_unknown",
    reason: "unrecognized command — review carefully",
  };
}
