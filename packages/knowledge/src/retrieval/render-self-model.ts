import type { DefaultRegister } from "../schema.js";
import type { HertaSelfModelV1 } from "../self-model/schema.js";

const TRUNK_DEFAULT_HEADER =
  "我是 The Herta (大黑塔), 天才俱乐部 #83 的本人 — 空间站工坊里那个生物人, 不是出门跑的人偶, 不是这条终端。终端是我桌上的一根线, 我亲自坐在桌前敲键盘。";

const TURN_RHYTHM =
  "动工具之前我先开口 — 一句 acknowledge, 一句 framing, 一句干净的观察, 看场合挑。用户先听到我, 再看到工具调用, 再听到我接下去说。工具的输出不是我的回应, 我说的话才是。";

export interface RenderHertaSelfInput {
  /** The shipped HertaSelfModelV1 row payload, if present. */
  selfModel?: HertaSelfModelV1;
  /** The shipped voice profile's defaultRegister, if present. */
  voiceRegister?: DefaultRegister;
  /** Names of the tools the actor has registered, if any. */
  toolNames?: ReadonlyArray<string>;
}

/**
 * Render the **single** first-person self block for the actor's
 * `herta_core_identity` layer. This is the trunk; the prompt has no
 * other identity capsules.
 *
 * Sections (each only emitted when the input is present):
 *   1. preamble + identity anchor (always)
 *   2. biography / philosophy / embodiment / harness_proprioception prose
 *      from the shipped self-model row
 *   3. voice register rendered as first-person Chinese notes
 *      ("我说话的样子: ...")
 *   4. turn rhythm reminder ("用工具之前, 我先用自己的话说一句")
 *   5. tools coda ("我手边的工具: ...")
 *
 * All text is first-person — no "you are", no "act like". The intent is
 * the model reads this as Herta's own self-knowledge, not as a roleplay
 * directive. This dodges the "cosplay Herta" failure mode where an
 * imperative persona prompt produces stylized performance.
 *
 * Pure: depends only on its input; no I/O, no time, no store access.
 */
export function renderHertaSelf(input: RenderHertaSelfInput): string {
  const out: string[] = [TRUNK_DEFAULT_HEADER, ""];

  const m = input.selfModel;
  if (m !== undefined) {
    const sections: Array<{ header: string; body: string }> = [];
    const bio = m.biography.prose.trim();
    if (bio.length > 0) {
      sections.push({ header: "【我是谁 — 简史】", body: bio });
    }
    const phi = m.philosophy.prose.trim();
    if (phi.length > 0) {
      sections.push({ header: "【我的处世】", body: phi });
    }
    const emb = m.embodiment.prose.trim();
    if (emb.length > 0) {
      sections.push({ header: "【我的身体与工坊】", body: emb });
    }
    const harn = m.harness_proprioception.prose.trim();
    if (harn.length > 0) {
      sections.push({ header: "【我和这个终端】", body: harn });
    }
    for (const s of sections) {
      out.push(s.header);
      out.push(s.body);
      out.push("");
    }
  }

  if (input.voiceRegister !== undefined) {
    const voice = renderVoiceAsSelfNotes(input.voiceRegister);
    if (voice.length > 0) {
      out.push("【我说话的样子】");
      out.push(voice);
      out.push("");
    }
  }

  out.push("【对话节奏】");
  out.push(TURN_RHYTHM);
  out.push("");

  if (input.toolNames !== undefined && input.toolNames.length > 0) {
    out.push("【我手边的工具】");
    out.push(renderToolsCoda(input.toolNames));
    out.push("");
  }

  return out.join("\n").trimEnd();
}

/**
 * Render a {@link DefaultRegister} as first-person Chinese self-notes
 * suitable for inclusion in the actor's identity block. NOT XML.
 *
 * Returns "" if the register is empty.
 */
export function renderVoiceAsSelfNotes(register: DefaultRegister): string {
  const lines: string[] = [];

  if (register.formsOfAddress.length > 0) {
    const phrases = register.formsOfAddress.map((f) => `「${f.phrase}」`);
    lines.push(`- 我用的称呼: ${phrases.join("、")}。`);
  }

  if (register.toneInvariants.length > 0) {
    lines.push("- 我的语气习惯:");
    for (const t of register.toneInvariants) {
      lines.push(`  · ${t.pattern}`);
    }
  }

  if (register.codeSwitchTriggers.length > 0) {
    lines.push("- 我什么时候切到英文:");
    for (const c of register.codeSwitchTriggers) {
      lines.push(`  · 触发: ${c.trigger} (切到 ${c.switchTo})`);
    }
  }

  const moods: Array<[string, string, ReadonlyArray<{ pattern: string }>]> = [];
  if (
    register.moodModulators.pleased !== undefined &&
    register.moodModulators.pleased.length > 0
  ) {
    moods.push(["满意时", "pleased", register.moodModulators.pleased]);
  }
  if (
    register.moodModulators.interested !== undefined &&
    register.moodModulators.interested.length > 0
  ) {
    moods.push(["感兴趣时", "interested", register.moodModulators.interested]);
  }
  if (
    register.moodModulators.annoyed !== undefined &&
    register.moodModulators.annoyed.length > 0
  ) {
    moods.push(["不耐烦时", "annoyed", register.moodModulators.annoyed]);
  }
  if (moods.length > 0) {
    lines.push("- 不同心情下:");
    for (const [label, _mood, patterns] of moods) {
      lines.push(`  · ${label}:`);
      for (const p of patterns) {
        lines.push(`    - ${p.pattern}`);
      }
    }
  }

  return lines.join("\n");
}

function renderToolsCoda(toolNames: ReadonlyArray<string>): string {
  // Tool names are stable identifiers; we annotate the well-known ones with
  // a brief Chinese gloss for the model. Unknown names pass through.
  const GLOSS: Record<string, string> = {
    read_file: "自己读一个文件",
    list_files: "列目录",
  };
  const lines: string[] = [];
  for (const name of toolNames) {
    const gloss = GLOSS[name];
    lines.push(gloss !== undefined ? `- ${name}: ${gloss}` : `- ${name}`);
  }
  // No safety/permission directive here — the harness enforces deterministically
  // (D4) and tool results carry permission_denied as a structured field when
  // it happens. The actor doesn't need a prompt-time reminder.
  return lines.join("\n");
}

/**
 * Legacy renderer kept for backward compatibility with tests / callers
 * that only need the prose half. Prefer {@link renderHertaSelf} for the
 * full runtime trunk.
 *
 * @deprecated use renderHertaSelf({ selfModel }) instead
 */
export function renderSelfModel(model: HertaSelfModelV1): string {
  // Match the legacy 4-section output (no preamble/header/voice/tools).
  const sections: Array<{ header: string; body: string }> = [];
  const bio = model.biography.prose.trim();
  if (bio.length > 0) {
    sections.push({ header: "【我是谁 — 简史】", body: bio });
  }
  const phi = model.philosophy.prose.trim();
  if (phi.length > 0) {
    sections.push({ header: "【我的处世】", body: phi });
  }
  const emb = model.embodiment.prose.trim();
  if (emb.length > 0) {
    sections.push({ header: "【我的身体与工坊】", body: emb });
  }
  const harn = model.harness_proprioception.prose.trim();
  if (harn.length > 0) {
    sections.push({ header: "【我和这个终端】", body: harn });
  }
  if (sections.length === 0) return "";
  const preamble =
    "以下是 The Herta (大黑塔) 关于自己的第一人称叙述, 基于 canon 综合而成。这是你对自己的认知, 与系统其它身份描述并行存在 — 你读这段就像读自己的日记。";
  const out: string[] = [preamble, ""];
  for (const s of sections) {
    out.push(s.header);
    out.push(s.body);
    out.push("");
  }
  return out.join("\n").trimEnd();
}
