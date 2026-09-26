import { getDB } from './index';
import { META_KEYS } from './schema';
import type { Settings } from '@/types/models';

export const DEFAULT_SETTINGS: Settings = {
  newPerDay: 10,
  reviewPerDay: 60,
  shadowingGapRatio: 1.2,
  // 默认 1（2026-09-26 从 2 改来）：有了录音回放（FR-6.8），一遍就是「听 → 跟读 → 听自己」完整的一轮。
  shadowingRepeat: 1,
  // FR-6.8：每一遍都录音并回放，默认开。
  shadowingEcho: true,
  playbackRate: 1.0,
  dictationStrictCase: true,
  autoAlignOnImport: true,
  // FR-17.4a：面板上推荐第 4 档（3001–6000 名）—— 理由见 models.ts 里那段注释。
  presetBand: 4,
  // FR-17.4：默认**不报名任何档**。报名会一路发卡几个月，不该由默认值替用户决定。
  enrolledBands: [],
  onlineDictFallback: true,
  // FR-19.4：译文默认不显示 —— 和「文本默认折叠」同一个理由，先用耳朵。
  showTranslation: false,
  // FR-10.12：音效默认开。答对答错的即时反馈是这张卡片存在的一半，
  // 默认关掉等于让人先去设置里把它打开才拿得到。
  soundEffects: true,
};

export async function getSettings(): Promise<Settings> {
  const db = await getDB();
  const stored = await db.get('meta', META_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings> | undefined) };
}

export async function putSettings(settings: Settings): Promise<void> {
  const db = await getDB();
  await db.put('meta', settings, META_KEYS.settings);
}

/** 通用 meta 读写：GitHub token、仓库信息、备份状态等都走这两个函数。 */
export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await getDB();
  return db.get('meta', key) as Promise<T | undefined>;
}

export async function putMeta<T>(key: string, value: T): Promise<void> {
  const db = await getDB();
  await db.put('meta', value, key);
}

export async function deleteMeta(key: string): Promise<void> {
  const db = await getDB();
  await db.delete('meta', key);
}
