export interface GitStatusFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  origPath?: string;
}

export interface GitStatusData {
  branch: string | null;
  ahead: number;
  behind: number;
  files: readonly GitStatusFile[];
  clean: boolean;
}

export function parseStatusPorcelain(text: string): GitStatusData {
  const lines = text.split("\n");
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitStatusFile[] = [];

  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith("## ")) {
      const branchPart = line.slice(3);
      if (branchPart.startsWith("HEAD (no branch)")) {
        branch = null;
      } else {
        const trackingIdx = branchPart.indexOf("...");
        const nameEnd = trackingIdx >= 0 ? trackingIdx : branchPart.length;
        branch = branchPart.slice(0, nameEnd);
        const trackInfo = branchPart.match(/\[([^\]]+)\]/)?.[1];
        if (trackInfo) {
          const aheadMatch = trackInfo.match(/ahead (\d+)/);
          const behindMatch = trackInfo.match(/behind (\d+)/);
          if (aheadMatch?.[1]) ahead = Number.parseInt(aheadMatch[1], 10);
          if (behindMatch?.[1]) behind = Number.parseInt(behindMatch[1], 10);
        }
      }
      continue;
    }
    if (line.length < 3) continue;
    const indexStatus = line[0] ?? " ";
    const worktreeStatus = line[1] ?? " ";
    const rest = line.slice(3);
    if (indexStatus === "R" || indexStatus === "C") {
      const arrow = rest.indexOf(" -> ");
      if (arrow >= 0) {
        const origPath = rest.slice(0, arrow);
        const path = rest.slice(arrow + 4);
        files.push({ path, indexStatus, worktreeStatus, origPath });
        continue;
      }
    }
    files.push({ path: rest, indexStatus, worktreeStatus });
  }

  return {
    branch,
    ahead,
    behind,
    files,
    clean: files.length === 0,
  };
}
