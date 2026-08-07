/**
 * Curated CN↔EN glossary for the EN interaction language (slice 1,
 * 2026-07-14). Every entry was verified against the aligned official
 * TextMaps via `herta knowledge glossary` — `evidenceHash` is a TextMap
 * key whose CN/EN pair witnesses the translation (re-checkable any time
 * the corpus refreshes). This is the terminology source of truth for the
 * EN prompt bundle (static prefix, meta-think variants, openings): terms
 * here are OFFICIAL localization, never hand-guessed.
 *
 * Curation notes, not just data: entries carry the register warnings a
 * translator needs (e.g. 小家伙 is contextual, 银河 is "the cosmos" — the
 * official EN style never says "the galaxy").
 */

export interface CanonicalTerm {
  readonly cn: string;
  readonly en: string;
  /** TextMap hash whose CN/EN pair witnesses this translation. */
  readonly evidenceHash: string;
  /** Register / usage guidance for prompt authors. */
  readonly note?: string;
}

export const CANONICAL_TERMS: readonly CanonicalTerm[] = [
  // ── People / identities ─────────────────────────────────────────────────
  {
    cn: "黑塔",
    en: "Herta",
    evidenceHash: "10106148985112540665",
  },
  {
    cn: "大黑塔",
    en: "The Herta",
    evidenceHash: "10800039495191725990",
    note:
      'Official EN is "The Herta" (definite article, capital T). Do NOT ' +
      'render 大黑塔 as "Madam Herta" — that form is official ONLY for ' +
      "黑塔女士 (see that entry); for 大黑塔 it is the Japanese " +
      "localization (マダム・ヘルタ) and fan usage.",
  },
  {
    cn: "黑塔女士",
    en: "Madam Herta",
    evidenceHash: "10221469077000946741",
    note:
      "The FORMAL ADDRESS (e.g. Asta's introductions) — official EN is " +
      '"Madam Herta", not "Ms./Miss Herta". Distinct from 大黑塔 = ' +
      '"The Herta".',
  },
  {
    cn: "黑塔人偶",
    en: "Herta Puppet",
    evidenceHash: "5270291646218225571",
    note: '人偶 alone → "puppet".',
  },
  {
    cn: "开拓者",
    en: "Trailblazer",
    evidenceHash: "6354779731002018877",
  },
  {
    cn: "三月七",
    en: "March 7th",
    evidenceHash: "10801972946609024961",
  },
  {
    cn: "瓦尔特",
    en: "Welt",
    evidenceHash: "1175847702774116267",
  },
  {
    cn: "螺丝咕姆",
    en: "Screwllum",
    evidenceHash: "10543066386310239041",
  },
  {
    cn: "阮·梅",
    en: "Ruan Mei",
    evidenceHash: "5718009168315370979",
  },
  // ── Herta's address terms ───────────────────────────────────────────────
  {
    cn: "星核小鬼",
    en: "Stellaron twerp",
    evidenceHash: "11814298790278634768",
    note:
      "Herta's name for the Trailblazer. In running dialogue EN often " +
      'shortens to "the twerp" (hash 5462405424464558147); 小鬼 in her ' +
      'register maps to "twerp", not "brat"/"kid".',
  },
  {
    cn: "小家伙",
    en: "little one",
    evidenceHash: "785114979996357867",
    note:
      "CONTEXTUAL, not a fixed term — official EN varies per line " +
      '("little one", "small", "little ones"). Resolve each usage against ' +
      "the TextMaps rather than substituting mechanically.",
  },
  // ── World nouns ─────────────────────────────────────────────────────────
  {
    cn: "天才俱乐部",
    en: "Genius Society",
    evidenceHash: "8819275393537249300",
    note: 'Membership numbers keep the # form: 天才俱乐部#83 → "Genius Society #83".',
  },
  {
    cn: "黑塔空间站",
    en: "Herta Space Station",
    evidenceHash: "8816001601874596832",
    note: "空间站「黑塔」 (the in-game map label) → the same EN name.",
  },
  {
    cn: "星核",
    en: "Stellaron",
    evidenceHash: "7824286515561822373",
  },
  {
    cn: "模拟宇宙",
    en: "Simulated Universe",
    evidenceHash: "100993340590182335",
  },
  {
    cn: "博识尊",
    en: "Nous",
    evidenceHash: "15926983167009665127",
    note: "The Aeon of Erudition; EN drops the honorific entirely.",
  },
  {
    cn: "智识",
    en: "Erudition",
    evidenceHash: "10545912126575871313",
    note: 'The Path: 「智识」命途 → "the Path of Erudition".',
  },
  {
    cn: "令使",
    en: "Emanator",
    evidenceHash: "10526815052741041005",
  },
  {
    cn: "遗器",
    en: "Relic",
    evidenceHash: "12123912494631528313",
  },
  {
    cn: "忘却之庭",
    en: "Forgotten Hall",
    evidenceHash: "10923236933638662248",
  },
  {
    cn: "翁法罗斯",
    en: "Amphoreus",
    evidenceHash: "10425669453506948675",
  },
  {
    cn: "黑潮",
    en: "Black Tide",
    evidenceHash: "11443445663191837402",
    note: "Capitalized proper noun in EN.",
  },
  {
    cn: "反吐真剂",
    en: "Anti-Truth Serum",
    evidenceHash: "6449428316969297980",
    note: "Capitalized in official EN.",
  },
  {
    cn: "芝士流心",
    en: "Molten Cheese Tart",
    evidenceHash: "17299562949832441524",
    note:
      "Ruan Mei's creature — an official NAME in EN, not descriptive " +
      "prose.",
  },
  {
    cn: "星际和平网络",
    en: "Interastral Peace Network",
    evidenceHash: "9754499242764437137",
  },
  {
    cn: "西格玛重子",
    en: "Sigma Baryons",
    evidenceHash: "1458975202697293782",
    note: "Capitalized in official EN.",
  },
  {
    cn: "缇里西庇俄丝",
    en: "Tribios",
    evidenceHash: "1288163029386997696",
    note: 'NOT a phonetic reconstruction ("Tirisibios" etc.) — EN shortens it.',
  },
  {
    cn: "相位灵火",
    en: "Phase Flame",
    evidenceHash: "3130748334741473352",
  },
  {
    cn: "银河",
    en: "the cosmos",
    evidenceHash: "11738239981664132552",
    note:
      'Official EN style renders 银河 as "(the) Cosmos", NOT "the galaxy" — ' +
      "a hand translation would miss this.",
  },
];

/** Exact-CN lookup into the curated map. */
export function canonicalTermFor(cn: string): CanonicalTerm | undefined {
  return CANONICAL_TERMS.find((t) => t.cn === cn);
}
