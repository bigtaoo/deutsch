// FR-22 速背的数据形状。
//
// 两份东西，分属两层（§2.3）：
//   Wordbank   —— 词库本身。**缓存层**：放在同步服务器上（GET /v1/wordbank），
//                 本机只存一份副本，丢了随时再拉，不进备份。
//   DrillState —— 我的进度、我加的词、我的标记与改过的中文、偏好。**标注层**：
//                 不可重建，走第六种同步文档 `drill`，并进本地备份。
//
// 字段名在 Wordbank 里刻意是一两个字母：六千条 × 每条五六个字段，
// 与 dict/types.ts 同一个理由。DrillState 是自己的数据，不省这点。

import type { FSRSCard } from '@/types/models';

export type DrillMode = 'audio' | 'word';

/** 词性。与内置词典对齐的那几个，外加一个兜底。 */
export type DrillPos = 'noun' | 'verb' | 'adj' | 'adv' | 'other';

/** 十四个主题（生成时的分组，也是服务器上 TSV 的文件名）。界面上只露三大类，见 CATEGORY_OF。 */
export type DrillTopic =
  | 'wohnen'
  | 'gesundheit'
  | 'konsum'
  | 'unterwegs'
  | 'miteinander'
  | 'beruf'
  | 'projekt'
  | 'wirtschaft'
  | 'entwicklung'
  | 'infrastruktur'
  | 'gesellschaft'
  | 'ausdruck'
  | 'kommunikation'
  | 'daten';

/** 三大类（FR-22.1）+ 我手动加的（FR-22.10）。 */
export type DrillCategory = 'daily' | 'work' | 'it' | 'mine';

export const CATEGORY_OF: Record<DrillTopic, Exclude<DrillCategory, 'mine'>> = {
  wohnen: 'daily',
  gesundheit: 'daily',
  konsum: 'daily',
  unterwegs: 'daily',
  miteinander: 'daily',
  beruf: 'work',
  projekt: 'work',
  wirtschaft: 'work',
  entwicklung: 'it',
  infrastruktur: 'it',
  gesellschaft: 'daily',
  ausdruck: 'daily',
  kommunikation: 'work',
  daten: 'it',
};

export const CATEGORY_LABELS: Record<DrillCategory, string> = {
  daily: '日常',
  work: '工作',
  it: 'IT',
  mine: '我加的',
};

/** 词库里的一条。 */
export interface WordbankItem {
  /** 稳定 id：归一化词形；同形不同词性时后缀 `#词性`。进度就挂在这个 id 上。 */
  id: string;
  /** 词形（词典原形，名词不带冠词）。 */
  w: string;
  p: DrillPos;
  /** 名词的性；只有复数形式的名词是 `pl`。 */
  g?: 'm' | 'f' | 'n' | 'pl';
  /** 一句话中文（正确答案的底稿）。 */
  zh: string;
  /** 备注：`sich ~`、`~ auf + A.`、「口语」…… */
  n?: string;
  t: DrillTopic;
}

export interface Wordbank {
  /** 内容哈希。客户端带着它问服务器「变了没有」。 */
  version: string;
  items: WordbankItem[];
}

/** 本机存的那一份词库副本，外加「什么时候从服务器拿到的」。 */
export interface CachedWordbank extends Wordbank {
  fetchedAt: number;
}

/** 某个模式下某个词的调度状态。`ts` 是合并用的键（逐键 LWW，FR-22.11）。 */
export interface DrillProgress {
  card: FSRSCard;
  ts: number;
}

/** 我在查词面板里加的词（FR-22.10）。形状与 WordbankItem 对齐，好让它们进同一个池子。 */
export interface DrillCustomItem {
  id: string;
  w: string;
  p: DrillPos;
  g?: 'm' | 'f' | 'n' | 'pl';
  zh: string;
  n?: string;
  ts: number;
  /** 墓碑：删掉的手动词要留一条，否则另一台设备合并时会把它复活。 */
  deleted?: true;
}

/** 标记与改过的中文（FR-22.9）。取消标记不丢 `zh`。 */
export interface DrillMark {
  flagged: boolean;
  /** 我改过的中文；没改过是 undefined。 */
  zh?: string;
  ts: number;
}

export interface DrillPrefs {
  mode: DrillMode;
  roundSize: number;
  categories: DrillCategory[];
  ts: number;
}

export interface DrillState {
  /** 键是 `${mode}:${itemId}` —— 两种模式各一份进度（FR-22.4）。 */
  progress: Record<string, DrillProgress>;
  custom: Record<string, DrillCustomItem>;
  marks: Record<string, DrillMark>;
  prefs: DrillPrefs;
  updatedAt: number;
}

/** 一轮里真正出题用的那一条：词库条目或手动词，统一成一个形状。 */
export interface PoolItem {
  id: string;
  w: string;
  p: DrillPos;
  g?: 'm' | 'f' | 'n' | 'pl';
  /** **已经套上我改过的那一版**（marks[id].zh 优先）。 */
  zh: string;
  n?: string;
  category: DrillCategory;
}
