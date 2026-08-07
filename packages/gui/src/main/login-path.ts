import { execFile } from "node:child_process";

/**
 * macOS login-shell PATH recovery (audit 2026-08-05, S7).
 *
 * A `.app` launched from Finder, Spotlight, or the Dock inherits launchd's
 * environment, not a shell's — PATH is roughly
 * `/usr/bin:/bin:/usr/sbin:/sbin`. Nothing a developer installed is on it:
 * Homebrew (`/opt/homebrew/bin`), nvm/fnm/volta node, pyenv, cargo, rustup,
 * or ripgrep. The same app launched from a terminal works perfectly, which is
 * exactly why this survives casual testing — and why CI cannot catch it
 * either: `mac-build.yml` starts the binary from a bash step that already has
 * the runner's full PATH.
 *
 * The consequences inside Herta are quiet rather than loud:
 *   - `run_command` spawns with `shell: false` and the inherited env, so
 *     `npm test` / `node script.js` / `cargo build` fail as "binary not found"
 *     for a user whose terminal runs them fine;
 *   - `detectRg()` probes bare `rg` ONCE and caches the null for the whole
 *     process lifetime, silently downgrading `search_text` to the slower JS
 *     walker for the rest of the session.
 *
 * So the harness recovers the PATH the user's shell would have, once, at
 * startup. This is HARNESS-set: it does not touch — and must not be confused
 * with — the model-facing `env` allowlist in tools/run-command/env-guard.ts.
 * The model still cannot set PATH; the app simply starts with the right one.
 *
 * Explicitly NOT fixed by running commands through a login shell: that would
 * reopen the shell-body classification class (audit S4) for every command.
 */

/** Where a login shell is asked for its PATH, bounded so a slow or broken
 *  rc file cannot delay startup. */
const PATH_PROBE_TIMEOUT_MS = 2000;

/** Entries worth keeping even if the login shell never answers — the common
 *  Homebrew prefixes, which is where `rg`/`node` usually live on a Mac. */
const DARWIN_FALLBACK = ["/opt/homebrew/bin", "/usr/local/bin"];

export interface LoginPathDeps {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Injected for tests; defaults to spawning the real login shell. */
  readonly probe?: (shell: string) => Promise<string | null>;
}

function realProbe(shell: string): Promise<string | null> {
  return new Promise((resolve) => {
    // -i (interactive) is deliberately omitted: it makes zsh source rc files
    // that may print, prompt, or hang. -l (login) picks up .zprofile /
    // .bash_profile, which is where PATH is normally set on macOS.
    const child = execFile(
      shell,
      ["-lc", 'printf %s "$PATH"'],
      { timeout: PATH_PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err !== null) {
          resolve(null);
          return;
        }
        const out = stdout.trim();
        resolve(out.length > 0 ? out : null);
      },
    );
    child.once("error", () => resolve(null));
  });
}

/** Merge `extra` into `base`, preserving base order and dropping duplicates
 *  and empties. Exported for testing. */
export function mergePath(
  base: string | undefined,
  extra: readonly string[],
): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...(base ?? "").split(":"), ...extra]) {
    const entry = p.trim();
    if (entry.length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.join(":");
}

/**
 * The PATH the app should run with, or null when nothing should change.
 * Never throws and never blocks longer than the probe timeout.
 */
export async function resolveLoginPath(
  deps: LoginPathDeps,
): Promise<string | null> {
  if (deps.platform !== "darwin") return null;
  const current = deps.env.PATH;
  // Launched from a terminal (or already repaired): a PATH carrying anything
  // beyond the launchd defaults needs no help.
  const looksInherited = current?.split(":").some((p) => {
    const e = p.trim();
    return (
      e.length > 0 &&
      e !== "/usr/bin" &&
      e !== "/bin" &&
      e !== "/usr/sbin" &&
      e !== "/sbin"
    );
  });
  if (looksInherited === true) return null;

  const shell = deps.env.SHELL ?? "/bin/zsh";
  const probe = deps.probe ?? realProbe;
  const fromShell = await probe(shell).catch(() => null);
  const merged = mergePath(current, [
    ...(fromShell === null ? [] : fromShell.split(":")),
    ...DARWIN_FALLBACK,
  ]);
  return merged === (current ?? "") ? null : merged;
}

/**
 * Applies the recovered PATH to this process, so every child spawned later
 * (run_command, the rg probe) inherits it. Call once, before the session
 * service is constructed — `detectRg` caches its result for the process
 * lifetime, so a later fix would not take effect.
 */
export async function applyLoginPath(
  deps: LoginPathDeps,
  setPath: (value: string) => void = (v) => {
    process.env.PATH = v;
  },
): Promise<string | null> {
  const next = await resolveLoginPath(deps);
  if (next !== null) setPath(next);
  return next;
}
