import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hertaHomeDir, projectHertaDir } from "./config-scope.js";

/** Only `rules.md`, `rules1.md`, `rules2.md`, … are accepted rule files. */
const PROJECT_RULE_FILE = /^rules(\d*)\.md$/;

/** A rule file is exactly `rules.md` or `rules` plus decimal digits. */
export function isProjectRuleFileName(name: string): boolean {
  return PROJECT_RULE_FILE.test(name);
}

export interface ProjectRuleFile {
  readonly name: string;
  readonly content: string;
}

/** Keeps one accidental or generated file from overwhelming the model prompt. */
export const MAX_PROJECT_RULE_FILE_CHARS = 20_000;
/** Caps the combined global-plus-project rule payload visible to each request. */
export const MAX_PROJECT_RULES_CHARS = 50_000;

export interface ProjectRulesSnapshot {
  /** Prompt-ready, labeled rule text. Empty when no rule file has content. */
  readonly text: string;
  /** Contributing paths in injection order; global files are prefixed `global/`. */
  readonly files: readonly string[];
  /** True when one or more bodies were capped to keep the prompt bounded. */
  readonly truncated: boolean;
}

function ruleFileOrder(a: string, b: string): number {
  const aSuffix = PROJECT_RULE_FILE.exec(a)?.[1] ?? "";
  const bSuffix = PROJECT_RULE_FILE.exec(b)?.[1] ?? "";
  const aNumber = aSuffix === "" ? -1 : Number(aSuffix);
  const bNumber = bSuffix === "" ? -1 : Number(bSuffix);
  return aNumber - bNumber || a.localeCompare(b);
}

function ruleNames(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isProjectRuleFileName(entry.name))
      .map((entry) => entry.name)
      .sort(ruleFileOrder);
  } catch {
    return [];
  }
}

/** Read editable bodies from one directory; used by both global and project GUI scopes. */
export function listRuleFiles(directory: string): readonly ProjectRuleFile[] {
  const files: ProjectRuleFile[] = [];
  for (const name of ruleNames(directory)) {
    try {
      files.push({
        name,
        content: readFileSync(join(directory, name), "utf-8"),
      });
    } catch {
      // Concurrent deletion is fail-open for the management UI.
    }
  }
  return files;
}

/** Read editable project rule bodies for the legacy/project GUI API. */
export function listProjectRuleFiles(
  workspaceRoot: string,
): readonly ProjectRuleFile[] {
  return listRuleFiles(projectHertaDir(workspaceRoot));
}

interface RuleLayer {
  readonly scope: "global" | "project";
  readonly directory: string;
  readonly filePrefix: string;
}

function loadRuleLayers(layers: readonly RuleLayer[]): ProjectRulesSnapshot {
  const groups: string[] = [];
  const files: string[] = [];
  let remaining = MAX_PROJECT_RULES_CHARS;
  let truncated = false;

  for (const layer of layers) {
    const sections: string[] = [];
    for (const name of ruleNames(layer.directory)) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      let content: string;
      try {
        content = readFileSync(join(layer.directory, name), "utf-8").trim();
      } catch {
        continue;
      }
      if (content === "") continue;
      const header = `## ${name}`;
      const available = Math.max(0, remaining - header.length - 2);
      if (available <= 0) {
        truncated = true;
        break;
      }
      const body = content.slice(
        0,
        Math.min(MAX_PROJECT_RULE_FILE_CHARS, available),
      );
      const bodyWasTruncated = body.length < content.length;
      sections.push(
        `${header}\n\n${body}${bodyWasTruncated ? "\n\n[规则内容已截断]" : ""}`,
      );
      files.push(`${layer.filePrefix}${name}`);
      remaining -= header.length + 2 + body.length;
      truncated ||= bodyWasTruncated;
    }
    if (sections.length > 0) {
      groups.push(
        [
          layer.scope === "global" ? "# 全局规则" : "# 项目规则",
          layer.scope === "global"
            ? "以下规则来自用户级 `~/.herta/rules*.md`，适用于全部工作区。"
            : "以下规则来自当前工作区的 `.herta/rules*.md`，必须作为项目级指令遵循。",
          ...sections,
        ].join("\n\n"),
      );
    }
  }
  return { text: groups.join("\n\n"), files, truncated };
}

/** Load only current-project rules; retained for callers deliberately omitting global scope. */
export function loadProjectRules(workspaceRoot: string): ProjectRulesSnapshot {
  return loadRuleLayers([
    {
      scope: "project",
      directory: projectHertaDir(workspaceRoot),
      filePrefix: "",
    },
  ]);
}

/**
 * Load user-wide rules first, then project rules. Project instructions therefore
 * occur later in both Herta and Brick contexts and win when they conflict.
 */
export function loadEffectiveRules(
  workspaceRoot: string,
  opts: {
    readonly home?: string;
    readonly hertaHome?: string | undefined;
  } = {},
): ProjectRulesSnapshot {
  return loadRuleLayers([
    { scope: "global", directory: hertaHomeDir(opts), filePrefix: "global/" },
    {
      scope: "project",
      directory: projectHertaDir(workspaceRoot),
      filePrefix: "project/",
    },
  ]);
}

/** Add prompt-ready rules to an existing Herta environment. */
export function withProjectRules(base: string, projectRules: string): string {
  if (projectRules === "") return base;
  return base === "" ? projectRules : `${base}\n\n${projectRules}`;
}
