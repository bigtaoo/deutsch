// FR-1.7：说话人标记。
//
// 教材的听力文稿大多是对话，每一段话前面有一个说话人标记，音频里不念：
//   - Aspekte neu 用的是符号：` ●  Hallo …`、` ○  Ja, genau.`、` △  Top 1`
//   - 别的书（和 DW 的老稿）用名字：`Moderatorin: …`、`A: …`
// 留在正文里有三个坏处：名字会被当成要对齐的字、把边界往前拽；符号和名字会出现在
// 挖空题与复习卡的原句里；跟读时屏幕上多一个不念的东西。所以切句时把它从行首剥掉，
// 记在那一段第一句的 `Sentence.speaker` 上。
//
// **哪些算标记由人确认**，不由正则说了算：`Das Problem: …` 和 `Moderatorin: …`
// 在字面上长得一样。`detectSpeakers` 只给候选和次数，导入页让人勾，勾下的清单存进
// `Lesson.speakers`，重新切句（FR-1.5）用同一份 —— 换一份清单同一行切出来的文本就不同，
// 旧句一句都认领不上。

/** 书上常见的说话人符号。它们不是字母，误判的代价几乎为零，所以默认就勾上。 */
const SYMBOL_CLASS = '●○◯△▲▽▼□■◆◇◎◉★☆♂♀';
const SYMBOL_RE = new RegExp(`^\\s*([${SYMBOL_CLASS}])[\\s:：]*`, 'u');

/**
 * 名字标记：行首 1~3 个词、首字母大写（或单个大写字母），紧跟冒号和空白。
 * 不收数字 —— `1.000 Mitarbeitern:` 这种折行碎片不该被当成人名。
 */
const NAME_RE = /^\s*(\p{Lu}[\p{L}.'’-]*(?: [\p{L}.'’-]+){0,2})\s*[:：]\s+(?=\S)/u;

export interface SpeakerCandidate {
  label: string;
  count: number;
  /** 符号类默认勾上；名字类出现两次以上才默认勾上（出现一次的多半是 `Das Problem:`）。 */
  suggested: boolean;
  kind: 'symbol' | 'name';
}

export function isSpeakerSymbol(label: string): boolean {
  return label.length === 1 && SYMBOL_CLASS.includes(label);
}

/** 扫一遍全文，列出行首像说话人标记的东西，按出现次数从多到少。 */
export function detectSpeakers(text: string): SpeakerCandidate[] {
  const counts = new Map<string, { count: number; kind: 'symbol' | 'name' }>();
  for (const line of text.split('\n')) {
    const symbol = SYMBOL_RE.exec(line);
    const name = symbol ? null : NAME_RE.exec(line);
    const label = symbol?.[1] ?? name?.[1];
    if (!label) continue;
    const entry = counts.get(label) ?? { count: 0, kind: symbol ? 'symbol' : 'name' };
    entry.count++;
    counts.set(label, entry);
  }
  return [...counts.entries()]
    .map(([label, { count, kind }]) => ({
      label,
      count,
      kind,
      suggested: kind === 'symbol' || count >= 2,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 这一行是不是以清单里的某个标记开头；是的话返回标记和要跳过的字符数（含标记后的空白）。
 * 清单为空或没给就永远返回 null —— 于是 DW 与所有老课程的切句结果一个字都不变。
 */
export function matchSpeaker(
  line: string,
  speakers: readonly string[] | undefined,
): { speaker: string; skip: number } | null {
  if (!speakers || speakers.length === 0) return null;
  const symbol = SYMBOL_RE.exec(line);
  if (symbol && speakers.includes(symbol[1])) return { speaker: symbol[1], skip: symbol[0].length };
  const name = NAME_RE.exec(line);
  if (name && speakers.includes(name[1])) return { speaker: name[1], skip: name[0].length };
  return null;
}
