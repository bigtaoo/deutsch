// FR-10.6：队列受 newPerDay / reviewPerDay 限制；今日无卡时显示下次到期时间。
// FR-21：队列的单位是**卡**，不是词 —— 一个词挂两张独立调度的卡（听 / 读）。
//
// 「今天已经学了多少张」不额外记账，从卡片自身的 FSRS 状态推：
//   reps === 1 且 last_review 是今天 → 今天第一次学的新卡
//   reps  > 1 且 last_review 是今天 → 今天的复习
// 这是个近似（同一张新卡今天被 Again 反复重来会被算成复习），但它不需要任何
// 额外的每日计数器 —— 而每日计数器是要跨设备同步的，一同步就要处理时区和合并冲突，
// 为了一个「防爆闸」的软上限不值得。

import type { FSRSCard, VocabEntry } from '@/types/models';

/**
 * 一个词的两张卡（FR-21.1）。
 *
 * `listen` 是 FR-10 的听卡（正面只有声音），`read` 是 FR-21 的读卡
 * （看词形 / 看释义 / 看挖空句）。两张卡各有各的 FSRS 状态，各自调度。
 */
export type Deck = 'listen' | 'read';

/** 队列里的一项。**不是 VocabEntry** —— 同一个词可能以两种身份出现（但不在同一天）。 */
export interface ReviewCard {
  entry: VocabEntry;
  deck: Deck;
}

/** 取某一张卡的 FSRS 状态。读卡没开时是 `undefined`（FR-21.2）。 */
export function cardOf(entry: VocabEntry, deck: Deck): FSRSCard | undefined {
  return deck === 'listen' ? entry.fsrs : entry.fsrsRead;
}

export interface QueueOptions {
  newPerDay: number;
  reviewPerDay: number;
  now?: number;
}

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export interface QueueBreakdown {
  queue: ReviewCard[];
  newCount: number;
  reviewCount: number;
  /** 队列为空时的下一次到期时间；没有任何卡则 null */
  nextDueAt: number | null;
}

interface Candidate extends ReviewCard {
  card: FSRSCard;
}

/** 把一个词展开成它已经开了的那些卡。读卡没开时只有一张。 */
function cardsOf(entry: VocabEntry): Candidate[] {
  const out: Candidate[] = [{ entry, deck: 'listen', card: entry.fsrs }];
  if (entry.fsrsRead) out.push({ entry, deck: 'read', card: entry.fsrsRead });
  return out;
}

/**
 * FR-21.3 **同日互斥**：同一个词的两张卡，同一天只出一张，**听卡优先**。
 *
 * 这就是 Anki 的 sibling burying，它默认开着是有理由的：先做完听音辨义、
 * 再做看词辨义，第二张是白送 —— 答案几分钟前刚在眼前出现过，
 * 那一次「答对」喂给 FSRS 的是假信号，而 FSRS 会照单全收地把间隔拉长。
 *
 * 被让开的那张不做任何标记，它明天照常到期 —— 逾期一天对 FSRS 没有影响
 * （它算的是真实间隔），而「补偿性地今天多塞一张」恰恰是这条规则要避免的。
 */
function dedupeByEntry(list: Candidate[]): Candidate[] {
  const listenIds = new Set(list.filter((c) => c.deck === 'listen').map((c) => c.entry.id));
  const seen = new Set<string>();
  return list.filter((c) => {
    if (c.deck === 'read' && listenIds.has(c.entry.id)) return false;
    if (seen.has(c.entry.id)) return false;
    seen.add(c.entry.id);
    return true;
  });
}

export function buildReviewQueue(entries: VocabEntry[], opts: QueueOptions): QueueBreakdown {
  const now = opts.now ?? Date.now();
  const all = entries.filter((e) => !e.suspended).flatMap(cardsOf);

  const doneToday = all.filter((c) => c.card.last_review !== undefined && isSameDay(c.card.last_review, now));
  const newDoneToday = doneToday.filter((c) => c.card.reps === 1).length;
  const reviewDoneToday = doneToday.length - newDoneToday;

  // 同日互斥的另一半：今天**已经**做过某一张的词，它的另一张今天不再出现。
  const busy = new Set(doneToday.map((c) => c.entry.id));
  const available = all.filter((c) => !busy.has(c.entry.id));

  const reviewCards = dedupeByEntry(
    available.filter((c) => c.card.state !== 0 && c.card.due <= now).sort((a, b) => a.card.due - b.card.due),
  ).slice(0, Math.max(0, opts.reviewPerDay - reviewDoneToday));

  // 新卡要再排除掉「这一轮已经以复习身份入选」的词 —— 否则一个词的
  // 读卡（新）和听卡（到期）会同时排进今天的队列，互斥就漏了。
  const taken = new Set(reviewCards.map((c) => c.entry.id));
  const newCards = dedupeByEntry(
    available
      .filter((c) => c.card.state === 0 && !taken.has(c.entry.id))
      .sort((a, b) => a.entry.createdAt - b.entry.createdAt),
  ).slice(0, Math.max(0, opts.newPerDay - newDoneToday));

  // 复习排在新卡前面：到期的卡再不看就真忘了，新卡晚一天没有代价。
  const queue: ReviewCard[] = [...reviewCards, ...newCards].map(({ entry, deck }) => ({ entry, deck }));

  const upcoming = all
    .filter((c) => c.card.due > now)
    .reduce<number | null>((min, c) => (min === null || c.card.due < min ? c.card.due : min), null);

  return { queue, newCount: newCards.length, reviewCount: reviewCards.length, nextDueAt: upcoming };
}

/**
 * FR-17.4：今天还缺几张新卡 —— 惰性激活要补的就是这个数。
 *
 * 「缺」= 今天的新卡配额 − 今天已经学掉的新卡 − 手上还没学的新卡。
 * 三项都从卡片自身的状态推，不另设每日计数器（理由见文件头）。
 *
 * 为什么要减「手上还没学的新卡」：课上标的生词也是新卡，它们优先。
 * 不减的话，一篇课文标了 8 个词的那天，预置词库还会再发 10 张 ——
 * 那天就变成 18 张新卡，而 `newPerDay` 存在的理由正是不让这种事发生。
 *
 * **FR-21 之后这个数是两张卡合起来算的**：新开的读卡也是新卡，也占额度。
 * 于是「今天开了几张读卡」会自动挤掉同样多的预置新词 —— 那正是想要的顺序
 * （读卡是给已经在学的词加深，预置词库按 FR-17 自己的说法是冷启动填充物）。
 */
export function newCardShortfall(entries: VocabEntry[], opts: Pick<QueueOptions, 'newPerDay' | 'now'>): number {
  const now = opts.now ?? Date.now();
  const all = entries.filter((e) => !e.suspended).flatMap(cardsOf);
  const newDoneToday = all.filter(
    (c) => c.card.reps === 1 && c.card.last_review !== undefined && isSameDay(c.card.last_review, now),
  ).length;
  const untouched = all.filter((c) => c.card.state === 0).length;
  return Math.max(0, opts.newPerDay - newDoneToday - untouched);
}

/**
 * FR-21.2：**哪些词该开读卡了** —— 听卡进了 `Review`（state 2）而读卡还没开。
 *
 * 三条门槛，每一条都会让一张开出来的卡当场不可用：
 *   ① 听卡到 `Review`。更早开的话，一个新词同一天要考两遍（听一遍、看一遍），
 *      那是在背字形不是在学词；而且复习量一次翻倍会把队列冲垮。
 *   ② **必须有释义**。读卡三种题型里有两种（`read-gloss` / `read-form`）
 *      拿释义当题面或选项，没有释义的词条（手动建的空卡）开出来只能一直降级。
 *   ③ 没被暂停。
 *
 * 排序按 `createdAt`：先标的词先加深，与新卡的顺序一致。
 */
export function pendingReadCards(entries: VocabEntry[]): VocabEntry[] {
  return entries
    .filter((e) => !e.suspended && !e.fsrsRead && e.fsrs.state === 2 && Boolean(e.meaning))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 没有来源句的卡：预置词库（FR-17）与查词时直接加进来的词（FR-9.5）。
 *
 * 这两种卡在复习页上走同一条路 —— 没有课、没有原句，声音只能是孤立词发音。
 * 合成一个判据而不是各处写 `e.preset || e.lookup`：漏一处的症状是
 * 一张卡指着一课不存在的课要你「去重新对齐」。
 */
export function isWordCard(entry: VocabEntry): boolean {
  return Boolean(entry.preset || entry.lookup);
}

/**
 * FR-10.5：无音频卡要区分原因，给不同出口。
 *
 * `word-only` 是 FR-17 加的第四种（当时叫 `preset-word`，FR-9.5 之后查词加进来的词
 * 也走这一档）：这种卡没有课、没有原句、也没有真语料音频，
 * 它的声音来自 Wiktionary 的真人录音或系统 TTS（都是**孤立词**发音）。
 * 单独一档而不是并进 'ok'，是因为 FR-10.5 的要求是「不能静默降级」——
 * 卡面必须说清这是孤立词发音、练不到连读，否则用户会以为自己在练真语料。
 *
 * **只对听卡有意义。** 读卡正面是文字、不放声音（FR-21.5），
 * 它的「没有音频」不是一种需要给出口的故障。
 */
export type CardAudioStatus = 'ok' | 'no-timestamp' | 'no-material' | 'word-only';

export function cardAudioStatus(entry: VocabEntry, hasMaterial: boolean): CardAudioStatus {
  if (isWordCard(entry)) return 'word-only';
  if (!entry.hasTimestamp) return 'no-timestamp';
  if (!hasMaterial) return 'no-material';
  return 'ok';
}
