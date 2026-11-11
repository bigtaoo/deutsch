// FR-10.12：复习时的三个音效 —— 点一下选项、答对、答错。
//
// ── 为什么是 <audio>，而不是 Web Audio（变更 87）──
// 这个模块在 iPhone 上「修好」过三次（变更 51 等 resume、变更 77 声明会话类别、
// 变更 80 补 interrupted/closed），每次都没声音。第四次拿到的真机证据是一行
// `right：还没取到，跳过` —— 也就是说前三次修的都是**播放**那一端，而链条在更前面
// 就断了：三个 wav 根本没被 fetch + decodeAudioData 成功过。更糟的是旧的 preloadSfx
// 幂等且「失败不重试」，所以开头那一次失败会把音效**永久**关掉，连设置页的试听也救不回来。
//
// 现在整条 fetch + decode 链都不要了，交给 <audio>：给 src 就行，加载、缓冲、重试
// 都是浏览器的事，而且它天然是「媒体」而不是「环境音」—— 静音开关管不着它。
// 这一点有一组现成的对照：同一台静音的手机上，走 <audio> 的课文一直正常播放。
//
// ── 这不违反 §3.2 的「所有播放走一个 <audio> 单例」，但它是那条规矩的例外 ──
// 单例是为了 iOS 的手势链：课文、练习、跟读共用一个元素，谁后加载谁把前一个顶掉。
// 音效偏偏要和它们**同时**响（听卡上德语句子还在播时你就答了题），所以三个音效
// 各有自己的元素，和那个单例分开。不插进 DOM —— iOS 上 new Audio() 一样能播。
//
// ── iOS 的解锁 ──
// 「答对 / 答错」是 120ms 之后从 setTimeout 里响的，那时已经不在手势里，iOS 会拒播。
// 所以在 document 上挂一个捕获阶段的 touchend / click：**第一次**点击时把三个元素
// 各静音播一下再停住。解锁过的元素之后可以随时播。
//
// ── 失败静默，但留痕 ──
// 这个模块里没有一件事值得让复习页报错，所以每个出口仍然是 return、不抛、不写界面。
// 但「静默」正是它三次「修好了」都没人说得清卡在哪的原因，所以每一步都在内存里记一笔
// （`sfxStatus()`），设置页的试听会把这几笔**全部**列出来 —— 上一次只给看最后一笔，
// 而最后一笔恰恰是症状，不是原因。
//
// ── 静音开关 ──
// 跟读录音期间会把会话切成 play-and-record（session.ts）。那一档下音效照样该响，
// 所以播之前仍然声明一次 playback —— 它只在「录音没在跑」时才真的改类别。

import { currentSessionType, preferPlaybackSession } from './session';

/** 三个音效。名字是用途，不是文件名 —— 换音效只改 FILES 那张表。 */
export type SfxName = 'tap' | 'right' | 'wrong';

const FILES: Record<SfxName, string> = {
  tap: 'tap.wav',
  right: 'right.wav',
  wrong: 'wrong.wav',
};

const NAMES = Object.keys(FILES) as SfxName[];

/**
 * 统一衰减。三个文件都已经把峰值归一到 0.85（public/sfx/CREDITS.md），
 * 这里再压一道是因为它们要压在德语音频**上面**响：等响度的提示音会盖住句子。
 */
const VOLUME = 0.55;

/** 内存里最多留多少笔。 */
const MAX_EVENTS = 24;

const elements = new Map<SfxName, HTMLAudioElement>();
let unlocked = false;
let unlockInstalled = false;
const events: string[] = [];
const bootAt = Date.now();

function note(text: string): void {
  events.push(`+${((Date.now() - bootAt) / 1000).toFixed(1)}s ${text}`);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** 走 `BASE_URL` 而不是写死 `/`：原生壳里的 base 由构建决定（和 share/photos.ts 同一条）。 */
function sfxUrl(name: SfxName): string {
  return `${import.meta.env.BASE_URL}sfx/${FILES[name]}`;
}

/** 元素的加载状态，给诊断用 —— 数字是 HTMLMediaElement.readyState。 */
function readyText(el: HTMLAudioElement): string {
  return `readyState=${el.readyState}${el.error ? ` error=${el.error.code}` : ''}`;
}

function element(name: SfxName): HTMLAudioElement | null {
  const existing = elements.get(name);
  if (existing) return existing;
  if (typeof Audio === 'undefined') {
    note('这个环境没有 Audio');
    return null;
  }
  try {
    const el = new Audio(sfxUrl(name));
    el.preload = 'auto';
    el.volume = VOLUME;
    // 音效是一声就完的东西，没有「继续播」可言；写出来是为了不被别处的
    // Media Session 或自动播放策略当成一段媒体来接管。
    el.loop = false;
    el.addEventListener('error', () => {
      note(`${name}：加载失败 ${readyText(el)}`);
    });
    elements.set(name, el);
    return el;
  } catch (e) {
    note(`${name}：建不出元素 ${errorText(e)}`);
    return null;
  }
}

/**
 * 第一次点击时把三个元素解锁（见模块头「iOS 的解锁」）。
 * 静音播一下再停 —— 解锁本身不该发出声音。
 */
function unlockAll(): void {
  if (unlocked) return;
  unlocked = true;
  preferPlaybackSession();
  for (const name of NAMES) {
    const el = element(name);
    if (!el) continue;
    const wasMuted = el.muted;
    el.muted = true;
    const p = el.play();
    const settle = (): void => {
      try {
        el.pause();
        el.currentTime = 0;
      } catch {
        // 还没加载到能 seek 的程度 —— 不要紧，下一次真的要响时再说。
      }
      el.muted = wasMuted;
    };
    if (p && typeof p.then === 'function') {
      p.then(settle, (e: unknown) => {
        settle();
        note(`${name}：解锁被拒 ${errorText(e)}`);
      });
    } else {
      settle();
    }
  }
  note('已趁手势解锁三个音效');
}

/** 任何一次点击都顺手解锁（只会真的跑一次）。 */
function installUnlockOnTap(): void {
  if (unlockInstalled || typeof document === 'undefined') return;
  unlockInstalled = true;
  const once = (): void => unlockAll();
  document.addEventListener('touchend', once, { capture: true, passive: true });
  document.addEventListener('click', once, { capture: true });
}

/**
 * 建好三个元素并让浏览器开始缓冲。**进复习页时调一次**：第一次答题才开始加载的话，
 * 提示音会比「答对」那一闪晚半秒到，而晚到的反馈比没有反馈更让人分神。
 *
 * 和旧版不同的是**它可以反复调、而且会重试** —— 旧版那个「失败不重试」的幂等
 * promise 正是音效在真机上永久失效的原因。已经能播的元素不会被打断。
 */
export function preloadSfx(): Promise<void> {
  installUnlockOnTap();
  let built = 0;
  for (const name of NAMES) {
    const el = element(name);
    if (!el) continue;
    built += 1;
    // HAVE_NOTHING，或上一次加载出过错：重新来一遍。正在播的不动。
    if ((el.readyState === 0 || el.error) && el.paused) {
      try {
        el.load();
      } catch (e) {
        note(`${name}：load() 抛错 ${errorText(e)}`);
      }
    }
  }
  note(`预热 ${built}/${NAMES.length}`);
  return Promise.resolve();
}

/**
 * 响一下。
 *
 * 和旧版最大的区别：**不再有「还没取到就跳过」这个出口**。给 <audio> 下播放指令，
 * 还没缓冲完就让它自己去缓冲 —— 迟到的音效也比「这一声永远不会响」强，何况
 * 这里是三个几十 KB 的本地文件。
 */
export function playSfx(name: SfxName): void {
  const el = element(name);
  if (!el) return;
  installUnlockOnTap();
  preferPlaybackSession();
  try {
    // 连着答两题时上一声可能还没放完 —— 从头开始，而不是排队。
    el.currentTime = 0;
  } catch {
    // 还没加载到能 seek 的程度，直接播就是。
  }
  let p: Promise<void> | undefined;
  try {
    p = el.play();
  } catch (e) {
    note(`${name}：play() 抛错 ${errorText(e)}`);
    return;
  }
  const session = currentSessionType() ?? '无API';
  if (p && typeof p.then === 'function') {
    p.then(
      () => note(`${name}：响 ${readyText(el)} 会话=${session}`),
      (e: unknown) => note(`${name}：被拒 ${errorText(e)} ${readyText(el)} 会话=${session}`),
    );
  } else {
    note(`${name}：已下指令 ${readyText(el)} 会话=${session}`);
  }
}

/**
 * 设置页「试听」用：**从点击处理器里同步调**，趁手势解锁，之后再 playSfx ——
 * 不然手势就白白过去了。
 */
export function wakeSfx(): void {
  installUnlockOnTap();
  unlockAll();
}

/** 最近一笔记录。 */
export function lastSfxEvent(): string | null {
  return events.at(-1) ?? null;
}

/** 试听按钮用：这一趟走过的每一步。只给最后一笔的话，看到的永远是症状不是原因。 */
export function sfxEvents(): string[] {
  return [...events];
}

/** 给诊断报告用：音效这条链此刻的样子，加上最近几次响 / 没响的原因。 */
export interface SfxStatus {
  hasAudioContext: boolean;
  state: string;
  loaded: SfxName[];
  session: string;
  events: string[];
}

export function sfxStatus(): SfxStatus {
  const loaded = NAMES.filter((n) => {
    const el = elements.get(n);
    return !!el && el.readyState >= 2 && !el.error;
  });
  const states = NAMES.map((n) => {
    const el = elements.get(n);
    return `${n}=${el ? readyText(el) : '没建'}`;
  });
  return {
    // 名字留着不改：诊断报告的字段名在服务端收件箱里已经有历史数据了。
    // 现在它的含义是「这个环境能不能建 <audio>」。
    hasAudioContext: typeof Audio !== 'undefined',
    state: `${unlocked ? '已解锁' : '未解锁'} ${states.join(' ')}`,
    loaded,
    session: currentSessionType() ?? '无 navigator.audioSession',
    events: [...events],
  };
}

/** 只给测试用：把模块状态清回没初始化过的样子。 */
export function resetSfxForTests(): void {
  elements.clear();
  unlocked = false;
  unlockInstalled = false;
  events.length = 0;
}
