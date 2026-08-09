import type { PromptLang } from "./prompt-lang.js";

/**
 * CN/EN prose for the harness's **elision markers** — the lines a
 * projection writes to tell Herta that something which used to be in
 * front of her no longer is.
 *
 * Why these localize when record chrome does not: `→ 系统`,
 * `（我 说）`, `Reading {…}` and friends are the record's canonical
 * grammar, identical in every session (D2/D7, ADR 0017/0018 — display
 * localizes, the record does not). These strings are neither — they are
 * the harness talking TO Herta about her own prompt, the same register
 * as `session-recap-runtime`'s `〔更早的 N 段记录因篇幅略去〕`, which
 * has been per-lang since the EN interaction slices. An EN session
 * should not be told its history was compacted in Chinese.
 *
 * `板砖` stays literal in both: it is the wire token, and the EN prompt
 * corpus already treats it as a proper noun in English prose ("I call it
 * 板砖 — 'the brick'", prompts-en/EnvSet.txt). The `@Brick` alias of
 * ADR 0015 is a *display* alias and deliberately does not reach here.
 *
 * Wording discipline — these markers are read by a model that must not
 * claim to have seen what it cannot see, so each one states the fact
 * plainly (`历史已压缩`, not the old label-shaped `压缩历史`) and the
 * whole family shares one verb for removal (略去 / elided).
 */
export const COMPACTION_TEXT = {
  zh: {
    /** Header of a compacted contiguous-system-run summary block. */
    header: "[历史已压缩 · 板砖]",
    /** Appended to an excerpt citation once its text is gone. Shared with the
     *  attachment citation: the fact is identical ("the body is no longer in
     *  front of you"), and two phrasings for one fact would only invite the
     *  model to read a distinction into them. */
    excerptElided: "正文已略去",
    /** Why an attachment carries no text at all. Distinct from the elision
     *  above, and the distinction is load-bearing: elided means she WAS shown
     *  it and no longer is; these mean it was never readable, so there is
     *  nothing she could ever have seen. */
    attachmentUnreadable: {
      binary: "非文本文件，未取正文",
      too_large: "文件过大，未取正文",
      empty: "未提取到文本",
      read_error: "读取失败",
      denied: "涉及密钥或凭据，已拒收",
    },
    /** Digest of a `role: "noop-marker"` block. */
    noOutput: "（板砖无产出）",
    /** Footer replacing the tail of an over-long ```diff fence. */
    diffSuppressed: (suppressed: number) =>
      `… (另有 ${suppressed} 行已略去 — 完整 diff 在证据里)`,
  },
  en: {
    header: "[history compacted · 板砖]",
    excerptElided: "body elided",
    attachmentUnreadable: {
      binary: "not a text file, no body taken",
      too_large: "file too large, no body taken",
      empty: "no text extracted",
      read_error: "could not be read",
      denied: "credential-shaped, refused",
    },
    noOutput: "(板砖 produced nothing)",
    diffSuppressed: (suppressed: number) =>
      `… (${suppressed} more lines suppressed — full diff in evidence)`,
  },
} as const satisfies Record<PromptLang, unknown>;
