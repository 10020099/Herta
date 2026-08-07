import { spawn } from "node:child_process";

export interface SpawnGitOk {
  ok: true;
  stdout: string;
}

export type SpawnGitErr =
  | { ok: false; code: "not_a_repo"; message: string }
  | {
      ok: false;
      code: "git_failed";
      message: string;
      exitCode: number | null;
      stderr: string;
    }
  | { ok: false; code: "spawn_failed"; message: string };

/** The AbortError `run_command` throws for the same case — the turn loop
 *  classifies the turn as INTERRUPTED off this, instead of recording a tool
 *  failure that never happened. */
function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

const MAX_BUF = 4 * 1024 * 1024;

export async function spawnGit(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<SpawnGitOk | SpawnGitErr> {
  return new Promise((resolve, reject) => {
    // Already cancelled before we spawn — never report that as a git problem.
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, {
        cwd,
        signal,
        shell: false,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
    } catch (err) {
      resolve({
        ok: false,
        code: "spawn_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let resolved = false;

    const settle = (result: SpawnGitOk | SpawnGitErr): void => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };
    /** An interrupt is NOT a tool failure (audit 2026-07-24, 1.8). Node emits
     *  the same `error` event with an AbortError when the spawn signal fires,
     *  so the old catch-all turned a user's Stop into
     *  `{code:"spawn_failed"}` — which the callers render as the fabricated
     *  "git is not on PATH", append to the backend transcript, and feed to the
     *  model as working history. Because the tool RESOLVED, the turn loop
     *  never classified the turn as interrupted either. Rejecting propagates
     *  the cancellation exactly as `run_command` does. */
    const settleAborted = (): void => {
      if (resolved) return;
      resolved = true;
      reject(abortError());
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutLen + chunk.length > MAX_BUF) return;
      stdoutChunks.push(chunk);
      stdoutLen += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrLen + chunk.length > MAX_BUF) return;
      stderrChunks.push(chunk);
      stderrLen += chunk.length;
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      // Checked FIRST: an abort surfaces here as a plain `error` event, and
      // the ENOENT arm below would otherwise be the only branch that even
      // looked at `code` — everything else fell through to spawn_failed.
      if (signal.aborted || err.name === "AbortError") {
        settleAborted();
        return;
      }
      if (err.code === "ENOENT") {
        settle({
          ok: false,
          code: "spawn_failed",
          message: "git binary not found on PATH",
        });
        return;
      }
      settle({
        ok: false,
        code: "spawn_failed",
        message: err.message,
      });
    });

    child.on("close", (code) => {
      // A kill-by-signal from the abort closes the child with a null/non-zero
      // code and no stderr; without this it read as `git_failed`.
      if (signal.aborted) {
        settleAborted();
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) {
        settle({ ok: true, stdout });
        return;
      }
      if (code === 128 && /not a git repository/i.test(stderr)) {
        settle({
          ok: false,
          code: "not_a_repo",
          message: stderr.trim() || "not a git repository",
        });
        return;
      }
      settle({
        ok: false,
        code: "git_failed",
        message: stderr.trim() || `git exited with code ${code}`,
        exitCode: code,
        stderr,
      });
    });
  });
}
