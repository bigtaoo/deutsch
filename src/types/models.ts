// 数据模型 —— 原样转录自 SPEC.md §6。
// 判断一个字段属于哪层的标准只有一条：丢了能不能重建。
// 改动这个文件前先改 SPEC.md，不要让模型和文档漂移。

// ══════ 标注层：跨设备同步，永不可重建 ══════

export interface Lesson {
  id: string;
  title: string; // "Alltagsdeutsch: Der deutsche Wald"
  source:
    | { type: 'dw'; dwLessonId: string; sourceUrl: string } // 可补齐（FR-3.5）
    | { type: 'manual'; audioFileName?: string }; // 不可补齐（FR-3.6）
  audioDuration?: number; // 秒；补齐或重绑定时校验时长
  manuscriptHash?: string; // plainText 的 hash；补齐后校验 DW 是否改过稿（FR-3.7）
  sentences: Sentence[];
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
   * FR-17.4：从哪一档词频开始取预置词。默认 **4**（3001–6000 名）。
   * 不默认第 1 档：前三档合起来约三千词，C1 的人全认识，
   * 默认从那里开始等于让人点几千次「太简单」才挖到有用的地方。
   */
  presetBand: number;
  /** FR-16.5：内置词典查不到时，允许联网查 de.wiktionary 补齐。默认开。 */
  onlineDictFallback: boolean;
  lastBackupAt?: number; // 备份提醒（FR-11.4 / FR-11.12）
}

// ══════ 缓存层：本机持有，不同步，可随时丢弃 ══════

export interface LessonCache {
  lessonId: string; // = Lesson.id
  manuscriptHtml?: string; // DW 原始 HTML；手动导入时存粘贴的原文
  plainText?: string; // 转换后的纯文本，Sentence.charStart/charEnd 的基准
  glossary?: GlossaryCandidate[]; // FR-14 候选词
  // FR-15：词级时间戳。放缓存层是因为它**可重建**（有音频+文稿就能再算一遍），
  // 而且量不小（一课约 800 个词）。放标注层会让每次备份都胖一圈，
  // 却换不来任何「丢了不能重建」的东西 —— 这正是 §6 划分两层的那条标准。
  wordTimings?: WordTiming[];
  hasAudio: boolean;
  audioBytes: number; // 占用统计（FR-3.8），读它不必载入 Blob
  fetchedAt: number;
}

/**
 * FR-15：一个词的时间戳。charStart/charEnd 是**句内** offset，
 * 和 Blank.ranges 同一套坐标 —— 这样听写时「只播这个挖空对应的词」是一次直接查找。
 */
export interface WordTiming {
  sentenceIndex: number; // 指向 Sentence.index
  wordIndex: number; // 句内第几个词，从 0 开始
  charStart: number;
  charEnd: number;
  start: number; // 秒
  end: number;
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
