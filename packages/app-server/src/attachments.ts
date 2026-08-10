import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { SystemBlock } from "@herta/core";
import { ensureHertaGitignore } from "@herta/core";
import { sanitizeSystemBlock } from "@herta/herta";
import {
  isCredentialBasename,
  isSensitiveSegment,
  looksBinary,
  MAX_EXCERPT_CHARS,
  MAX_EXCERPT_LINES,
  redactSecrets,
} from "@herta/tools";

/**
 * Ingest a document the 开拓者 handed over (ADR 0033).
 *
 * The whole job is: get the bytes inside the workspace where the ordinary file
 * tools can already reach them, and emit ONE record block saying what arrived.
 * There is deliberately no new reading capability here — `read_file`,
 * `search_text`, `glob` and `show_excerpt` handle documents of any size
 * already, and ADR 0025 slice 2's persistence layer survived a 347K-char read.
 * A 200-page document is a file.
 *
 * All I/O is async: this runs on the Electron MAIN process, and a synchronous
 * multi-megabyte copy there freezes the whole window for its duration.
 */

/** Per-file excerpt cap. Above this the file may still be STORED (searching a
 *  5MB log is a real use) but no head excerpt is taken and the block says so. */
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

/** Storage ceiling (ADR 0033, amended after review). Files above this are
 *  REFUSED without being read: the first implementation read every source
 *  into memory before deciding anything, so a mis-dropped 20GB ISO meant a
 *  multi-gigabyte buffer (or ERR_FS_FILE_TOO_LARGE dressed up as a read
 *  error) and a workspace copy nobody asked for. The stat runs first and a
 *  too-big file costs nothing. */
export const MAX_ATTACHMENT_STORE_BYTES = 64 * 1024 * 1024;

/** Decoded-character cap, applied after the byte cap because a UTF-8 file can
 *  be far smaller in bytes than in the chars a prompt pays for. */
export const MAX_ATTACHMENT_CHARS = 200_000;

/** Files per attach action. */
export const MAX_ATTACHMENTS_PER_ACTION = 10;

/** Where a session's attachments live, relative to the backend workspace.
 *  Session-scoped so deleting or rewinding a session takes its documents with
 *  it, and so the path class in `resolveSafePath` can be a fixed prefix. */
export function attachmentDirFor(sessionId: string): string {
  return `.herta/attachments/${sessionId}`;
}

/**
 * Move a session's attachments when the backend workspace changes
 * (owner question, 2026-08-10).
 *
 * Attachment blocks cite a workspace-RELATIVE path, and 板砖 resolves it
 * against whatever root is current at dispatch time. So without this, changing
 * the coprocessor's working directory silently broke every document already
 * handed over: the citation still read `.herta/attachments/<sid>/spec.md`, and
 * that path no longer pointed at anything. `removeAttachment` had the mirror
 * bug — it unlinked from the CURRENT root with `force: true`, reporting success
 * while the real file sat orphaned under the old one.
 *
 * A MOVE, not a copy: exactly one copy of a user's document should exist, and
 * switching back and forth should not scatter duplicates across every workspace
 * they have ever pointed at.
 *
 * Best-effort and non-throwing, because a workspace change must not fail over
 * file housekeeping — but deliberately NOT silent about the order of
 * operations: the old directory is removed only after the copy lands, so a
 * failure mid-way leaves the originals where they are rather than losing them.
 * Returns whether anything moved, for the caller's log/test.
 */
export async function migrateAttachments(opts: {
  readonly fromRoot: string;
  readonly toRoot: string;
  readonly sessionId: string;
}): Promise<boolean> {
  if (opts.fromRoot === opts.toRoot) return false;
  const rel = attachmentDirFor(opts.sessionId).split("/");
  const from = join(opts.fromRoot, ...rel);
  const to = join(opts.toRoot, ...rel);
  try {
    if (!existsSync(from)) return false;
    await mkdir(dirname(to), { recursive: true });
    // Merge rather than replace: switching away and back should find the
    // directory as it was left. Content-hashed names make same-name collisions
    // same-content, so overwriting is a no-op on identical files.
    await cp(from, to, { recursive: true, force: true });
    await rm(from, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export type AttachmentUnreadable =
  | "binary"
  | "too_large"
  | "empty"
  | "read_error"
  | "denied";

export interface IngestedAttachment {
  /** The record block to append. Already sanitized. */
  readonly block: SystemBlock;
  /** Workspace-relative path the file was stored at. Empty when nothing was
   *  stored (read_error, denied, over the storage ceiling). */
  readonly relPath: string;
  /** Set when no excerpt was taken. */
  readonly unreadable?: AttachmentUnreadable;
}

/**
 * Credential guard on the SOURCE path (ADR 0033 review finding).
 *
 * Two reasons this must run at the door rather than relying on the stored
 * side. First, `safeStoredName` appends a content hash, so `id_rsa` stores as
 * `id_rsa-ab12cd34` — a name the credential-basename denylist no longer
 * matches. The store-side guard is structurally bypassed for exactly the
 * files it exists to protect. Second, the attach IPC accepts arbitrary paths
 * from the renderer, and the renderer is sandboxed away from the filesystem
 * on purpose: without this check, attach is a read-any-file primitive whose
 * output (the head excerpt) streams straight back to the renderer through the
 * record. The same shared denylist every tool uses (D4 — one definition of
 * "credential-shaped", or none).
 */
function isCredentialShapedSource(sourcePath: string): boolean {
  const segments = sourcePath.split(/[\\/]/).filter((s) => s.length > 0);
  const base = segments[segments.length - 1] ?? "";
  if (isCredentialBasename(base)) return true;
  return segments.some((s) => isSensitiveSegment(s));
}

/**
 * Make a user-supplied filename safe to join onto a path.
 *
 * The name comes from outside the workspace entirely, so it is the one string
 * here that an attacker (or an ordinary user with an odd filename) fully
 * controls. Everything outside a conservative allowlist becomes `_`, path
 * separators and dots included, so `../../.ssh/id_rsa` cannot survive as
 * anything but a flat basename — belt to `resolveSafePath`'s braces, since the
 * write itself does not go through the tool path guard.
 *
 * The DISPLAY name keeps the original spelling; only the on-disk name is
 * flattened. A user who attaches `报告 (最终).md` should see that in the
 * record, not `___________.md`.
 */
export function safeStoredName(originalName: string, bytes: Buffer): string {
  const base = basename(originalName);
  const ext = extname(base)
    .slice(0, 16)
    .replace(/[^A-Za-z0-9.]/g, "");
  const stem = base
    .slice(0, base.length - extname(base).length)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 60);
  // A content hash disambiguates same-named files and makes re-attaching the
  // identical document idempotent rather than accumulating copies.
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const safeStem = stem.length > 0 ? stem : "file";
  return `${safeStem}-${hash}${ext}`;
}

/**
 * Cut the head of a document for `evidenceDetail`. Presentation bounds, shared
 * with `show_excerpt` — this exists to be read, and it lands in Herta's prompt
 * for exactly one turn (the per-block fold drops it once she has spoken).
 *
 * REDACTED (2026-08-10, found in an owner screenshot). The filename guard
 * cannot carry this on its own: it refuses credential-SHAPED names, and a file
 * called `openrouter_key.txt` matches none of them — so the ingest stored it,
 * cut its head, and put two live API keys into the record, the GUI, and the
 * prompt sent to DeepSeek. `run_command` output and `search_text` results have
 * always run through `redactSecrets`; the ingest was the one producer of
 * untrusted text that did not, and a hand-uploaded file is the likeliest place
 * of all for a key to appear.
 *
 * The STORED file is left verbatim. It is the user's document, redacting it
 * would corrupt their data, and the tools that read it are the ones they
 * pointed at it deliberately. This redacts the copy that travels — record,
 * screen, prompt — which is the copy nobody asked to publish.
 */
export function headExcerpt(text: string): { text: string; clipped: boolean } {
  const lines = text.split("\n");
  let out = lines.slice(0, MAX_EXCERPT_LINES).join("\n");
  let clipped = lines.length > MAX_EXCERPT_LINES;
  if (out.length > MAX_EXCERPT_CHARS) {
    out = out.slice(0, MAX_EXCERPT_CHARS);
    clipped = true;
  }
  // Redact AFTER slicing so a secret straddling the cut cannot be halved into
  // something the patterns no longer recognize but a reader still can.
  return { text: redactSecrets(out), clipped };
}

function formatCount(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n);
}

/** The not-stored result shapes share one constructor so `relPath: ""` and
 *  the block's empty digest path can never drift apart. */
function notStored(
  displayName: string,
  unreadable: AttachmentUnreadable,
): IngestedAttachment {
  return {
    block: buildBlock({
      displayName,
      relPath: null,
      lines: 0,
      chars: 0,
      unreadable,
    }),
    relPath: "",
    unreadable,
  };
}

/**
 * Copy one file into the session's attachment directory and build its record
 * block.
 *
 * `workspaceRoot` must be the BACKEND's effective workspace, not the session's
 * record anchor: the block's path is what 板砖 will later resolve, and it
 * resolves against the backend root. If the user changes workspace afterwards
 * the stored path goes stale — the same way every other relative path already
 * in the record does, so this introduces no new class of staleness.
 *
 * Never throws: every failure becomes a block that says what happened. The
 * caller appends whatever comes back, so a throw here would be a file that
 * vanished without a trace — the one outcome worse than any failure state.
 */
export async function ingestAttachment(opts: {
  readonly sourcePath: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  /** Overrides the on-disk source's basename for DISPLAY (the renderer knows
   *  the name the user saw; the main process only has a temp path in some
   *  drag-and-drop flows). */
  readonly displayName?: string;
}): Promise<IngestedAttachment> {
  const displayName = opts.displayName ?? basename(opts.sourcePath);

  // Credential guard first — before any read, and on BOTH names (they are the
  // same in today's flows, but the display override must not become the hole).
  if (
    isCredentialShapedSource(opts.sourcePath) ||
    isCredentialShapedSource(displayName)
  ) {
    return notStored(displayName, "denied");
  }

  // Stat before read: the storage ceiling must not cost a read of the very
  // bytes it exists to refuse.
  let size: number;
  try {
    size = (await stat(opts.sourcePath)).size;
  } catch {
    return notStored(displayName, "read_error");
  }
  if (size > MAX_ATTACHMENT_STORE_BYTES) {
    return notStored(displayName, "too_large");
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(opts.sourcePath);
  } catch {
    return notStored(displayName, "read_error");
  }

  const dir = attachmentDirFor(opts.sessionId);
  const storedName = safeStoredName(displayName, bytes);
  const relPath = `${dir}/${storedName}`;
  try {
    const absDir = join(opts.workspaceRoot, ...dir.split("/"));
    await mkdir(absDir, { recursive: true });
    await writeFile(join(absDir, storedName), bytes);
    // Same reason as every other `.herta` writer (audit BL6): in a real repo,
    // the first `git add -A` after an attach would otherwise sweep the user's
    // own documents into a commit. Best-effort by its own contract.
    ensureHertaGitignore(opts.workspaceRoot);
  } catch {
    // The write failed, so nothing is at the path — same truth as read_error:
    // not on disk, do not cite a location.
    return notStored(displayName, "read_error");
  }

  // Stored, but larger than the excerpt cap — searchable, not excerpted.
  if (size > MAX_ATTACHMENT_BYTES) {
    return {
      block: buildBlock({
        displayName,
        relPath,
        lines: 0,
        chars: 0,
        unreadable: "too_large",
      }),
      relPath,
      unreadable: "too_large",
    };
  }
  if (looksBinary(bytes)) {
    return {
      block: buildBlock({
        displayName,
        relPath,
        lines: 0,
        chars: 0,
        unreadable: "binary",
      }),
      relPath,
      unreadable: "binary",
    };
  }

  const text = bytes.toString("utf8");
  if (text.trim().length === 0) {
    return {
      block: buildBlock({
        displayName,
        relPath,
        lines: 0,
        chars: 0,
        unreadable: "empty",
      }),
      relPath,
      unreadable: "empty",
    };
  }
  if (text.length > MAX_ATTACHMENT_CHARS) {
    return {
      block: buildBlock({
        displayName,
        relPath,
        lines: text.split("\n").length,
        chars: text.length,
        unreadable: "too_large",
      }),
      relPath,
      unreadable: "too_large",
    };
  }

  const head = headExcerpt(text);
  return {
    block: buildBlock({
      displayName,
      relPath,
      lines: text.split("\n").length,
      chars: text.length,
      head,
    }),
    relPath,
  };
}

/**
 * Compose the block. The canonical body is Chinese, like the bridge's marker
 * bodies and unlike the bus-projected op rows — this block is harness-authored
 * prose, not an echo of a tool argument. Renderers localize from the digest
 * (ADR 0018), so the body is never parsed.
 */
function buildBlock(a: {
  displayName: string;
  relPath: string | null;
  lines: number;
  chars: number;
  unreadable?: AttachmentUnreadable;
  head?: { text: string; clipped: boolean };
}): SystemBlock {
  const REASON: Record<AttachmentUnreadable, string> = {
    binary: "非文本文件，未取正文",
    too_large: "文件过大，未取正文",
    empty: "未提取到文本",
    read_error: "读取失败",
    denied: "涉及密钥或凭据，已拒收",
  };

  const parts = [`附件 ${a.displayName}`];
  if (a.unreadable !== undefined) {
    parts.push(REASON[a.unreadable]);
    if (a.relPath !== null) parts.push(a.relPath);
  } else {
    parts.push(`${formatCount(a.lines)} 行`, `${formatCount(a.chars)} 字`);
    if (a.relPath !== null) parts.push(a.relPath);
  }

  const block: SystemBlock = {
    kind: "system",
    label: "系统",
    body: parts.join(" · "),
    ...(a.head !== undefined && a.relPath !== null
      ? {
          evidenceDetail: `↳ 附件 ${a.displayName}\n${a.head.text}${
            a.head.clipped ? "\n（仅开头部分，正文更长）" : ""
          }`,
          evidence: [
            {
              kind: "attachment" as const,
              name: a.displayName,
              path: a.relPath,
              text: a.head.text,
              clipped: a.head.clipped,
            },
          ],
        }
      : {}),
    digest: {
      kind: "attachment",
      name: a.displayName,
      path: a.relPath ?? "",
      lines: a.lines,
      chars: a.chars,
      ...(a.unreadable !== undefined ? { unreadable: a.unreadable } : {}),
    },
  };

  // The trust boundary. An attachment's name and text are the only strings
  // reaching a prompt that never passed through the repo or the backend — the
  // user picked them — and the serializer does not sanitize system bodies at
  // read, so construction is the only gate. A planted （我 说） in an uploaded
  // file must not forge an actor block.
  return sanitizeSystemBlock(block);
}
