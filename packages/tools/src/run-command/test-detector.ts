import type { TestRunSummary } from "@herta/core";

/**
 * Returns true if the argv matches a recognized test runner pattern.
 * Subset of run-command's classifier.ts allow-list — deliberately
 * excludes lint, build, install, and check commands. Detection is
 * purely structural (argv[0]/argv[1]/argv[2] inspection); no flag-
 * suppression for things like `--listTests` in MVP.
 */
export function isTestCommand(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const a0 = argv[0];
  if (a0 === "pytest") return true;
  if (a0 === "cargo" && argv[1] === "test") return true;
  if (a0 === "go" && argv[1] === "test") return true;
  if (a0 === "npm" || a0 === "pnpm") {
    if (argv[1] === "test") return true;
    if (argv[1] === "run" && argv[2] === "test") return true;
  }
  return false;
}

export interface TestRunInput {
  argv: readonly string[];
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Detects whether a run_command invocation was a test runner; if so,
 * returns a TestRunSummary derived from the exit code (exit 0 → passed,
 * else → failed). Returns null for non-test commands. The skipped /
 * not_run union members on TestRunSummary stay reachable for future
 * use cases (e.g., a planner that records "I planned tests but didn't
 * run them") but never fire on the run_command path.
 */
export function detectTestRun(input: TestRunInput): TestRunSummary | null {
  if (!isTestCommand(input.argv)) return null;
  const status: TestRunSummary["status"] =
    input.exitCode === 0 && !input.timedOut ? "passed" : "failed";
  const command = input.argv.join(" ");
  const summary = formatTestSummary(input);
  return { command, status, summary };
}

function formatTestSummary(input: TestRunInput): string {
  const sec = (input.durationMs / 1000).toFixed(2);
  const exitPart = input.timedOut
    ? "timed out"
    : `exit ${input.exitCode === null ? "null" : input.exitCode}`;
  return `${exitPart}, ${sec}s`;
}
