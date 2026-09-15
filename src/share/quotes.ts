// FR-18.4：分享图上的那句德语。
//
// ── 为什么是这一批，而不是联网抓 ──
// 分享图必须在离线时也能生成（地铁里练完一课就想发出去），所以句子内置。
// 而内置就意味着**版权要自己担**：这里只收两类 —— 德语谚语（无作者），
// 以及作者去世满 70 年、在德国已进入公有领域的引文（歌德 1832、席勒 1805、
// 尼采 1900、里尔克 1926、埃布纳-埃申巴赫 1916、洪堡 1835、维特根斯坦 1951）。
// 凯斯特纳（1974）、布莱希特（1956）那几句流传更广的**故意没收**：它们还在版权期内。
//
// 中文是我自己的译法，不是抄哪一版译本 —— 同样是为了不把别人的东西印在图上。
// 译文放在德语下面一行、小一号：这张图是发给朋友看的，而朋友不一定读德语。

export interface Quote {
  de: string;
  zh: string;
  /** 作者。谚语给 `null` —— 图上会印「德语谚语」而不是一个人名。 */
  author: string | null;
}

export const QUOTES: Quote[] = [
  { de: 'Aller Anfang ist schwer.', zh: '万事开头难。', author: null },
  { de: 'Übung macht den Meister.', zh: '熟能生巧。', author: null },
  { de: 'Wer rastet, der rostet.', zh: '不进则退。', author: null },
  { de: 'Steter Tropfen höhlt den Stein.', zh: '水滴石穿。', author: null },
  { de: 'Ohne Fleiß kein Preis.', zh: '不下苦功，不得回报。', author: null },
  { de: 'Es ist noch kein Meister vom Himmel gefallen.', zh: '没有谁生来就是行家。', author: null },
  { de: 'Viele kleine Streiche fällen die große Eiche.', zh: '一斧一斧，也能放倒大橡树。', author: null },
  { de: 'Geduld bringt Rosen.', zh: '耐心自会开出花来。', author: null },
  { de: 'Frisch gewagt ist halb gewonnen.', zh: '敢下手，就已经成了一半。', author: null },
  { de: 'Man lernt nie aus.', zh: '学无止境。', author: null },
  { de: 'Morgenstund hat Gold im Mund.', zh: '一日之计在于晨。', author: null },
  { de: 'Wer nicht wagt, der nicht gewinnt.', zh: '不敢冒险，就赢不了。', author: null },
  { de: 'Erfahrung ist der beste Lehrmeister.', zh: '经验是最好的老师。', author: null },
  { de: 'Der Weg ist das Ziel.', zh: '路本身就是目的地。', author: null },
  { de: 'Was du heute kannst besorgen, das verschiebe nicht auf morgen.', zh: '今天办得了的事，别推到明天。', author: null },
  {
    de: 'Wer fremde Sprachen nicht kennt, weiß nichts von seiner eigenen.',
    zh: '不懂外语的人，对自己的母语也一无所知。',
    author: 'Goethe',
  },
  {
    de: 'Es ist nicht genug zu wissen, man muss auch anwenden.',
    zh: '只是知道还不够，还得把它用起来。',
    author: 'Goethe',
  },
  {
    de: 'Wer immer strebend sich bemüht, den können wir erlösen.',
    zh: '凡是不断努力向上的人，我们都能拯救他。',
    author: 'Goethe',
  },
  {
    de: 'Wer ein Warum zu leben hat, erträgt fast jedes Wie.',
    zh: '知道为什么而活的人，几乎能忍受任何一种活法。',
    author: 'Nietzsche',
  },
  {
    de: 'Man muss Geduld haben mit dem Ungelösten im Herzen.',
    zh: '对心里那些还没有答案的事，要有耐心。',
    author: 'Rilke',
  },
  {
    de: 'Wer aufhört, besser werden zu wollen, hört auf, gut zu sein.',
    zh: '一旦不再想变得更好，也就不再好了。',
    author: 'Ebner-Eschenbach',
  },
  {
    de: 'Die Sprache ist das bildende Organ des Gedankens.',
    zh: '语言是塑造思想的那个器官。',
    author: 'W. v. Humboldt',
  },
  {
    de: 'Die Grenzen meiner Sprache bedeuten die Grenzen meiner Welt.',
    zh: '我的语言的界限，就是我的世界的界限。',
    author: 'Wittgenstein',
  },
  {
    de: 'Nur der verdient sich Freiheit wie das Leben, der täglich sie erobern muss.',
    zh: '只有每天去争取自由与生活的人，才配拥有它们。',
    author: 'Goethe',
  },
];

/** 图上印的署名。谚语没有作者，印「德语谚语」而不是留一行空白。 */
export function quoteAttribution(quote: Quote): string {
  return quote.author ?? 'Deutsches Sprichwort';
}

/**
 * 今天这句。**同一天打开十次是同一句**（日期做种子），否则每次进记录页都换一句，
 * 那张图就不是「今天的」而是「刚才那一下的」。
 *
 * `offset` 是「换一句」按钮传的：在今天这句的基础上往后数几句，
 * 所以换出来的顺序也是确定的，不会连着抽到同一句。
 */
export function quoteForDate(dateKey: string, offset = 0): Quote {
  let hash = 0;
  for (const ch of dateKey) hash = (hash * 31 + ch.charCodeAt(0)) % 1_000_003;
  const index = (hash + offset) % QUOTES.length;
  return QUOTES[index];
}
