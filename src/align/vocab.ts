// 德语 CTC 模型（oliverguhr/wav2vec2-large-xlsr-53-german-cv9）的词表与文本映射。
//
// ── 这里为什么不再有罗马化（变更 42）──
// 原来的模型是 MMS-FA，一个**多语言、罗马化**的对齐器：词表只有 a-z + 撇号，
// 德语文本进去之前要先 ä→a、ß→ss、把标点数字丢掉。那是有损的，而且损在德语最要紧的
// 那几个音上。换成德语原生模型之后词表自带 ä/ö/ü/ß，映射退化成「小写 + 去掉不认识的字符」。
//
// ── 多出来的那个 token：`|` ──
// 这个模型有**词分隔符**（`|`，id 0），训练时每个词之间都有它。所以对齐目标里也必须有：
// 不放的话，词间那几帧上模型把概率质量押在 `|` 上，而路径只能从 blank 或下一个字母上过 ——
// 两者概率都低，于是边界抖动、整句 confidence 被拉低。放进去之后词间静音由 `|` 正当地吸收。
// 它不属于任何一个词，所以带 `wordIndex: SEPARATOR_WORD_INDEX`，由 target.ts 在折回
// 句级/词级时间戳时跳过。
//
// 词表内容不写死在代码里会更"正确"（可以从 vocab.json 读），但那会让映射变成异步、
// 也让单测必须先下载模型。词表是模型的一部分，模型换了整套配置都要换（见 config.ts），
// 所以这里直接内联，并在加载模型时断言 vocabSize 一致。

/**
 * `onnx/vocab.json` 原样转录（33 条）。**改这里之前先确认 config.ts 里的 modelId 没换。**
 *
 * 另外还有 `added_tokens.json` 里的 `<s>`=33 / `</s>`=34 —— 它们让 logits 的最后一维是
 * **35** 而不是 33，但对齐用不到，所以不列在这里。vocabSize 在 config.ts 上。
 */
export const GERMAN_VOCAB: Record<string, number> = {
  '|': 0,
  a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11, l: 12, m: 13,
  n: 14, o: 15, p: 16, q: 17, r: 18, s: 19, t: 20, u: 21, v: 22, w: 23, x: 24, y: 25,
  z: 26, 'ß': 27, 'ä': 28, 'ö': 29, 'ü': 30,
  '[UNK]': 31, '[PAD]': 32,
};

/** CTC 的 blank。**这个模型是 `[PAD]`=32，不是 0** —— 0 是词分隔符。 */
export const BLANK_ID = 32;
/** 词分隔符 `|`。 */
export const WORD_DELIM_ID = 0;

/** wav2vec2 系列的 inputs_to_logits_ratio = 320，16kHz 下即 50 帧/秒。 */
export const FRAME_SECONDS = 320 / 16000;

/** 词分隔符 token 的 wordIndex。负数 = 「不属于任何一个词」。 */
export const SEPARATOR_WORD_INDEX = -1;

/**
 * 多字符替换。必须在 NFD 之前做 —— NFD **不会**分解 ß，
 * 而 ä→ä（组合形）这类靠 NFC 归一化就够了。
 *
 * æ/œ/ø 这些不是德语字母，但外来词里会出现（Œuvre、Søren）。按德语转写习惯落到最近的
 * 那个元音上，让它们至少还能参与对齐 —— 丢掉的话那个词会整段缺 token。
 */
const MULTI_CHAR: Array<[RegExp, string]> = [
  [/æ/g, 'ä'],
  [/œ/g, 'ö'],
  [/ø/g, 'ö'],
  [/å/g, 'a'],
  [/þ/g, 't'],
  [/đ|ð/g, 'd'],
  [/ł/g, 'l'],
];

/**
 * 把单个原文字符映射成 0..n 个 vocab 内的小写字母。
 * 返回空串表示这个字符不参与对齐（标点、数字、撇号、空白）。
 *
 * 数字是**直接丢掉**的，不展开成德语数词。
 * 代价：`zwischen 18 und 30 Jahre` 变成 `zwischen|und|jahre`，音频里那两个数词
 * （近 1 秒）没有对应 token，由 CTC blank 吸收。这对**句边界**几乎无损（误差是局部的），
 * 只有当数字正好压在句首/句尾时才会让那一句的边界偏几十毫秒。
 *
 * 撇号同理：这个模型的词表里没有 `'`（MMS-FA 有），所以 `geht's` 的撇号被丢掉，
 * 剩下的字母仍然连成一个词 —— 见 tokenizeSentence 里「只有空白才断词」那一段。
 */
export function mapChar(ch: string): string {
  let s = ch.toLowerCase().normalize('NFC');
  for (const [re, to] of MULTI_CHAR) s = s.replace(re, to);
  let out = '';
  for (const c of s) {
    if (c in GERMAN_VOCAB && c !== '|' && c !== '[UNK]' && c !== '[PAD]') {
      out += c;
      continue;
    }
    // 词表里没有的带符字母（é、ç、í…）去掉变音符再试一次：é→e、ç→c。
    // 注意这一步走不到 ä/ö/ü —— 它们上面已经命中了，不会被剥成 a/o/u。
    const stripped = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const d of stripped) {
      if (d in GERMAN_VOCAB && d !== '|') out += d;
    }
  }
  return out;
}

/** 一个 token 及其在原句里的出处。 */
export interface TargetToken {
  /** vocab id */
  id: number;
  /** 产生它的那个原文字符在句内的 offset */
  charOffset: number;
  /** 第几个词（同句内从 0 开始）。`SEPARATOR_WORD_INDEX` = 词分隔符，不属于任何词 */
  wordIndex: number;
}

/**
 * 把一句德语文本变成 token 序列，词与词之间插入 `|`。
 *
 * ── 断词只认空白 ──
 * 上一版的规则是「任何被丢掉的字符都算断词点」，那在罗马化那套里没问题（撇号在词表里）。
 * 这套词表里 `'` 和 `-` 都不在，照旧规则 `geht's` 会被断成两个词、中间插一个 `|` ——
 * 而音频里那儿根本没有词边界，模型不会在那里给出 `|`，于是 Viterbi 被迫花掉几帧去
 * 经过一个不存在的分隔符。所以：**只有空白断词**，词内的标点静默丢掉。
 * `E-Mail`、`Schwarz-Rot-Gold` 这类连字符复合词因此被当成一个词，这与朗读一致。
 */
export function tokenizeSentence(text: string): TargetToken[] {
  const tokens: TargetToken[] = [];
  let wordIndex = 0;
  /** 上一处空白的 offset；有值 = 「下一个字母之前要插一个分隔符」 */
  let pendingBreak: number | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      // 句首的空白不算断词点，否则第一个词会白白拿到词号 1。
      if (tokens.length > 0) pendingBreak = i;
      continue;
    }
    const mapped = mapChar(ch);
    if (mapped === '') continue;
    if (pendingBreak !== null) {
      tokens.push({ id: WORD_DELIM_ID, charOffset: pendingBreak, wordIndex: SEPARATOR_WORD_INDEX });
      wordIndex++;
      pendingBreak = null;
    }
    for (const c of mapped) {
      tokens.push({ id: GERMAN_VOCAB[c], charOffset: i, wordIndex });
    }
  }
  return tokens;
}
