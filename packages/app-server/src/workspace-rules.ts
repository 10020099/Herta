import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Only `rules.md`, `rules1.md`, `rules2.md`, … are project rule files. */
const PROJECT_RULE_FILE = /^rules(\d*)\.md$/;

/** A project-rule file is exactly `rules.md` or `rules` plus decimal digits. */
export function isProjectRuleFileName(name: string): boolean {
  return PROJECT_RULE_FILE.test(name);
}

export interface ProjectRuleFile {
  readonly name: string;
  readonly content: string;
}

/** Keeps one accidental or generated file from overwhelming the model prompt. */
export const MAX_PROJECT_RULE_FILE_CHARS = 20_000;
/** Caps the combined project-rule payload visible to each model request. */
export const MAX_PROJECT_RULES_CHARS = 50_000;

export interface ProjectRulesSnapshot {
  /** Prompt-ready, labeled project rules. Empty when the workspace has none. */
  readonly text: string;
  /** Rule files which contributed content, in the injected order. */
  readonly files: readonly string[];
  /** True when one or more bodies were capped to keep the prompt bounded. */
  readonly truncated: boolean;
}

function ruleFileOrder(a: string, b: string): number {
  const aSuffix = PROJECT_RULE_FILE.exec(a)?.[1] ?? "";
  const bSuffix = PROJECT_RULE_FILE.exec(b)?.[1] ?? "";
  // The unnumbered canonical file comes first; numbered files follow by their
  // numeric suffix, with lexical order as a deterministic tiebreaker.
  const aNumber = aSuffix === "" ? -1 : Number(aSuffix);
  const bNumber = bSuffix === "" ? -1 : Number(bSuffix);
  return aNumber - bNumber || a.localeCompare(b);
}

/**
 * Read the user-authored project rules from the effective workspace.
 *
 * This intentionally performs a fresh synchronous scan for every request:
 * editing `.herta/rules*.md` takes effect on the next Herta or Brick prompt
 * without requiring a session restart. Fail-open behavior keeps a transient
 * filesystem error from breaking an otherwise valid conversation.
 */
/** Read the full editable bodies for the GUI management surface. */
export function listProjectRuleFiles(
  workspaceRoot: string,
): readonly ProjectRuleFile[] {
  const rulesDir = join(workspaceRoot, ".herta");
  let names: string[];
  try {
    names = readdirSync(rulesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isProjectRuleFileName(entry.name))
      .map((entry) => entry.name)
      .sort(ruleFileOrder);
  } catch {
    return [];
  }
  const files: ProjectRuleFile[] = [];
  for (const name of names) {
    try {
      files.push({
        name,
        content: readFileSync(join(rulesDir, name), "utf-8"),
      });
    } catch {
      // A concurrently removed file simply no longer appears in the editor.
    }
  }
  return files;
}

export function loadProjectRules(workspaceRoot: string): ProjectRulesSnapshot {
  const rulesDir = join(workspaceRoot, ".herta");
  let names: string[];
  try {
    names = readdirSync(rulesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isProjectRuleFileName(entry.name))
      .map((entry) => entry.name)
      .sort(ruleFileOrder);
  } catch {
    return { text: "", files: [], truncated: false };
  }

  const sections: string[] = [];
  const files: string[] = [];
  let remaining = MAX_PROJECT_RULES_CHARS;
  let truncated = false;

  for (const name of names) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    let content: string;
    try {
      content = readFileSync(join(rulesDir, name), "utf-8").trim();
    } catch {
      // A concurrently deleted/unreadable rule must not fail the whole turn.
      continue;
    }
    if (content === "") continue;

    const header = `## ${name}`;
    const availableForBody = Math.max(0, remaining - header.length - 2);
    if (availableForBody <= 0) {
      truncated = true;
      break;
    }
    const cap = Math.min(MAX_PROJECT_RULE_FILE_CHARS, availableForBody);
    const body = content.slice(0, cap);
    const bodyWasTruncated = body.length < content.length;
    sections.push(
      `${header}\n\n${body}${bodyWasTruncated ? "\n\n[规则内容已截断]" : ""}`,
    );
    files.push(name);
    remaining -= header.length + 2 + body.length;
    truncated ||= bodyWasTruncated;
  }

  if (sections.length === 0) return { text: "", files: [], truncated };
  return {
    text: [
      "# 项目规则",
      "以下规则来自当前工作区的 `.herta/rules*.md`，必须作为项目级指令遵循。",
      ...sections,
    ].join("\n\n"),
    files,
    truncated,
  };
}

/** Add the prompt-ready project rules to an existing Herta environment. */
export function withProjectRules(base: string, projectRules: string): string {
  if (projectRules === "") return base;
  return base === "" ? projectRules : `${base}\n\n${projectRules}`;
}
