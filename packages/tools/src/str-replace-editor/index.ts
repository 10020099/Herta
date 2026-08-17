import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  HertaTool,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { PersistentShell, SHELL_BG_ID } from "../bash/persistent-shell.js";
import { type ShellPaths, shellPathsFor } from "../bash/shell-paths.js";
import { computeUnifiedDiff } from "../edit-file/engine.js";
import { formatInputIssues } from "../input-issues.js";
import {
  countDiffLines,
  formatFileView,
  listDirectory,
  MAX_FILE_BYTES,
  planEdit,
  resolveEditorPath,
} from "./engine.js";
import {
  STR_REPLACE_EDITOR_DESCRIPTION,
  strReplaceEditorInputSchema,
  strReplaceEditorJsonSchema,
} from "./schema.js";

export {
  makeStrReplaceEditorRule,
  registerStrReplaceEditorRule,
} from "./rule.js";
export type { StrReplaceEditorInput } from "./schema.js";

/** Result data (harness-facing). Writes carry relPath + diff so the runtime
 *  harvests changedFiles like edit_file / write_new_file; `wrote` is what
 *  the completion heuristic keys on (a view proves nothing). */
export interface StrReplaceEditorData {
  command: "view" | "create" | "str_replace" | "insert";
  /** Workspace-relative POSIX path (writes only — a view has `path`). */
  relPath?: string;
  path?: string;
  diff?: string;
  wrote?: boolean;
  created?: boolean;
  /** view: the range shown (1-based, inclusive). */
  from?: number;
  to?: number;
}

export interface StrReplaceEditorToolOpts {
  /** The bash binary (for path spelling); null → native paths only. */
  bashPath: string | null;
  /** How the shell spells the workspace (schema example paths). A getter:
   *  a session's workspace can change between dispatches. */
  workspaceShellPath: () => string;
}

function fail(
  code: string,
  message: string,
  summary?: string,
): ToolResult<StrReplaceEditorData> {
  return {
    ok: false,
    error: { code, message, retryable: false },
    summary: summary ?? `failed: ${code}`,
    modelText: message,
  };
}

/**
 * `str_replace_editor` — the minimal contract's editor (ADR 0040).
 *
 * `view` reads (and records the file in the read ledger); `create` /
 * `str_replace` / `insert` write atomically (temp + rename) after the
 * permission rule computed the same edit for the preview + ask — the tool
 * recomputes against the file as it is NOW, so a change between the ask
 * and the apply surfaces as the trained "did not appear verbatim" instead
 * of a stale write. Model-facing text is the trained shape's; the harness
 * gets structured data for the record and the report.
 */
export function strReplaceEditorTool(
  opts: StrReplaceEditorToolOpts,
): HertaTool {
  const paths: ShellPaths = shellPathsFor(opts.bashPath);
  return {
    name: "str_replace_editor",
    schema(): ToolSchema {
      return {
        name: "str_replace_editor",
        description: STR_REPLACE_EDITOR_DESCRIPTION,
        inputSchema: strReplaceEditorJsonSchema(opts.workspaceShellPath()),
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<StrReplaceEditorData>> {
      const parsed = strReplaceEditorInputSchema.safeParse(call.input);
      if (!parsed.success) {
        const message = formatInputIssues(parsed.error);
        return fail(
          "invalid_input",
          `Invalid parameters for str_replace_editor: ${message}. The allowed commands are: view, create, str_replace, insert.`,
        );
      }
      const input = parsed.data;
      const shell = ctx.bg.getInternal(SHELL_BG_ID);
      const wsShell =
        shell instanceof PersistentShell
          ? shell.workspaceShellPath
          : paths.toShell(ctx.workspaceRoot);
      const target = await resolveEditorPath(
        input.path,
        ctx,
        paths,
        wsShell,
        input.command === "view",
      );
      if (!target.ok) return fail(target.code, target.message);

      // ── view ──
      if (input.command === "view") {
        let info: Awaited<ReturnType<typeof stat>>;
        try {
          info = await stat(target.resolved);
        } catch {
          return fail(
            "not_found",
            `The path ${target.display} does not exist. Please provide a valid path.`,
          );
        }
        if (info.isDirectory()) {
          if (input.view_range !== undefined) {
            return fail(
              "invalid_input",
              "The `view_range` parameter is not allowed when `path` points to a directory.",
            );
          }
          const listing = await listDirectory(target.resolved, target.display);
          return {
            ok: true,
            data: {
              command: "view",
              path: target.relative === "" ? "." : target.relative,
            },
            summary: `listed ${target.relative === "" ? "." : target.relative}`,
            modelText: listing,
          };
        }
        if (!info.isFile()) {
          return fail(
            "invalid_input",
            `cannot view "${target.display}": not a regular file or directory`,
          );
        }
        if (info.size > MAX_FILE_BYTES) {
          return fail(
            "file_too_large",
            `The file ${target.display} is too large to view (${info.size} bytes); use \`sed -n\` / \`grep -n\` through bash for a slice.`,
          );
        }
        const buf = await readFile(target.resolved);
        if (buf.subarray(0, Math.min(4096, buf.length)).includes(0)) {
          return fail(
            "binary_file",
            `The file ${target.display} is binary; this tool views text files only.`,
          );
        }
        ctx.reads.record(
          target.resolved,
          createHash("sha256").update(buf).digest("hex"),
        );
        const view = formatFileView(
          target.display,
          buf.toString("utf-8"),
          input.view_range,
        );
        if (!view.ok) return fail("invalid_input", view.message);
        return {
          ok: true,
          data: {
            command: "view",
            path: target.relative,
            from: view.from,
            to: view.to,
          },
          summary: `viewed ${target.relative} (${view.from}-${view.to})`,
          modelText: view.text,
        };
      }

      // ── create ──
      if (input.command === "create") {
        if (typeof input.file_text !== "string") {
          return fail(
            "invalid_input",
            "Parameter `file_text` is required for command: create",
          );
        }
        try {
          await stat(target.resolved);
          return fail(
            "create_exists",
            `File already exists at: ${target.display}. Cannot overwrite files using command \`create\`.`,
          );
        } catch {
          // absent — good
        }
        await mkdir(dirname(target.resolved), { recursive: true });
        const written = await atomicWrite(target.resolved, input.file_text);
        if (!written.ok) return fail("write_failed", written.message);
        ctx.reads.record(
          target.resolved,
          createHash("sha256").update(input.file_text).digest("hex"),
        );
        const diff = computeUnifiedDiff("", input.file_text, target.relative);
        return {
          ok: true,
          data: {
            command: "create",
            relPath: target.relative,
            diff,
            wrote: true,
            created: true,
          },
          summary: `created ${target.relative} (${countDiffLines(diff, "+")} lines)`,
          modelText: `New file created successfully at: ${target.display}`,
        };
      }

      // ── str_replace / insert ──
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(target.resolved);
      } catch {
        return fail(
          "not_found",
          `The path ${target.display} does not exist. Please provide a valid path.`,
        );
      }
      if (info.isDirectory()) {
        return fail(
          "invalid_input",
          `The path ${target.display} is a directory and only the \`view\` command can be used on directories`,
        );
      }
      if (info.size > MAX_FILE_BYTES) {
        return fail(
          "file_too_large",
          `The file ${target.display} is too large to edit (${info.size} bytes > ${MAX_FILE_BYTES}).`,
        );
      }
      const buf = await readFile(target.resolved);
      if (buf.subarray(0, Math.min(4096, buf.length)).includes(0)) {
        return fail(
          "binary_file",
          `The file ${target.display} is binary and cannot be edited with this tool.`,
        );
      }
      if (input.command === "insert") {
        // Line numbers are only meaningful relative to a view (see rule).
        const sha = createHash("sha256").update(buf).digest("hex");
        const entry = ctx.reads.get(target.resolved);
        if (!entry) {
          return fail(
            "view_required",
            `Please \`view\` ${target.display} before using \`insert\` — insert_line refers to the line numbers of a view.`,
          );
        }
        if (entry.sha256 !== sha) {
          return fail(
            "stale_view",
            `${target.display} changed since you last viewed it; view it again and recompute insert_line.`,
          );
        }
      }
      const before = buf.toString("utf-8");
      const plan = planEdit(input, before, target.display, target.relative);
      if (!plan.ok) return fail(plan.code, plan.message);
      const written = await atomicWrite(target.resolved, plan.after);
      if (!written.ok) return fail("write_failed", written.message);
      ctx.reads.record(
        target.resolved,
        createHash("sha256").update(plan.after).digest("hex"),
      );
      return {
        ok: true,
        data: {
          command: input.command,
          relPath: target.relative,
          diff: plan.diff,
          wrote: true,
          created: false,
        },
        summary: `edited ${target.relative} (${input.command}, +${countDiffLines(plan.diff, "+")}/-${countDiffLines(plan.diff, "-")} lines)`,
        modelText: `The file ${target.display} has been edited successfully.`,
      };
    },
  };
}

async function atomicWrite(
  resolved: string,
  content: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const tmp = join(
    dirname(resolved),
    `.${basename(resolved)}.herta-tmp-${randomUUID()}`,
  );
  try {
    await writeFile(tmp, content, { encoding: "utf-8", flag: "wx" });
  } catch (err: unknown) {
    return {
      ok: false,
      message: (err as Error).message ?? "temp write failed",
    };
  }
  try {
    await rename(tmp, resolved);
  } catch (err: unknown) {
    try {
      await unlink(tmp);
    } catch {
      // best-effort
    }
    return { ok: false, message: (err as Error).message ?? "rename failed" };
  }
  return { ok: true };
}
