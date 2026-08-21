import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** A visible user-level Herta configuration root. It deliberately does not use
 * Electron's `userData`: that directory belongs to machine-private app state,
 * while rules and MCP definitions must be inspectable and portable. */
export function hertaHomeDir(
  opts: {
    readonly home?: string;
    readonly hertaHome?: string | undefined;
  } = {},
): string {
  const override = opts.hertaHome?.trim();
  if (override !== undefined && override.length > 0) return resolve(override);
  return join(opts.home ?? homedir(), ".herta");
}

/** Herta's project-level configuration directory for one effective workspace. */
export function projectHertaDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".herta");
}

/** A small descriptor reused by GUI APIs so callers cannot confuse scopes. */
export type HertaConfigScope = "global" | "project";

export function hertaConfigDir(
  scope: HertaConfigScope,
  opts: {
    readonly workspaceRoot?: string;
    readonly home?: string;
    readonly hertaHome?: string | undefined;
  } = {},
): string | null {
  if (scope === "global") {
    return hertaHomeDir({ home: opts.home, hertaHome: opts.hertaHome });
  }
  return opts.workspaceRoot === undefined
    ? null
    : projectHertaDir(opts.workspaceRoot);
}
