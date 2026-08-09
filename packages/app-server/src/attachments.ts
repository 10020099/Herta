import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { SystemBlock } from "@herta/core";
import { sanitizeSystemBlock } from "@herta/herta";
import {
  looksBinary,
  MAX_EXCERPT_CHARS,
  MAX_EXCERPT_LINES,
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
 */

/** Per-file byte cap. Above this the file is still STORED — refusing to store
 *  a large document would be the wrong failure, since searching a 5MB log is a
 *  real use — but no head excerpt is taken and the block says so. */
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

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

export type AttachmentUnreadable =
  | "binary"
  | "too_large"
  | "empty"
  | "read_error";

export interface IngestedAttachment {
  /** The record block to append. Already sanitized. */
  readonly block: SystemBlock;
  /** Workspace-relative path the file was stored at. */
  readonly relPath: string;
  /** Set when no excerpt was taken. */
  readonly unreadable?: AttachmentUnreadable;
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

/** Cut the head of a document for `evidenceDetail`. Presentation bounds, shared
 *  with `show_excerpt` — this exists to be read, and it lands in Herta's prompt
 *  for exactly one turn (the per-block fold drops it once she has spoken). */
export function headExcerpt(text: string): { text: string; clipped: boolean } {
  const lines = text.split("\n");
  let out = lines.slice(0, MAX_EXCERPT_LINES).join("\n");
  let clipped = lines.length > MAX_EXCERPT_LINES;
  if (out.length > MAX_EXCERPT_CHARS) {
    out = out.slice(0, MAX_EXCERPT_CHARS);
    clipped = true;
  }
  return { text: out, clipped };
}

function formatCount(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n);
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

  let bytes: Buffer;
  let tooLargeBytes = false;
  try {
    const st = statSync(opts.sourcePath);
    tooLargeBytes = st.size > MAX_ATTACHMENT_BYTES;
    bytes = await readFile(opts.sourcePath);
  } catch {
    // Nothing was stored, so there is no path to cite. Say so and stop —
    // an attachment block naming a file that is not there would be worse
    // than the failure it hides.
    return {
      block: buildBlock({
        displayName,
        relPath: null,
        lines: 0,
        chars: 0,
        unreadable: "read_error",
      }),
      relPath: "",
      unreadable: "read_error",
    };
  }

  const dir = attachmentDirFor(opts.sessionId);
  const storedName = safeStoredName(displayName, bytes);
  const relPath = `${dir}/${storedName}`;
  const absDir = join(opts.workspaceRoot, ...dir.split("/"));
  mkdirSync(absDir, { recursive: true });
  writeFileSync(join(absDir, storedName), bytes);

  // Stored either way — a file too big to excerpt is still worth searching.
  if (tooLargeBytes) {
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
