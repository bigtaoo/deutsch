// FR-14.3 / FR-14.4：解析 Glossar 词条的 `data-title`。
//
// 实测样本（附录 A.3）说明格式并不统一：
//   `Plattform, -en (f.)`                                  标准名词
//   `Gelegenheitsjob, -s (m.)`                             同上
//   `surfen`                                               动词，无性无复数
//   `Down Under (aus dem Englischen)`                      括号里不是性
//   `Great Ocean Road (f., nur Singular, aus dem Englischen)`  性 + 说明混在一起
//
// 所以规则是：能认出多少填多少，认不出就只留 surface（FR-14.4）——
// 绝不能因为格式意外丢掉整个候选。

export interface ParsedTitle {
  lemma?: string;
  gender?: 'm' | 'f' | 'n';
  plural?: string;
}

const GENDER_RE = /\b([mfn])\.\s*(?:,|\))/;

export function parseGlossaryTitle(title: string): ParsedTitle {
  const trimmed = title.trim();
  if (!trimmed) return {};

  const parenAt = trimmed.indexOf('(');
  const head = (parenAt === -1 ? trimmed : trimmed.slice(0, parenAt)).trim();
  const paren = parenAt === -1 ? '' : trimmed.slice(parenAt);

  // 括号里找性。`(aus dem Englischen)` 里没有 `m./f./n.`，自然什么都不填。
  const genderMatch = GENDER_RE.exec(paren);
  const gender = genderMatch ? (genderMatch[1] as 'm' | 'f' | 'n') : undefined;

  // 逗号前是词条，逗号后（若像复数词尾）是复数。
  // `Down Under` 没有逗号；`Great Ocean Road` 也没有 —— 整串就是词条。
  const commaAt = head.indexOf(',');
  if (commaAt === -1) {
    return { lemma: head || undefined, gender };
  }

  const lemma = head.slice(0, commaAt).trim();
  const rest = head.slice(commaAt + 1).trim();
  // 复数词尾的典型形状：`-en` / `-s` / `-¨e`；也可能是完整复数形式 `Männer`。
  const plural = rest.length > 0 ? rest : undefined;

  return { lemma: lemma || undefined, gender, plural };
}
