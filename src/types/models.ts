// 数据模型 —— 原样转录自 SPEC.md §6。
// 判断一个字段属于哪层的标准只有一条：丢了能不能重建。
// 改动这个文件前先改 SPEC.md，不要让模型和文档漂移。

// ══════ 标注层：跨设备备份 + 同步 ══════
//
// 分层的判断标准（2026-09-02 改，见 SPEC §0 变更 27）：
// **只有音频和原始文稿留在缓存层，其余一切都在这里。**
// 那两样体积大（一课 6–10MB vs 几十 KB）且都有一个稳定的来源地址，
// 所以标注层为它们记下**原始下载地址**，别的设备照着地址取回来即可。
// 旧标准是「丢了能不能重建」，它漏了一个限定词「在哪台设备上」——
// 词级时间戳在桌面能重算、在手机上压根不能（变更 26 就是被这一条绊到的）。
// 地址比「能不能重建」好判断：有地址的才准留在缓存层。

export interface Lesson {
  id: string;
  title: string; // "Alltagsdeutsch: Der deutsche Wald"
  source:
    | { type: 'dw'; dwLessonId: string; sourceUrl: string } // 可补齐（FR-3.5）
    | { type: 'manual'; audioFileName?: string }; // 不可补齐（FR-3.6）
  /**
   * 音频的**原始下载地址**（DW 的 mp3 直链）。音频本身不进备份，这一行进 ——
   * 换设备后照它把音频取回来，不必先抓一遍页面（FR-3.5 仍然会顺手刷新它，
   * 因为 CDN 直链会变；变了就以页面上那份为准）。
   *
   * 手动导入的课程没有这个字段：那个 mp3 来自本机磁盘，压根没有地址，
   * 能记的只有 `source.audioFileName`（FR-3.6 拿它提示用户重新选文件）。
   */
  audioSrc?: string;
  audioDuration?: number; // 秒；补齐或重绑定时校验时长
  manuscriptHash?: string; // plainText 的 hash；补齐后校验 DW 是否改过稿（FR-3.7）
  sentences: Sentence[];
  /**
   * FR-14：DW 在 `manuscript` 里内联标注好的生词候选。
   *
   * **在标注层**（2026-09-02 从 `LessonCache.glossary` 搬来，见 §0 变更 27）：
   * 它不是原始文稿，是从原始文稿里抽出来的一小份结构化数据（一课十几条、几 KB），
   * 而「哪些候选还没接受」是**跨设备的待办**：在桌面上看过一半、手机上接着看，
   * 这件事只有它跟着同步才成立。offset 是句内的，所以不依赖 `plainText`。
   */
  glossary?: GlossaryCandidate[];
  createdAt: number;
  updatedAt: number; // 跨设备合并用（§2.4）
}

export interface Sentence {
  index: number;
  text: string;
  charStart: number; // 在 LessonCache.plainText 中的 offset（FR-2.4）
  charEnd: number;
  startTime?: number; // 秒，未标注为 undefined
  endTime?: number; // 显式标记；否则按 FR-4.4 推断
  endTimeExplicit: boolean; // 区分显式与推断
  // FR-15：时间戳的来源。'auto' = CTC 强制对齐算出来的，还没人看过；'manual' = 人手打/校过。
  // 只有这一个字段能区分「机器给的」和「我确认过的」——
  // endTimeExplicit 区分的是「显式终点 vs 按 FR-4.4 推断」，那是另一个维度：
  // 自动对齐产出的终点是显式的（就是最后一个音素的止帧），但一点也不等于确认过。
  timingSource?: 'auto' | 'manual';
  // 该句对齐路径的平均 log-prob（越接近 0 越可信）。只在 timingSource==='auto' 时有意义，
  // 用来把「要人工校对的几句」排到前面。人工改过就清掉。
  timingConfidence?: number;
  blanks: Blank[];
  markedDifficult: boolean; // 跟读时跟不上的句子
  excluded: boolean; // 非朗读内容，如 Glossar（FR-1.4）
  /**
   * FR-15.2 / FR-5.3：句内每个词的音频区间，自动对齐顺带算出来的。
   *
   * **它在标注层，不在缓存层**（2026-09-02 改，见 SPEC §0 变更 26）。
   * 「丢了能不能重建」这条标准要按**设备**问：桌面上有音频+文稿就能重算，
   * 而手机跑不动对齐模型（iPhone 13 两档都被系统杀掉），在那台设备上它
   * 压根重建不出来 —— 放缓存层等于「只有对齐过的那台机器能逐词高亮」。
   * 用户的东西一律要备份，所以它跟着 Lesson 走：备份、同步、合并一行都不用改。
   *
   * 存在句子里而不是整课一个数组，是为了让合并/拆分/重新切句
   * 跟处理 `blanks` 用同一套办法（同为句内 offset，同样要平移、同样按切点分家）。
   */
  words?: WordSpan[];
}

/**
 * FR-15.2：一个词的音频区间。`charStart`/`charEnd` 是**句内** offset，
 * 与 `Blank.ranges` 同一套坐标 —— 听写时「只播这个挖空对应的词」是一次直接查找，
 * 通听时逐词高亮也是同一份数据。
 *
 * 刻意**不存**词序号：对齐器内部有一个（`src/align/target.ts` 的 `WordTiming.wordIndex`），
 * 但它数的是罗马化之后的词（`Work-and-Travel` 在那边是三个），和屏幕上看到的词对不上，
 * 存下来只会诱人拿它当下标用。要定位就用 offset。
 */
export interface WordSpan {
  charStart: number;
  charEnd: number;
  start: number; // 秒
  end: number;
}

export interface Blank {
  id: string;
  ranges: Array<{ start: number; end: number }>; // 句内 offset；多区间支持 "hing ... ab"
  surface: string; // 拼接后的表层形式："gelaufen" / "hing ab"
  lemma?: string; // V2 填充
  vocabEntryId: string; // 反向关联，听写结果回写 FSRS（FR-8.6）
}

export interface VocabEntry {
  id: string;
  surface: string;
  lemma?: string; // V2 → FR-16 落地后由内置词典填
  gender?: 'm' | 'f' | 'n';
  plural?: string;
  meaning?: string;
  /**
   * 音标（FR-16.3）。由内置词典填，人可以改。
   * 单独存一个字段而不是塞进 meaning：这个应用的痛点就是**听觉识别**，
   * 「这串音对应哪个词」是卡背上最该看见的一行，不该混在释义里。
   */
  ipa?: string;
  // ══ 来源：课程 或 预置词库（FR-17）══
  // 这三个字段**只有课程来的词条才有**。改成可选而不是给预置卡填 '' / -1，
  // 是为了让 TypeScript 逼着每个读它们的地方显式处理「没有原句」这件事 ——
  // 哨兵值只会把问题推到运行时，变成卡面上一句空白的原句。
  contextSentence?: string; // 原句，只存本地，永不进 ShareablePackage
  lessonId?: string;
  sentenceIndex?: number;
  /**
   * FR-17：这张卡来自预置词库，不来自任何课程。
   * `band` 是词频档（**不是 CEFR 等级**，见 FR-17.2），`rank` 是档内名次。
   * 释义/性/复数在建卡时就从内置词典拷进上面那几个字段了 ——
   * 词典是缓存层、可重建，而**复习过的卡不可重建**，所以卡自己必须是完整的（§2.3）。
   */
  preset?: { band: number; rank: number };
  dwKnowledgeId?: string; // 来自 Glossar 候选（FR-14）；也用于判断候选是否已接受
  hasTimestamp: boolean; // 来源句是否有 startTime（FR-10.5）
  suspended: boolean; // 暂停复习
  fsrs: FSRSCard; // ts-fsrs 状态
  createdAt: number;
  updatedAt: number;
}

// ts-fsrs 的 Card 形状（V1 落库前先占位声明，接入 ts-fsrs 时对齐其导出类型）。
export interface FSRSCard {
  due: number; // epoch ms
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: 0 | 1 | 2 | 3; // New / Learning / Review / Relearning
  last_review?: number; // epoch ms；§2.4 合并规则的比较键
  // 实现期补充：ts-fsrs 的 Card 还带 learning_steps（短期学习阶段走到第几步）。
  // 丢掉它会让「同一天内的二次复习」退化，故一并持久化。可选是为了兼容早于本次改动的备份文件。
  learning_steps?: number;
}

export interface Settings {
  newPerDay: number; // 10
  reviewPerDay: number; // 60
  shadowingGapRatio: number; // 1.2
  shadowingRepeat: number; // 2
  playbackRate: number; // 1.0
  dictationStrictCase: boolean; // true
  // FR-15：DW 自动导入后立刻跑一遍自动打点。默认开 ——
  // 「下载完就能直接练」是这个功能存在的理由，默认关掉等于没做。
  autoAlignOnImport: boolean;
  /**
   * FR-17.4a：面板上「报名哪一档」这个选择器的当前值。默认 **4**（3001–6000 名）。
   * 它**不代表已报名** —— 报名了哪些档看 `enrolledBands`。
   * 推荐第 4 档而不是第 1 档：前三档合起来约三千词，C1 的人全认识，
   * 从那里开始等于让人点几千次「太简单」才挖到有用的地方。
   */
  presetBand: number;
  /**
   * FR-17.4：**已报名**的词频档。卡片不在报名时建，而是由复习页按 `newPerDay`
   * 每天惰性激活 —— 一档三千个词，报名时全建出来要 60 次 MediaWiki 往返
   * 和 100MB 以上的录音。
   *
   * 默认空数组：报名会一路发卡几个月，这个决定不该由默认值替用户做。
   * 存档号而不是「进度游标」：**没学过哪些词是纯派生量**
   * （档内词表减去生词本里已有的词），落库反而要处理跨设备合并冲突。
   */
  enrolledBands: number[];
  /** FR-16.5：内置词典查不到时，允许联网查 de.wiktionary 补齐。默认开。 */
  onlineDictFallback: boolean;
  lastBackupAt?: number; // 备份提醒（FR-11.4 / FR-11.12）
  /**
   * 最后一次改动设置的时间。**设置整体同步之后才需要它**（§0 变更 28）：
   * 合并规则要一个比新旧的键，而 Settings 是一个没有 id 的单例对象，
   * 只能整体 last-write-wins —— 那就必须有这个字段，否则两台设备的设置无法定序。
   *
   * 缺失 = 「早于任何一次改动」（老库、或者从没改过设置）。
   * 只有 `useSettingsStore.update()` 写它，别处不要碰。
   */
  updatedAt?: number;
}

// ══════ 缓存层：本机持有，不同步，可随时丢弃 ══════
//
// 2026-09-02（§0 变更 27）之后这一层**只剩两样东西**：音频和原始文稿。
// 它们的共同点不是「可重建」，而是「**有一个记在标注层里的下载地址**」——
// `Lesson.audioSrc` 对应音频，`Lesson.source.sourceUrl` 对应文稿。
// 想往这里加字段，先问那个字段能不能从某个地址原样取回来；不能就该放标注层。
//
// 搬出去的两样：`wordTimings` → `Sentence.words`（变更 26）、
// `glossary` → `Lesson.glossary`（变更 27）。老库里可能还留着这两个字段的数据，
// 谁都不再读它们 —— 缓存层本来就是可以随时丢的（FR-3.8 清缓存会带走）。

export interface LessonCache {
  lessonId: string; // = Lesson.id
  manuscriptHtml?: string; // DW 原始 HTML；手动导入时存粘贴的原文
  plainText?: string; // 转换后的纯文本，Sentence.charStart/charEnd 的基准
  hasAudio: boolean;
  audioBytes: number; // 占用统计（FR-3.8），读它不必载入 Blob
  fetchedAt: number;
}

export interface GlossaryCandidate {
  dwKnowledgeId: string;
  sentenceIndex: number;
  ranges: Array<{ start: number; end: number }>; // 句内 offset
  surface: string; // "Plattformen"
  title: string; // "Plattform, -en (f.)"，原样保留以便降级（FR-14.4）
  lemma?: string; // 解析出的 "Plattform"
  gender?: 'm' | 'f' | 'n';
  plural?: string; // "-en"
  meaning?: string; // Knowledge.text 的纯文本
}

// 可分享包（V1 只实现函数 + 测试，不暴露 UI）
export interface ShareablePackage {
  formatVersion: 1;
  sourceUrl?: string;
  title?: string; // 仅内容标识，如 "Alltagsdeutsch, 2025-11-03"
  timings: Array<{ index: number; start: number; end: number }>;
  blanks: Array<{
    sentenceIndex: number;
    ranges: Array<{ start: number; end: number }>;
    lemma?: string;
  }>;
  // 绝不含：plainText / Sentence.text / Blank.surface / contextSentence
}
