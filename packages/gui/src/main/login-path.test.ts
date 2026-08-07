import { describe, expect, it } from "vitest";
import { applyLoginPath, mergePath, resolveLoginPath } from "./login-path.js";

/** launchd's environment for a Finder-launched .app — the S7 starting point. */
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** What a real login shell answers on a dev Mac. */
const SHELL_PATH =
  "/opt/homebrew/bin:/Users/x/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin";

describe("mergePath", () => {
  it("keeps base order, appends new entries, drops duplicates and blanks", () => {
    expect(mergePath("/a:/b", ["/b", "/c", "", "  "])).toBe("/a:/b:/c");
  });

  it("handles an absent base", () => {
    expect(mergePath(undefined, ["/opt/homebrew/bin"])).toBe(
      "/opt/homebrew/bin",
    );
  });
});

describe("resolveLoginPath", () => {
  it("recovers the login shell's PATH for a Finder-launched .app", async () => {
    const got = await resolveLoginPath({
      platform: "darwin",
      env: { PATH: LAUNCHD_PATH, SHELL: "/bin/zsh" },
      probe: async () => SHELL_PATH,
    });
    expect(got).not.toBeNull();
    // The tools that were unreachable are now on it…
    expect(got).toContain("/opt/homebrew/bin");
    expect(got).toContain("/Users/x/.cargo/bin");
    // …and the system entries are still there, exactly once.
    expect(got).toContain("/usr/bin");
    expect(got?.split(":").filter((p) => p === "/usr/bin")).toHaveLength(1);
  });

  it("does nothing off darwin", async () => {
    expect(
      await resolveLoginPath({
        platform: "win32",
        env: { PATH: "C:\\Windows" },
        probe: async () => "should-not-be-called",
      }),
    ).toBeNull();
    expect(
      await resolveLoginPath({
        platform: "linux",
        env: { PATH: LAUNCHD_PATH },
        probe: async () => SHELL_PATH,
      }),
    ).toBeNull();
  });

  it("does nothing when launched from a terminal (PATH already real)", async () => {
    // The common case for a developer running the dev build — must not churn
    // the environment underneath a working setup.
    expect(
      await resolveLoginPath({
        platform: "darwin",
        env: { PATH: SHELL_PATH, SHELL: "/bin/zsh" },
        probe: async () => {
          throw new Error("probe must not run when PATH is already populated");
        },
      }),
    ).toBeNull();
  });

  it("still adds the Homebrew fallbacks when the login shell fails", async () => {
    // A broken/hanging rc file must not leave the app with launchd's PATH.
    const got = await resolveLoginPath({
      platform: "darwin",
      env: { PATH: LAUNCHD_PATH, SHELL: "/bin/zsh" },
      probe: async () => null,
    });
    expect(got).toContain("/opt/homebrew/bin");
    expect(got).toContain("/usr/local/bin");
    expect(got).toContain("/usr/bin");
  });

  it("survives a probe that throws", async () => {
    const got = await resolveLoginPath({
      platform: "darwin",
      env: { PATH: LAUNCHD_PATH, SHELL: "/bin/zsh" },
      probe: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(got).not.toBeNull();
    expect(got).toContain("/opt/homebrew/bin");
  });

  it("defaults to zsh when SHELL is unset (launchd often omits it)", async () => {
    let asked: string | null = null;
    await resolveLoginPath({
      platform: "darwin",
      env: { PATH: LAUNCHD_PATH },
      probe: async (shell) => {
        asked = shell;
        return SHELL_PATH;
      },
    });
    expect(asked).toBe("/bin/zsh");
  });
});

describe("applyLoginPath", () => {
  it("writes the recovered PATH so later children inherit it", async () => {
    let written: string | null = null;
    const got = await applyLoginPath(
      {
        platform: "darwin",
        env: { PATH: LAUNCHD_PATH, SHELL: "/bin/zsh" },
        probe: async () => SHELL_PATH,
      },
      (v) => {
        written = v;
      },
    );
    expect(written).toBe(got);
    expect(written).toContain("/opt/homebrew/bin");
  });

  it("leaves the environment untouched when there is nothing to do", async () => {
    let written: string | null = null;
    await applyLoginPath(
      {
        platform: "win32",
        env: { PATH: "C:\\Windows" },
      },
      (v) => {
        written = v;
      },
    );
    expect(written).toBeNull();
  });
});
