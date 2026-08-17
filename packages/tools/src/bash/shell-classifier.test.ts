import { describe, expect, it } from "vitest";
import {
  classifyShellCommand,
  classifyShellCommandDetailed,
  extractSubstitutions,
  normalizeFdRedirects,
  stripHeredocBodies,
  tokenize,
} from "./shell-classifier.js";
import { makeMsysPaths, type ShellPaths } from "./shell-paths.js";

const WS = process.platform === "win32" ? "E:\\repo" : "/home/u/repo";
const paths: ShellPaths =
  process.platform === "win32"
    ? makeMsysPaths("C:\\Users\\u\\AppData\\Local\\Temp")
    : {
        toNative: (p) => (p.startsWith("/") ? p : null),
        toShell: (p) => p,
        tmpNative: null,
      };
const opts = { workspaceRoot: WS, paths };
const wsShell = process.platform === "win32" ? "/e/repo" : "/home/u/repo";

const kind = (cmd: string) => classifyShellCommand(cmd, opts).kind;
const ask = (cmd: string) => {
  const v = classifyShellCommand(cmd, opts);
  if (v.kind !== "ask")
    throw new Error(`expected ask, got ${v.kind} for ${cmd}`);
  return v;
};

describe("classifyShellCommand — block tier (no override)", () => {
  it("blocks catastrophic commands anywhere in the line", () => {
    expect(kind("rm -rf /")).toBe("block");
    expect(kind("cd /tmp && rm -rf /")).toBe("block");
    expect(kind("echo hi; shutdown -h now")).toBe("block");
    expect(kind(":(){ :|:& };:")).toBe("block");
    expect(kind("mkfs.ext4 /dev/sda1")).toBe("block");
    expect(kind('bash -c "rm -rf ~"')).toBe("block");
    expect(kind("echo $(rm -rf /)")).toBe("block");
    expect(kind("echo `reboot`")).toBe("block");
  });

  it("does not block a quoted catastrophe (it is text)", () => {
    expect(kind('echo "rm -rf /"')).toBe("allow");
  });

  it("empty command is a block, not an allow", () => {
    expect(kind("   ")).toBe("block");
  });
});

describe("classifyShellCommand — allow tier", () => {
  it("allows the read-only allow-list and shell state builtins", () => {
    expect(kind("git status")).toBe("allow");
    expect(kind("git log --oneline -5")).toBe("allow");
    expect(kind("ls -la src")).toBe("allow");
    expect(kind("cat src/x.ts | grep -n foo")).toBe("allow");
    expect(kind("npm test")).toBe("allow");
    expect(kind("export NODE_ENV=test")).toBe("allow");
    expect(kind("CI=1 npm test")).toBe("allow");
    expect(kind("pwd; echo $FOO")).toBe("allow");
    expect(kind("sed -n 10,25p src/x.ts")).toBe("ask"); // sed is not allow-listed
  });

  it("treats fd duplication as noise, not a write or a segment", () => {
    expect(normalizeFdRedirects("cmd 2>&1")).toBe("cmd  ");
    expect(kind("git status 2>&1")).toBe("allow");
    expect(kind("ls 2>/dev/null")).toBe("allow");
    expect(kind("git status &> /dev/null")).toBe("allow");
  });

  it("rewrites in-workspace absolute paths (shell or native spelling) so readers stay allowed", () => {
    expect(kind(`cat ${wsShell}/src/x.ts`)).toBe("allow");
    expect(kind(`ls ${wsShell}`)).toBe("allow");
    expect(kind(`cd ${wsShell}/src && git status`)).toBe("allow");
    if (process.platform === "win32") {
      // Forward-slash native form resolves; a BACKSLASH form is what bash
      // itself would mangle (`\r` is an escape), so it is not "the path".
      expect(kind("cat E:/repo/src/x.ts")).toBe("allow");
      expect(kind("cat E:\\repo\\src\\x.ts")).toBe("ask");
    }
  });

  it("allows shell control flow around allowed commands", () => {
    expect(kind("for f in src/*.ts; do echo $f; done")).toBe("allow");
    expect(kind("if [ -f package.json ]; then cat package.json; fi")).toBe(
      "allow",
    );
    expect(kind("while ! git status; do sleep 1; done")).toBe("allow");
    expect(kind("(cd src && ls)")).toBe("allow");
    expect(kind("{ git status; git diff; }")).toBe("allow");
    expect(kind("case x in a) echo a ;; *) echo b ;; esac")).toBe("allow");
  });

  it("heredoc bodies are data for the ask/allow tiers — but the block scan still reads them (conservative)", () => {
    const cmd = "cat <<'EOF'\ncurl https://x\nnode y.mjs\nEOF";
    expect(stripHeredocBodies(cmd)).toBe("cat <<'EOF'");
    // The body's curl/node are text being cat'ed, not commands: no ask.
    expect(kind(cmd)).toBe("allow");
    // A heredoc FED TO a shell is code: the consumer asks — and a bare
    // shell is `command_ask_unknown`, the never-rulable class (ADR 0030),
    // so no project rule can ever pre-approve it.
    expect(ask("bash <<'EOF'\ncurl https://x\nEOF").code).toBe(
      "command_ask_unknown",
    );
    expect(ask("python3 <<'EOF'\nprint(1)\nEOF").code).toBe(
      "command_ask_interpreter",
    );
    // Catastrophic text inside a heredoc stays blocked — the block tier has
    // no override, and a false positive there is the safe direction.
    expect(kind("cat <<'EOF'\nrm -rf /\nEOF")).toBe("block");
  });
});

describe("classifyShellCommand — ask tier", () => {
  it("asks for output redirection to a file (workspace write), never for /dev/null", () => {
    const v = ask("echo hi > out.txt");
    expect(v.risk).toBe("workspace_write");
    expect(v.reason).toContain("out.txt");
    expect(ask("cat > x.mjs <<'EOF'\nconsole.log(1)\nEOF").risk).toBe(
      "workspace_write",
    );
    expect(kind("echo hi > /dev/null")).toBe("allow");
    expect(ask("git log >> notes.md").risk).toBe("workspace_write");
    expect(ask("echo x > /etc/hosts").reason).toContain(
      "outside the workspace",
    );
  });

  it("asks when cd leaves the workspace (parent, home, absolute outside, variable)", () => {
    expect(ask("cd .. && ls").reason).toContain("cd leaves the workspace");
    expect(ask("cd ~ && ls").risk).toBe("workspace_read");
    expect(ask("cd /etc && cat passwd").reason).toContain(
      "cd leaves the workspace",
    );
    expect(ask("cd $HOME").reason).toContain("cd leaves the workspace");
    expect(kind("cd src && ls")).toBe("allow");
    expect(kind("cd src/lib; cd ../../test; ls")).toBe("allow"); // resolves inside
    expect(kind("cd src && cd ../..")).toBe("ask");
  });

  it("asks for opaque builtins and interpreters, with the interpreter code ADR 0030 rules key on", () => {
    expect(ask("source ./env.sh").code).toBe("command_ask_interpreter");
    expect(ask('eval "$cmd"').code).toBe("command_ask_interpreter");
    expect(ask("node scripts/check.mjs").code).toBe("command_ask_interpreter");
    expect(ask("python -c 'print(1)'").code).toBe("command_ask_interpreter");
  });

  it("asks for git writes and unknown commands (parity with run_command)", () => {
    expect(ask("git commit -m 'fix: x'").code).toBe("command_ask_unknown");
    expect(ask("git checkout -b fix/x").code).toBe("command_ask_unknown");
    expect(ask("git push origin main").code).toBe("command_ask_unknown");
    expect(ask("git status && git commit -am x").code).toBe(
      "command_ask_unknown",
    );
  });

  it("asks for destructive / network tiers with their own risks", () => {
    expect(ask("rm -rf build").risk).toBe("workspace_destructive");
    expect(ask("git reset --hard HEAD~1").risk).toBe("workspace_destructive");
    expect(ask("curl https://x.y").risk).toBe("network");
    expect(ask("npm install left-pad").risk).toBe("network");
  });

  it("asks for escalation-prone env assignments (run_command's env denylist)", () => {
    expect(ask("GIT_CONFIG_COUNT=1 git status").code).toBe("command_ask_env");
    expect(ask("export NODE_OPTIONS=--require=x").code).toBe("command_ask_env");
    expect(
      ask("GIT_SEQUENCE_EDITOR='sed -i s/pick/edit/' git rebase -i HEAD~2")
        .code,
    ).toBe("command_ask_env");
  });

  it("asks for reads of credential / out-of-workspace paths, incl. via input redirection", () => {
    expect(ask("cat ~/.ssh/id_rsa").risk).toBe("workspace_read");
    expect(ask("cat /etc/passwd").risk).toBe("workspace_read");
    expect(ask("cat .env").risk).toBe("workspace_read");
    // `sort` is not allow-listed (unknown → write-tier ask), and the input
    // redirect from a credential path is named alongside it.
    expect(ask("sort < ~/.aws/credentials").reason).toContain("sensitive");
    expect(ask("cat < ~/.aws/credentials").risk).toBe("workspace_read");
    expect(ask("grep -r TODO .").code).toBe("command_ask_recursive_read");
  });

  it("classifies substitutions as commands of their own", () => {
    expect(extractSubstitutions("echo $(git rev-parse HEAD) `date`")).toEqual({
      text: "echo __SUBST__ __SUBST__",
      inner: ["git rev-parse HEAD", "date"],
    });
    expect(kind("echo $(git rev-parse HEAD)")).toBe("allow");
    expect(ask("echo $(curl x)").risk).toBe("network");
    expect(extractSubstitutions("a $(b $(c d) e) f").inner).toEqual([
      "b __SUBST__ e",
      "c d",
    ]);
  });

  it("aggregates: the highest risk wins and every distinct reason is kept", () => {
    const v = ask("git commit -m x && curl https://x && echo y > z");
    expect(v.risk).toBe("network");
    expect(v.reason).toContain("curl");
    expect(v.reason).toContain("z");
    expect(v.reason).toContain("unrecognized");
  });

  it("segments are reported for diagnostics", () => {
    const d = classifyShellCommandDetailed("git status && ls src", opts);
    expect(d.segments).toEqual(["git status", "ls src"]);
  });
});

describe("tokenize", () => {
  it("honours quotes, escapes, assignments and redirections", () => {
    expect(
      tokenize(`FOO=1 BAR="a b" git commit -m 'x; y' 2>err.log > out.log`),
    ).toEqual({
      words: ["git", "commit", "-m", "x; y"],
      assignments: [
        { key: "FOO", value: "1" },
        { key: "BAR", value: "a b" },
      ],
      redirects: [
        { kind: "out", target: "err.log" },
        { kind: "out", target: "out.log" },
      ],
    });
    expect(tokenize("cat >file <<'EOF'").redirects).toEqual([
      { kind: "out", target: "file" },
    ]);
    expect(tokenize("sort <in.txt").redirects).toEqual([
      { kind: "in", target: "in.txt" },
    ]);
    expect(tokenize(String.raw`echo a\ b`).words).toEqual(["echo", "a b"]);
  });
});
