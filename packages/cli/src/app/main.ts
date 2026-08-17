import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  BackendContextBuilder,
  type BackendContract,
  CodingAgentRuntime,
  dreamDirFor,
  ensureHertaGitignore,
  InMemoryEventBus,
  InMemoryToolRegistry,
  listSessions,
  narrativeDirFor,
  ProjectCommandRuleStore,
  RulePermissionEngine,
  readSessionFile,
  resolveEffectiveWorkspace,
  SessionApprovalCache,
  SessionFileError,
  wireTaskScopedApprovalCache,
} from "@herta/core";
import {
  buildRecapRuntime,
  buildStaticHertaPrefix,
  loadActorHints,
  loadMetaThinkCorpus,
  materializeSeedFeian,
  type PromptLang,
  pickOpening,
  readRecapCache,
  type StaticHertaPrefix,
  supervisorReferenceFor,
  V2ActorDriver,
} from "@herta/herta";
import {
  readManifest,
  resolveDreamConfig,
  selectPromptExclusions,
} from "@herta/knowledge";
import { FileMemoryManager } from "@herta/memory";
import {
  deepseekCompletionProvider,
  deepseekProvider,
  resolveDeepSeekKey,
} from "@herta/providers";
import {
  canonicalWorkspaceRoot,
  createMinimalTools,
  createMvpTools,
  findBash,
  PersistentShell,
  registerEditFileRule,
  registerMinimalRules,
  registerRunCommandRule,
  registerWriteNewFileRule,
  shellWorkspaceHint,
} from "@herta/tools";
import { CachingAskResolver } from "../render/caching-ask-resolver.js";
import { NarrativeRenderer } from "../render/narrative-renderer.js";
import { CliAskResolver } from "../render/permission-prompt.js";
import { makeStyle } from "../render/style.js";
import { Input } from "../repl/input.js";
import { repl } from "../repl/repl.js";
import { V2RecordPersister } from "../repl/v2-record-persister.js";
import {
  parseArgs,
  parseThinking,
  printUsage,
  printVersion,
} from "./config.js";

export interface MainDeps {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  cwd?: string;
  homedir?: string;
}

export async function main(
  argv: string[],
  deps?: Partial<MainDeps>,
): Promise<number> {
  const stdin = deps?.stdin ?? process.stdin;
  const stdout = deps?.stdout ?? process.stdout;
  const stderr = deps?.stderr ?? process.stderr;

  const args = parseArgs(argv);
  if (args.help) {
    printUsage(stdout);
    return 0;
  }
  if (args.version) {
    printVersion(stdout);
    return 0;
  }

  // Interaction language — the language Herta talks in (prompt assets, seed
  // 废案, openings, recap/title, actor hints). Per-invocation flag; the CLI
  // has no per-user config file, and the static prefix is per-session anyway,
  // so a flag is the natural scope. Default "zh". Canonical record tokens
  // (（我 说）, → 系统, → 差分协处理器) stay CN in both modes (D2/D7/D8).
  let lang: PromptLang = "zh";
  if (args.lang !== undefined) {
    if (args.lang !== "zh" && args.lang !== "en") {
      stderr.write(`herta: --lang: expected zh or en, got '${args.lang}'\n`);
      return 2;
    }
    lang = args.lang;
  }

  // Canonical (audit S8): resolveSafePath realpaths every candidate file and
  // prefix-compares it against this root, so a cwd reached through a symlink
  // — `cd /tmp/proj` on macOS is the everyday case — would deny every file
  // operation as outside the workspace.
  const workspaceRoot = canonicalWorkspaceRoot(deps?.cwd ?? process.cwd());
  const transcriptDir = join(workspaceRoot, ".herta", "transcript", "v2");
  // `.herta` holds transcripts (the user's own words), command logs, tool
  // results and permission grants, right beside their source. Self-ignore it
  // before anything writes there (audit BL6).
  ensureHertaGitignore(workspaceRoot);

  // Resolve --resume target early (before the API key check) so that a bad
  // prefix fails fast without a key lookup.
  let resumeTarget:
    | {
        sessionFile: string;
        record: import("@herta/core").TerminalRecord;
        sessionId: string;
        // Stashed from the single load below so the workspace resolver does not
        // re-parse the whole (multi-MB) transcript a second time on boot.
        meta: ReturnType<typeof readSessionFile>["meta"];
        latestWorkspaceSet: ReturnType<
          typeof readSessionFile
        >["latestWorkspaceSet"];
      }
    | undefined;
  if (args.resume !== undefined) {
    const candidates = listSessions({
      transcriptDir,
      currentWorkspaceRoot: workspaceRoot,
      allWorkspaces: true,
      limit: Number.POSITIVE_INFINITY,
    });
    let chosenFile: string | undefined;
    if (args.resume === "latest") {
      const workspaceOnly = candidates.filter(
        (c) => c.workspaceRoot === workspaceRoot,
      );
      if (workspaceOnly.length === 0) {
        stderr.write(
          `herta: --resume latest: no sessions in this workspace yet\n`,
        );
        return 2;
      }
      const latestEntry = workspaceOnly[0];
      if (latestEntry === undefined) return 2; // unreachable after length check
      chosenFile = latestEntry.sessionFile;
    } else {
      // Prefix match: workspace first, then across workspaces.
      const prefix = args.resume;
      const workspaceMatches = candidates
        .filter((c) => c.workspaceRoot === workspaceRoot)
        .filter((c) => c.sessionId.startsWith(prefix));
      const matches =
        workspaceMatches.length > 0
          ? workspaceMatches
          : candidates.filter((c) => c.sessionId.startsWith(prefix));
      if (matches.length === 0) {
        stderr.write(`herta: --resume: no session matching '${args.resume}'\n`);
        return 2;
      }
      if (matches.length > 1) {
        stderr.write(
          `herta: --resume: ambiguous prefix '${args.resume}' — ${matches.length} matches:\n`,
        );
        for (const c of matches.slice(0, 10)) {
          stderr.write(`  ${c.sessionId}\n`);
        }
        return 2;
      }
      const singleMatch = matches[0];
      if (singleMatch === undefined) return 2; // unreachable after length check
      chosenFile = singleMatch.sessionFile;
    }
    try {
      const loaded = readSessionFile(chosenFile);
      resumeTarget = {
        sessionFile: chosenFile,
        record: loaded.record,
        sessionId: loaded.meta.sessionId,
        meta: loaded.meta,
        latestWorkspaceSet: loaded.latestWorkspaceSet,
      };
    } catch (err) {
      if (err instanceof SessionFileError) {
        stderr.write(`herta: --resume: ${err.message}\n`);
        return 2;
      }
      throw err;
    }
  }

  // Pin a resumed session to the language it was CREATED under (persisted in
  // the header) — mirrors the GUI host's header-wins rule (app-server
  // session-host.ts). The flag governs NEW sessions only; on resume it is just
  // the fallback for legacy headers written before per-session persistence.
  // An explicit conflicting flag is NOT obeyed: flipping mid-record splits the
  // prompt language from the record language (zh prompts over an EN record —
  // the exact drift ADR 0014 pins against), and worse, silently changes which
  // dream corpus/manifest the session reads and later distills into.
  if (resumeTarget?.meta.lang !== undefined) {
    if (args.lang !== undefined && args.lang !== resumeTarget.meta.lang) {
      stderr.write(
        `herta: --resume: session was created as ${resumeTarget.meta.lang}; ignoring --lang ${args.lang} (per-session language is pinned)\n`,
      );
    }
    lang = resumeTarget.meta.lang;
  }

  let apiKey: string;
  try {
    apiKey = await resolveDeepSeekKey({
      cwd: deps?.cwd,
      homedir: deps?.homedir,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`herta: ${msg}\n`);
    return 2;
  }

  // Dev chaos/staging lever (E2E-4 failure injection): the CLI is repo-run
  // dev tooling, so a plain env override is acceptable here — the GUI gates
  // the same knob on !app.isPackaged (see gui session-service.ts).
  const devBaseUrl = process.env.HERTA_DEEPSEEK_BASE_URL;
  const baseUrl =
    devBaseUrl !== undefined && devBaseUrl !== ""
      ? { baseUrl: devBaseUrl }
      : {};
  const backendProvider = deepseekProvider({
    apiKey,
    model: process.env.HERTA_BACKEND_MODEL ?? "deepseek-v4-pro",
    // Default "high". HERTA_BACKEND_THINKING accepts low/high/max/false —
    // note deepseek-v4-pro maps a sent "low" to "high" server-side until
    // its announced early-August-2026 update (flash already honors it).
    thinking:
      parseThinking(process.env.HERTA_BACKEND_THINKING, stderr) ?? "high",
    ...baseUrl,
  });
  const isTty =
    typeof (stdout as { isTTY?: boolean }).isTTY === "boolean" &&
    (stdout as { isTTY?: boolean }).isTTY === true;
  const style = makeStyle({ enabled: isTty && !process.env.NO_COLOR });

  // Single mutable holder for the effective backend workspace. Shared by
  // the factory closure below (read fresh per dispatch), the project
  // command-rule store, and the repl's SlashContext (mutated by
  // `/workspace set|reset`). Seeded from the effective workspace: cwd for a
  // fresh session, the resolved root for a resume (latest workspace_set →
  // header backendWorkspace → workspaceRoot).
  // NEVER reassign `wsHolder` — only mutate `wsHolder.current` so every
  // holder reader observes the change. (Declared before the permission
  // stack: the rule store reads it per ask.)
  const wsHolder = {
    current:
      resumeTarget !== undefined
        ? // Reuse the meta + latestWorkspaceSet captured at load time above —
          // no second readSessionFile (which re-parses the whole transcript).
          resolveEffectiveWorkspace(
            resumeTarget.meta,
            resumeTarget.latestWorkspaceSet,
          )
        : workspaceRoot,
  };

  const approvalCache = new SessionApprovalCache();
  // Project-scoped command allow rules (ADR 0030) — persisted under the
  // EFFECTIVE workspace's .herta/permissions.json.
  const commandRules = new ProjectCommandRuleStore(() => wsHolder.current);
  const cliAsk = new CliAskResolver(stdin as NodeJS.ReadStream, stdout, style);
  const ask = new CachingAskResolver(
    cliAsk,
    approvalCache,
    stdout,
    style,
    commandRules,
  );
  const permissions = new RulePermissionEngine({ ask });

  const memory = new FileMemoryManager({ workspaceRoot });

  // Single shared bus across actor, backend, transcript renderer, dialogue
  // renderer, permission rules.
  const bus = new InMemoryEventBus<AgentEvent>();
  // Task-scope approval lifetime (ADR 0026): the remember cache clears when
  // each backend brief ends, so a [a] remember never outlives the task.
  wireTaskScopedApprovalCache(bus, approvalCache);

  // Backend's tool registry (ADR 0040): the standard 15-tool set, or — with
  // HERTA_BACKEND_CONTRACT=minimal and a bash on this machine — the trained
  // two-tool shape (+ the two record channels). The CLI takes the knob from
  // the environment like its model knobs; the GUI has a Settings row.
  const wantMinimal = process.env.HERTA_BACKEND_CONTRACT === "minimal";
  const bashPath = wantMinimal ? findBash() : null;
  const backendContract: BackendContract =
    wantMinimal && bashPath !== null ? "minimal" : "standard";
  if (wantMinimal && bashPath === null) {
    stderr.write(
      "herta: HERTA_BACKEND_CONTRACT=minimal but no bash found (install Git for Windows or set HERTA_BASH); running the standard contract\n",
    );
  }
  const backendTools = new InMemoryToolRegistry();
  const workspaceShellPath = (): string =>
    bashPath === null
      ? wsHolder.current
      : new PersistentShell({ bashPath, workspaceRoot: wsHolder.current })
          .workspaceShellPath;
  if (backendContract === "minimal") {
    for (const t of createMinimalTools({
      bashPath: bashPath as string,
      workspaceShellPath,
    }))
      backendTools.register(t);
  } else {
    for (const t of createMvpTools()) backendTools.register(t);
  }

  // Backend builder for prompt-frame construction.
  const backendBuilder = new BackendContextBuilder({
    tools: backendTools,
    contract: backendContract,
    workspaceHint: () =>
      backendContract === "minimal"
        ? shellWorkspaceHint(bashPath, wsHolder.current, lang)
        : undefined,
  });

  // Factory: per-invocation CodingAgentRuntime. Each run_coding_task call
  // gets a fresh one (per ADR 0007). Reads `wsHolder.current` at call time
  // so `/workspace set` takes effect on the next `@板砖` dispatch.
  const codingAgentFactory = (): CodingAgentRuntime =>
    new CodingAgentRuntime({
      sessionId: randomUUID(),
      provider: backendProvider,
      tools: backendTools,
      permissions,
      backendBuilder,
      bus,
      clock: () => new Date(),
      workspaceRoot: wsHolder.current,
      memory,
    });

  // Actor session ID — for new sessions, a fresh uuid; for resumes, the
  // original session's id from the loaded file's header. Reusing the
  // original id keeps tool-log filenames correlated across resumes
  // (e.g., .herta/logs/<sessionId>-<callId>.log).
  const actorSessionId = resumeTarget?.sessionId ?? randomUUID();

  // Construct the persister: new file for fresh sessions, append-only for
  // resumes (header already on disk).
  const persister =
    resumeTarget === undefined
      ? V2RecordPersister.forNewSession({
          sessionId: actorSessionId,
          workspaceRoot,
          startedAt: new Date(),
          transcriptDir,
          // Birth language into the header (ADR 0014): reopens pin to it, the
          // GUI sidebar/store classify by it, and the dream pass groups by it
          // — a lang-less EN header would be distilled by the ZH pass.
          lang,
        })
      : V2RecordPersister.forResume({
          sessionFile: resumeTarget.sessionFile,
        });

  // Herta the actor no longer has any inline tools (2026-05-23 sweep —
  // file reads / directory listings are delegated to the backend via
  // `@板砖`). The empty registry exists only so the `/tools` slash
  // command can render with no entries; the backend's full tool set
  // is owned by `backendTools` and remains the source of truth for
  // what the coding agent can do.
  const actorTools = new InMemoryToolRegistry();

  // Permission rules attach to the shared engine.
  if (backendContract === "minimal") {
    registerMinimalRules(permissions, { bus, bashPath });
  } else {
    registerEditFileRule(permissions, { bus });
    registerWriteNewFileRule(permissions, { bus });
    registerRunCommandRule(permissions);
  }

  const input = new Input(stdin as NodeJS.ReadStream, stdout);

  // Fresh-workspace bootstrap (M-prompts-1): materialize the compiled seed
  // 废案 into the live narrative dir so the static prefix below finds a
  // starting memory corpus. No-op once ANY 废案 exists.
  await materializeSeedFeian(workspaceRoot, lang);

  // Reopen own-dream filter: on --resume, 废案 distilled from THIS session's
  // episodes stay out of the prefix while their source content is still
  // verbatim in the loaded record (behind the recap boundary they return as
  // recovered memory). Fail-open — any error means no exclusions.
  let excludeFewShotFiles: ReadonlySet<string> | undefined;
  if (resumeTarget !== undefined) {
    try {
      const record = resumeTarget.record;
      // Mirror the recap runtime's cache validation: a cached boundary must
      // index a user block inside this record, else the runtime treats the
      // session as uncompacted — the prefix filter must see the same view.
      const cached =
        readRecapCache(workspaceRoot, resumeTarget.sessionId)?.boundaryIndex ??
        0;
      const recapBoundaryIndex =
        cached > 0 && cached < record.length && record[cached]?.kind === "user"
          ? cached
          : 0;
      const excluded = selectPromptExclusions({
        // Lang-aware dream manifest — an EN session must read its own dream
        // corpus (.herta/dream-en), not the zh one (mirrors app-server
        // session.ts:285). Hardcoding the zh dir here fed an --lang en session
        // the wrong dream exclusions (same split-brain class fixed for the GUI).
        manifest: readManifest(dreamDirFor(workspaceRoot, lang)),
        sessionId: resumeTarget.sessionId,
        record,
        recapBoundaryIndex,
        config: resolveDreamConfig(),
      });
      if (excluded.size > 0) excludeFewShotFiles = excluded;
    } catch {
      // fall through with no exclusions
    }
  }

  // v0.2 path — narrative-completion actor via V2ActorDriver.
  const staticPrefix = await buildStaticHertaPrefix({
    workspaceRoot,
    lang,
    // A dropped few-shot (audit BL3) is otherwise invisible — the prefix just
    // silently loses a memory. stderr, not the record: this is a fact about
    // the workspace's files, not something Herta observed.
    onFewShotDropped: (name, reason) => {
      stderr.write(`herta: skipped ${name} — ${reason}\n`);
    },
    readFile: async (relPath) =>
      readFile(join(workspaceRoot, relPath), "utf-8"),
    readNarrativeDir: async () => {
      try {
        // Lang-aware living-memory 废案 dir — an EN session reads its own
        // few-shots (.herta/narrative-en), not the zh corpus. Must stay
        // consistent with buildStaticHertaPrefix's lang-derived relPath prefix
        // (mirrors app-server session.ts:1117).
        return await readdir(narrativeDirFor(workspaceRoot, lang));
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "ENOENT") return [];
        throw err;
      }
    },
    ...(excludeFewShotFiles !== undefined ? { excludeFewShotFiles } : {}),
  });

  // Pick an opening for new sessions only. Resumed sessions skip this —
  // the loaded record already contains its own seed block as block 0.
  // The corpus is compiled in (M-prompts-1): no disk I/O, no failure path.
  const opening: ReturnType<typeof pickOpening> =
    resumeTarget === undefined ? pickOpening({ lang }) : undefined;

  // Effective static prefix: append the opening's preamble after the
  // cache-stable head if we picked one. The preamble is session-zero
  // scaffolding visible only to the model — not persisted, not rendered.
  // The `### 此刻` marker parallels the few-shot corpus convention
  // (`### 废案：xxx`, `### 记录：xxx`) and frames the preamble as the
  // current scene Herta finds herself in, just before the running record.
  //
  // Driver now accepts `StaticHertaPrefix` directly. The opening
  // preamble (when present) lands on the `opening` field; the
  // serializer prepends `### 此刻\n\n` at flatten time.
  const effectiveStaticPrefix: StaticHertaPrefix =
    opening !== undefined
      ? { ...staticPrefix, opening: opening.preamble }
      : staticPrefix;

  // Completion-mode provider for the v0.2 actor.
  const completionProvider = deepseekCompletionProvider({ apiKey, ...baseUrl });

  // Slice 13: meta-think corpus (mood routing). Loaded once at startup;
  // missing files yield empty strings and the actor falls back to
  // Slice 10 single-phase mode for that iteration.
  const metaThinkCorpus = loadMetaThinkCorpus(lang);
  const actorHints = loadActorHints(lang);

  // Slice 13 (chat-mode escalation): router uses a dedicated chat-mode
  // provider with thinking enabled. The previous completion-mode router
  // (sharing the actor's completionProvider) could not classify reliably
  // — non-thinking flash either collided with the stop sequence to
  // produce empty output, or emitted schema-descriptive metalanguage
  // instead of an actual state name. Thinking-mode chat gives the
  // model enough cognitive headroom to follow the classifier
  // instructions.
  //
  // Pinned to deepseek-v4-flash with thinking="low" — since the 2026-07-31
  // DeepSeek update flash takes "low" | "high" | "max", and a 7-class mood
  // pick needs thinking MODE (the non-thinking completion router was
  // retired for unreliability, see above) but not depth. Not
  // operator-tunable; raise back to "high" here if routing regresses.
  const routerProvider = deepseekProvider({
    apiKey,
    model: "deepseek-v4-flash",
    thinking: "low",
    ...baseUrl,
  });

  // Supervisor keeps "high" — it is a precision gate (receipt-claim and
  // dispatch checks already miss buried-rule shapes ~1/3 at high; see the
  // 2026-07-29 trigger-gate finding), so it no longer shares the router's
  // now-cheaper adapter. Same model, own thinking budget. The recap
  // summarizer below rides this adapter for the same reason.
  // See SPEC v0.2 Supervisor design §3.4.
  const supervisorProvider = deepseekProvider({
    apiKey,
    model: "deepseek-v4-flash",
    thinking: "high",
    ...baseUrl,
  });
  // Supervisor toggle (M-prompts-1): default ON; HERTA_SUPERVISOR=0
  // disables it for dev runs. Replaces the old workspace-file
  // existence-toggle (supervisor_reference.txt).
  //
  // It disables MORE than the veto (audit BL16). The `@板砖` trigger re-pass
  // gates in actor-turn live inside the same `supervisorReference !== ""`
  // block, so HERTA_SUPERVISOR=0 also turns off the check that a rhetorical
  // `@板砖` does not fire a real dispatch — while the dispatch itself, keyed
  // on the literal token, stays unconditional. A dev run with the toggle off
  // will dispatch on a mention. Dev-only: no shipped UI reaches this env var.
  const supervisorReference = supervisorReferenceFor(
    process.env.HERTA_SUPERVISOR !== "0",
  );

  // Default to deepseek-v4-pro for the v0.2 narrative-completion actor.
  // The actor is the user's primary touchpoint with Herta — voice fidelity
  // and Chinese nuance matter more here than per-turn latency. Operators
  // can override via HERTA_ACTOR_MODEL=deepseek-v4-flash to trade quality
  // for ~3x speed and ~10x lower cost.
  //
  // NOTE: as of 2026-05, the DeepSeek API accepts only `deepseek-v4-pro`
  // or `deepseek-v4-flash` on the completion endpoint. Any other model
  // identifier produces a 400 "supported API model names are..." error.
  const model = process.env.HERTA_ACTOR_MODEL ?? "deepseek-v4-pro";

  // `lang` selects the reveal cadence (EN word-paced, zh per code point) and
  // the 板砖→Brick display alias — session-constant, so a constructor opt.
  const v2Renderer = new NarrativeRenderer(stdout, style, { lang });

  // Transient compaction hint: show "正在压缩对话记忆…" while the recap
  // summarizer LLM is running. The indicator is written without a trailing
  // newline so `endCompactionHint()` erases it in place via `\r\x1b[K`.
  // This is purely ephemeral UI — it does NOT become a durable record block.
  bus.on("recap.compaction", (event) => {
    if (event.phase === "start") {
      v2Renderer.beginCompactionHint();
    } else {
      v2Renderer.endCompactionHint();
    }
  });

  // Optional prompt-dump for debugging. Enabled via `HERTA_DUMP_PROMPTS`
  // (any truthy value). Each LLM call writes its literal prompt bytes to
  // `<transcriptDir>/<sessionId>.prompts/turn-NNN-<label>.txt`. Off by
  // default — production sessions stay uncluttered.
  let onPrompt:
    | ((
        label:
          | "primary"
          | "primary-out"
          | "beat"
          | "beat-out"
          | "phase2"
          | "phase2-out"
          | "state"
          | "state-out"
          | "supervisor"
          | "supervisor-out"
          | "supervisor-retry"
          | "supervisor-retry-out",
        prompt: string,
      ) => void)
    | undefined;
  if (process.env.HERTA_DUMP_PROMPTS) {
    const promptsDir = join(transcriptDir, `${actorSessionId}.prompts`);
    try {
      mkdirSync(promptsDir, { recursive: true });
      let promptCounter = 0;
      onPrompt = (label, prompt): void => {
        try {
          promptCounter += 1;
          const filename = `turn-${String(promptCounter).padStart(3, "0")}-${label}.txt`;
          writeFileSync(join(promptsDir, filename), prompt, "utf-8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          stderr.write(style.dim(`herta: prompt dump failed: ${msg}\n`));
        }
      };
      stderr.write(style.dim(`herta: dumping prompts to ${promptsDir}/\n`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.write(
        style.dim(`herta: prompt dump disabled (mkdir failed: ${msg})\n`),
      );
    }
  }

  // Recap runtime — automatic long-session compaction (spec 2026-06-19,
  // ADR 0009). Enabled. NOTE: the default thresholds engage only at ~800K
  // tokens (1M window × bufferFraction 0.2), so on normal sessions this stays
  // effectively inert until the budgets are tuned to realistic sizes (a
  // separate, validation-gated change; see session-recap.ts §"STARTING
  // POINTS"). The manual /compact path bypasses `enabled`. Built via the shared
  // @herta/herta factory so this and the app-server bootstrap can't drift on
  // config or the guide path (the factory reads 黑塔's HertaGuide.txt with a
  // safe fallback to "").
  const recap = await buildRecapRuntime({
    // The supervisor's "high" adapter, NOT the low-effort router: recap
    // distills voice anchors and rolls (ADR 0009) — precision work.
    routerProvider: supervisorProvider,
    workspaceRoot,
    sessionId: actorSessionId,
    enabled: true,
    lang,
  });

  const driver = new V2ActorDriver({
    provider: completionProvider,
    model,
    staticPrefix: effectiveStaticPrefix,
    bus,
    runtimeFactory: codingAgentFactory,
    persister,
    sink: v2Renderer,
    onPrompt,
    routerProvider,
    metaThinkCorpus,
    hints: actorHints,
    supervisorProvider,
    supervisorReference,
    recap,
    lang,
  });

  if (resumeTarget !== undefined) {
    driver.loadRecord(resumeTarget.record);
    stdout.write(
      `${style.dim(`resumed session — ${resumeTarget.record.length} block${resumeTarget.record.length === 1 ? "" : "s"} restored`)}\n`,
    );
  } else if (opening !== undefined) {
    // New session with an opening: inject the seed block as TerminalRecord
    // block 0 AND persist it to the JSONL so it survives across resumes.
    // The preamble is already folded into effectiveStaticPrefix above; it
    // does NOT enter TerminalRecord (per Slice 8 §3 decision B).
    const seedBlock = {
      kind: "herta" as const,
      surface: "speech" as const,
      text: opening.seedText,
      // Stamp at construction so the in-memory seed matches the persisted one
      // (the persister won't double-stamp). The CLI doesn't render timestamps,
      // but a CLI-created session opened in the GUI shows the opening line's time.
      at: new Date().toISOString(),
    };
    driver.loadRecord([seedBlock]);
    persister.appendBlock(seedBlock);
  }

  await repl({
    actor: driver,
    tools: actorTools,
    input,
    renderer: v2Renderer,
    out: stdout,
    style,
    lang,
    approvalCache,
    commandRules,
    transcriptDir,
    currentWorkspaceRoot: workspaceRoot,
    workspaceHolder: wsHolder,
    persister,
    home: deps?.homedir ?? homedir(),
    sessionId: actorSessionId,
  });

  return 0;
}
