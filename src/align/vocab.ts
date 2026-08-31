// MMS-FA（facebook/mms-300m-1130-forced-aligner）的 CTC 词表与德语罗马化。
//
// 这个模型的 vocab 只有 31 个 token：<blank> <pad> </s> <unk> + a-z + 撇号。
// **没有空格 token**，也没有 ä/ö/ü/ß、没有标点数字。所以德语文本进对齐前必须罗马化，
// 而且——这是整个模块的关键——罗马化是有损且长度会变的（ß→ss 是 1→2，标点是 1→0），
// 所以不能只产出字符串，必须同时产出「每个 token 来自原文哪个字符」的映射。
// 丢了这张映射表，算出来的帧边界就回不到 Sentence.text 的 offset 上，词级时间戳全废。
//
// 词表内容不写死在代码里会更"正确"（可以从 vocab.json 读），但那会让罗马化变成异步、
// 也让单测必须先下载模型。词表是模型的一部分，模型换了整套配置都要换（见 models.ts），
// 所以这里直接内联，并在加载模型时断言两者一致。

/** vocab.json 原样转录。改这里之前先确认 models.ts 里对应的 modelId 没换。 */
export const MMS_FA_VOCAB: Record<string, number> = {
  '<blank>': 0, '<pad>': 1, '</s>': 2, '<unk>': 3,
  a: 4, i: 5, e: 6, n: 7, o: 8, u: 9, t: 10, s: 11, r: 12, m: 13,
  k: 14, l: 15, d: 16, g: 17, h: 18, y: 19, b: 20, p: 21, w: 22,
  c: 23, v: 24, j: 25, z: 26, f: 27, "'": 28, q: 29, x: 30,
};

export const BLANK_ID = 0;

/** wav2vec2 系列的 inputs_to_logits_ratio = 320，16kHz 下即 50 帧/秒。 */
export const FRAME_SECONDS = 320 / 16000;

/**
 * 多字符替换必须在 NFD 之前做：NFD **不会**分解 ß，
 * 而 ä→a 这类靠 NFD 去变音符就够了，不需要在这里列。
 *
 * 关于 ß→ss 而不是 ß→s：模型训练时文本过的是 uroman，uroman 对 ß 给的是 ss。
 * 就算给错了也只是让这一个词的路径概率略低，边界不会跑——但没有理由故意给错。
 */
const MULTI_CHAR: Array<[RegExp, string]> = [
  [/ß/g, 'ss'],
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
  [/ø/g, 'oe'],
  [/å/g, 'aa'],
  [/þ/g, 'th'],
  [/đ|ð/g, 'd'],
  [/ł/g, 'l'],
  // 各种花体撇号统一成 vocab 里那个 ASCII 撇号
  [/[‘’ʼ´`]/g, "'"],
];

/**
 * 把单个原文字符罗马化成 0..n 个 vocab 内的小写字符。
 * 返回空串表示这个字符不参与对齐（标点、数字、空白）。
 *
 * 数字在 V1 是**直接丢掉**的，不展开成德语数词。
 * 代价：`zwischen 18 und 30 Jahre` 会变成 `zwischenundjahre`，音频里那两个数词
 * （近 1 秒）没有对应 token，由 CTC blank 吸收。这对**句边界**几乎无损（误差是局部的），
 * 只有当数字正好压在句首/句尾时才会让那一句的边界偏几十毫秒。
 * 展开德语数词（含 1990 读作 neunzehnhundertneunzig 这类年份读法）是独立一块活，
 * 收益只在词级时间戳的精度上，不值得挡住这一版。
 */
export function romanizeChar(ch: string): string {
  let s = ch.toLowerCase();
  for (const [re, to] of MULTI_CHAR) s = s.replace(re, to);
  // 去变音符：é→e、ç→c、ä→a、ü→u……
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  let out = '';
  for (const c of s) {
    if (c in MMS_FA_VOCAB && c !== '<blank>') out += c;
  }
  return out;
}

/** 一个罗马化后的 token 及其在原句里的出处。 */
export interface TargetToken {
  /** vocab id */
  id: number;
  /** 产生它的那个原文字符在句内的 offset */
  charOffset: number;
  /** 第几个词（同句内从 0 开始），用于还原词级时间戳 */
  wordIndex: number;
}

/**
 * 把一句德语文本罗马化成 token 序列。
 *
 * 词边界的定义是「罗马化后中间隔了至少一个被丢掉的字符」——也就是原文的空白或标点。
 * 不用 text.split(/\s+/) 是因为那样得再算一遍 offset，两套算法迟早对不上。
 */
export function romanizeSentence(text: string): TargetToken[] {
  const tokens: TargetToken[] = [];
  let wordIndex = 0;
  let pendingBreak = false;
  for (let i = 0; i < text.length; i++) {
    const romanized = romanizeChar(text[i]);
    if (romanized === '') {
      // 只有真的已经开始过一个词，才把「丢掉的字符」算作断词点，
      // 否则句首的引号会白白吃掉一个词号（„Work → 词 0 应该是 work）。
      if (tokens.length > 0) pendingBreak = true;
      continue;
    }
    if (pendingBreak) {
      wordIndex++;
      pendingBreak = false;
    }
    for (const c of romanized) {
      tokens.push({ id: MMS_FA_VOCAB[c], charOffset: i, wordIndex });
    }
  }
  return tokens;
}
