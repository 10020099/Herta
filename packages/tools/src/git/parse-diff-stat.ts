export interface GitDiffFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface ParseDiffStatResult {
  files: readonly GitDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

export function parseDiffStat(text: string): ParseDiffStatResult {
  if (text.length === 0) {
    return { files: [], totalAdditions: 0, totalDeletions: 0 };
  }
  const lines = text.split("\n");
  const files: GitDiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const raw of lines) {
    if (raw.length === 0) continue;
    if (/files? changed/.test(raw) && raw.includes(",")) continue;
    const pipeIdx = raw.indexOf("|");
    if (pipeIdx < 0) continue;
    const path = raw.slice(0, pipeIdx).trim();
    const right = raw.slice(pipeIdx + 1).trim();
    if (path.length === 0) continue;

    let additions = 0;
    let deletions = 0;
    if (right.startsWith("Bin")) {
      // Binary file — keep counts at zero
    } else {
      for (const ch of right) {
        if (ch === "+") additions += 1;
        else if (ch === "-") deletions += 1;
      }
    }
    files.push({ path, additions, deletions });
    totalAdditions += additions;
    totalDeletions += deletions;
  }

  return { files, totalAdditions, totalDeletions };
}
