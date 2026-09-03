// FR-11.19（§0 变更 34）：**自动增量拉取** —— 让「跨设备」真的是自动的。
//
// 变更 34 之前，同步只有一半是自动的：推是自动的（FR-11.6/11.7/11.7a），
// 拉只有设置页那个「从服务器恢复」按钮（FR-11.13）。后果是在桌面上导入并对齐完一课，
// 手机上什么都不会发生 —— 界面上和「同步坏了」一模一样，而用户能想到的下一步
// 往往是**在手机上重新导入一遍**：那条路 `generateId()` 会建出第二门课，
// 标注全空，还要在手机上重跑十几分钟的对齐。整个 FR-11 的收益就这样漏掉了。
//
// ── 为什么是「增量」而不是复用 restore.ts ──
// `restoreFromServer()` 无条件把每个文档都拉一遍全文。手动按一次没问题，
// 但这条路每次启动和每次回前台都要走：几十课 × 几十 KB，在弱网下是纯浪费。
// 而后端的 `GET /v1/docs` 列表里带 `version`，本地又一直记着「我知道的版本号」
// （docs.ts 的 syncVersions，本来是给乐观并发用的）—— 两个数一比就知道该拉谁。
// 于是常态下这条路只有**一次**列表请求。
//
// ── 合并 ──
// 走 §2.4 的同一套规则，一个字都不改：课程整体比 updatedAt，生词逐条比 fsrs.last_review，
// 设置整体比 updatedAt。「拉」不等于「远端赢」——本地更新时保留本地，并且回推一次
// （`vocabNeedsPush` / `settingsNeedsPush`），否则本地那份新数据会一直停在这台设备上。
//
// ── 刻意不做的一件事：跟随删除 ──
// 「本地记着版本号、远端列表里却没有」是「另一台设备删了这一课」的强信号，
// 但也可能是服务器数据出了问题。自动删课是不可逆的，而这条路每次启动都跑 ——
// 判断错一次就静默删掉用户的标注。删除仍然只在本机发起（syncLessonDeletion）。

import { getLesson, putLesson } from '@/db/lessons';
import { getAllVocabEntries, putVocabEntry } from '@/db/vocab';
import { getMeta, getSettings, putMeta, putSettings } from '@/db/meta';
import { META_KEYS } from '@/db/schema';
import { mergeSettings, mergeVocabEntries } from '@/backup/merge';
import type { Lesson, Settings, VocabEntry } from '@/types/models';
import { SyncAuthError } from './client';
import { getSessionToken } from './session';
import {
  SETTINGS_DOC_ID,
  VOCAB_DOC_ID,
  getKnownVersion,
  getRemoteDoc,
  lessonIdFromDocId,
  listRemoteDocs,
  rememberVersion,
} from './docs';

export interface PullResult {
  /** 远端有多少个文档 */
  checked: number;
  /** 版本号变了、真的拉了全文的 */
  fetched: number;
  /** 远端赢了、写进本地库的课程数 */
  lessonsWritten: number;
  /** 远端赢了、写进本地库的生词条数 */
  vocabWritten: number;
  settingsWritten: boolean;
  /** 本地有远端没有（或本地更新）的生词 —— 调用方该回推一次 */
  vocabNeedsPush: boolean;
  settingsNeedsPush: boolean;
  /** 本地这几课比远端新（多半是两台设备的钟差）—— 同样要回推，否则它们停在这台设备上 */
  lessonsNeedPush: string[];
  /** 单个文档坏掉不该让整次拉取失败：坏的记在这里，好的照常写入。 */
  failures: string[];
}

function emptyResult(): PullResult {
  return {
    checked: 0,
    fetched: 0,
    lessonsWritten: 0,
    vocabWritten: 0,
    settingsWritten: false,
    vocabNeedsPush: false,
    settingsNeedsPush: false,
    lessonsNeedPush: [],
    failures: [],
  };
}

/** 有没有真的往本地库里写进东西 —— 调用方据此决定要不要让内存里的 store 重读。 */
export function pullWroteData(result: PullResult): boolean {
  return result.lessonsWritten > 0 || result.vocabWritten > 0 || result.settingsWritten;
}

/**
 * 拉一次。`force` 时无视版本号比较，把每个文档都拉全文
 * （「从服务器恢复」那个按钮走的仍是 restore.ts；这里的 force 留给测试与排障）。
 *
 * 未登录时抛 SyncAuthError —— 与推送那一侧一致，由调用方决定是报警还是静默跳过。
 */
export async function pullFromServer(options: { force?: boolean } = {}): Promise<PullResult> {
  const token = await getSessionToken();
  if (!token) throw new SyncAuthError('尚未登录');

  const result = emptyResult();
  const metas = await listRemoteDocs(token);
  result.checked = metas.length;

  for (const meta of metas) {
    const known = await getKnownVersion(meta.id);
    // 本地记的版本号和远端一致 = 这个文档自上次以来没被别的设备改过。
    // 注意这里**不能**因为「本地没有这一课」就跳过：版本号一致意味着上次拉/推的时候
    // 它就在本地了，缺了才是别的问题（缓存层被清不影响标注层）。
    if (!options.force && known !== null && known === meta.version) continue;

    try {
      if (meta.id === VOCAB_DOC_ID) {
        await pullVocab(token, meta.id, result);
      } else if (meta.id === SETTINGS_DOC_ID) {
        await pullSettings(token, meta.id, result);
      } else if (lessonIdFromDocId(meta.id) !== null) {
        await pullLesson(token, meta.id, result);
      }
      // 不认识的文档类型：跳过，也不记版本号（将来的版本可能认识它）。
    } catch (err) {
      result.failures.push(`${meta.id}：${err instanceof Error ? err.message : err}`);
    }
  }

  await recordPullAt(Date.now());
  return result;
}

async function pullLesson(token: string, docId: string, result: PullResult): Promise<void> {
  const doc = await getRemoteDoc<Lesson>(token, docId);
  if (!doc) return; // 刚被删掉：下一次列表里就没有它了，这里什么都不用做
  result.fetched++;

  const local = await getLesson(doc.body.id);
  // §2.4：整体比 updatedAt。相等时保留本地 —— 确定性优先，内容大概率一样。
  if (!local || doc.body.updatedAt > local.updatedAt) {
    await putLesson(doc.body);
    result.lessonsWritten++;
  } else if (local.updatedAt > doc.body.updatedAt) {
    result.lessonsNeedPush.push(local.id);
  }
  // 先记版本号再回推，那次推送才能带上正确的 baseVersion（否则白撞一个 409）。
  await rememberVersion(docId, doc.version);
}

async function pullVocab(token: string, docId: string, result: PullResult): Promise<void> {
  const doc = await getRemoteDoc<VocabEntry[]>(token, docId);
  if (!doc) return;
  result.fetched++;

  const remote = Array.isArray(doc.body) ? doc.body : [];
  const local = await getAllVocabEntries();
  const { merged, summary } = mergeVocabEntries(local, remote);

  // 只写远端赢了的那几条，不是整库回写 —— 生词上千条时那是一次没必要的全表写入。
  const changed = new Set([...summary.addedVocab, ...summary.updatedVocab]);
  await Promise.all(merged.filter((e) => changed.has(e.id)).map((e) => putVocabEntry(e)));
  result.vocabWritten += changed.size;

  // 本地有远端赢不了的东西（本地更新的条目，或远端压根没有的条目）：要回推。
  // 先记版本号再回推，那次推送才能带上正确的 baseVersion（否则白撞一个 409）。
  await rememberVersion(docId, doc.version);
  if (summary.skippedVocab.length > 0 || merged.length > remote.length) {
    result.vocabNeedsPush = true;
  }
}

async function pullSettings(token: string, docId: string, result: PullResult): Promise<void> {
  const doc = await getRemoteDoc<Settings>(token, docId);
  if (!doc) return;
  result.fetched++;

  const local = await getSettings();
  const { merged, changed } = mergeSettings(local, doc.body);
  if (changed) {
    await putSettings(merged);
    result.settingsWritten = true;
  }
  await rememberVersion(docId, doc.version);
  if (!changed && (local.updatedAt ?? 0) > (doc.body.updatedAt ?? 0)) {
    result.settingsNeedsPush = true;
  }
}

// ── 「上次拉取」的时刻 ────────────────────────────────────────────────────
// 和「上次推送成功」分开记（FR-11.9 的状态条两个都显示）：推成功不代表拉通了，
// 而「拉悄悄停了」的症状恰恰是「另一台设备上的东西一直不来」—— 没有这一行的话，
// 状态条会一片绿，用户只能靠猜。

interface PersistedSyncStatus {
  lastSuccessAt?: number;
  lastPullAt?: number;
}

async function recordPullAt(at: number): Promise<void> {
  const existing = (await getMeta<PersistedSyncStatus>(META_KEYS.syncStatus)) ?? {};
  await putMeta(META_KEYS.syncStatus, { ...existing, lastPullAt: at });
}
