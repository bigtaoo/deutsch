// AI 补充解释（FR-9.11 / FR-9.12，2026-09-22 从「复制走 → 在外面问 → 粘回来」
// 改成服务器端实时调用）。服务端那一半在 `server/src/ai.ts`。
//
// ── 两个入口，同一个函数 ──
// 查词面板（DictLookup）——查到的词是按钮入口，查不到时自动问一次——以及生词本页
// 每一行的「问 AI」按钮，要的都是「给一段中文解释」。区别只在有没有 context（原句）/
// existing（词典已给的释义），由调用方决定传不传，这里不关心是从哪个入口来的。
//
// ── 为什么不像 remoteEmissions.ts 那样自己拼 fetch，而是用 syncFetch ──
// 对齐那条路要处理「服务器明确说不做对齐」这种要长期记住的状态（跨多次导入都不用再问）。
// 这里没有那种状态：失败了就是失败了，下次点「问 AI」再试一次的成本是一次点击，
// 不值得为它建一套专门的错误分类。唯一值得记住的「不用再问」是下面的 `serverSaidOff`，
// 免得没配置的时候每次点都发一次注定失败的请求。
//
// ── 答案本身也缓存（变更 49）──
// 上面那条「不值得缓存」说的是错误分类，不是答案：同一个词被问过一次之后，答案本身
// 值得记住并跟着账号同步（ai/cache.ts）——这一课学一次、复习时又查一次，答案大概率
// 还一样，没必要再花一次 API 调用去确认。`explainWithAi` 每次成功都会覆盖式地把新答案
// 写回缓存（「重新问」本来就是想要新答案覆盖旧的），调用方在查词时可以先用
// `getCachedAiNote` 看一眼有没有现成的，不用等用户点按钮。
//
// ── 失败一律呈现成「AI 服务暂时不可用」──
// 没登录、服务器没配 key、上游限流、网络错误——原因不同，但用户能做的事一样：
// 过一会儿再试，或者去看设置页的登录状态。区分这些原因换不来任何有用的下一步动作。

import { syncFetch, SyncApiError } from '@/sync/client';
import { isSyncConfigured } from '@/sync/config';
import { getSessionToken } from '@/sync/session';
import { scheduleAiCacheSync } from '@/sync/trigger';
import { rememberAiNote } from './cache';

/** 变更 49：查一个词有没有问过 AI、缓存过答案 —— 重新导出，调用方不用分两处 import。 */
export { getCachedAiNote } from './cache';

export interface ExplainInput {
  /** 要解释的德语词或短句。 */
  word: string;
  /** 原句语境，有就传 —— 查不到的复合词/搭配，原句往往是唯一线索。 */
  context?: string;
  /** 词典已经给出的释义（内置词典 / de.wiktionary），有就传，让模型别重复、只补充或纠偏。 */
  existing?: string;
}

/** 这台服务器明确没配 `ANTHROPIC_API_KEY`。记在模块级，避免每次点「问 AI」都白问一次。 */
let serverSaidOff = false;

/** 退出登录、换账号、或想重新探一次时调用（与 remoteEmissions.ts 的同名函数同一个理由）。 */
export function resetAiAvailability(): void {
  serverSaidOff = false;
}

/**
 * 便宜的判断：只看「配了同步服务器 + 登录过 + 没被服务器说过不做」，不发请求。
 * 用来决定要不要在界面上显示「问 AI」这条路，而不是显示了又每次点都报错。
 */
export async function aiAvailable(): Promise<boolean> {
  if (serverSaidOff || !isSyncConfigured()) return false;
  return (await getSessionToken()) !== undefined;
}

/**
 * 问一次 AI。抛出的 Error 消息可以直接展示给用户（面板统一呈现成
 * 「AI 服务暂时不可用」，不需要区分具体原因，见文件头）。
 */
export async function explainWithAi(input: ExplainInput): Promise<string> {
  const token = await getSessionToken();
  if (!token) throw new Error('尚未登录，无法使用 AI 解释');

  try {
    const { note } = await syncFetch<{ note: string }>('/v1/ai/explain', {
      method: 'POST',
      body: input,
      token,
    });
    // 问到的结果记下来、跨设备同步（变更 49）——下次查同一个词直接显示，不用再问一遍。
    void rememberAiNote(input.word, note).then(() => scheduleAiCacheSync());
    return note;
  } catch (err) {
    if (err instanceof SyncApiError && err.status === 503) serverSaidOff = true;
    throw err;
  }
}
