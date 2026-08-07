import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TmpWorkspaceFiles {
  [relPath: string]: string | Uint8Array;
}

export interface TmpWorkspace {
  root: string;
  cleanup: () => Promise<void>;
}

export async function mkTmpWorkspace(
  files: TmpWorkspaceFiles,
): Promise<TmpWorkspace> {
  const raw = await mkdtemp(join(tmpdir(), "herta-tools-"));
  const root = await realpath(raw);

  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

  const cleanup = async () => {
    await rm(root, { recursive: true, force: true });
  };

  return { root, cleanup };
}
