import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The stylesheet's own bytes, read off disk.
 *
 * Not `new URL(..., import.meta.url)`: under the jsdom environment
 * `import.meta.url` is an http URL and readFileSync rejects the scheme. Not
 * `?raw`/`?inline` either — Vite's CSS pipeline claims the file and hands
 * back something other than the source text. So: cwd-relative, tolerating
 * either root vitest is started from (repo or package). */
const CSS = ((): string => {
  const rel = "src/renderer/styles/reference-ux.css";
  for (const base of [".", "packages/gui"]) {
    const p = resolve(process.cwd(), base, rel);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error("reference-ux.css not found from cwd");
})();

/**
 * The record's left edge is ONE token (`--record-left`), and this pins that
 * every lane starting at that edge derives from it.
 *
 * Why a source-level test: the bug (user 2026-07-30) was two lanes drifting
 * apart — Herta's bubbles sat 26px right of the 差分协处理器 row directly
 * under them, because the bubble kept the avatar gutter of the lifted UX_v5
 * stylesheet after the avatars were removed. Nothing could catch it: jsdom
 * applies no stylesheet and cannot resolve `var()` in getComputedStyle, so a
 * rendered-geometry assertion is not available here (the alignment itself was
 * verified live against the real renderer). What IS checkable, and is exactly
 * what failed for months, is that the two declarations still refer to the
 * same source of truth rather than two independently-tuned numbers.
 */

/** The body of the first `selector { … }` block, or null. */
function ruleBody(selector: string): string | null {
  // Anchored at a line start so `.activity-line` cannot match
  // `.activity-line-row` or a descendant selector ending in the same text.
  const re = new RegExp(
    `^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "m",
  );
  return re.exec(CSS)?.[1] ?? null;
}

describe("the record's left edge is one token", () => {
  it("defines --record-left", () => {
    expect(CSS).toMatch(/--record-left:\s*8px;/);
  });

  it("Herta's bubble row starts at it (not the old 34px avatar gutter)", () => {
    const body = ruleBody(".herta-row");
    expect(body).not.toBeNull();
    // margin: <top> <right> <bottom> <left>
    expect(body).toMatch(/margin:\s*22px\s+0\s+34px\s+var\(--record-left/);
    // The gutter that made her bubbles hang right of the activity row.
    expect(body).not.toMatch(/margin:[^;]*\b34px\s+34px/);
  });

  it("the activity row starts at it (LED glow clearance = the same edge)", () => {
    const body = ruleBody(".activity-line");
    expect(body).not.toBeNull();
    expect(body).toMatch(/padding:\s*3px\s+0\s+3px\s+var\(--record-left/);
  });

  it("the LED-centre gutters derive from it, so they track the edge", () => {
    // The history panel's rule and the plan strip's hairline both hang from
    // the LED's centre (edge + half the 7px dot). Hard-coded at 11px they
    // would drift the moment the edge moved.
    for (const selector of [
      ".activity-line__history-inner",
      ".activity-plan",
    ]) {
      const body = ruleBody(selector);
      expect(body, selector).not.toBeNull();
      expect(body, selector).toMatch(
        /margin:[^;]*calc\(var\(--record-left[^)]*\)\s*\+\s*3px\)/,
      );
    }
  });
});
