// FR-10.12：复习时的三个音效 —— 点一下选项、答对、答错。
//
// ── 为什么走 Web Audio，而不是那个全局单例 <audio> ──
// §3.2 定下的规矩是「所有播放走一个 `<audio>` 单例」，那是为了 iOS 的手势链约束。
// 但音效和它要**同时**响：听卡上德语句子还在播的时候你就答了题，而单例只有一个，
// 谁后加载谁把前一个顶掉 —— 结果是「答对的提示音把正在听的那一句掐了」。
// Web Audio 是另一条输出链，和 <audio> 互不相干，所以这里是那条规矩的唯一例外。
//
// ── iOS 上的手势链在这里仍然成立 ──
// AudioContext 在没有手势的情况下建出来是 `suspended` 的。所以 `playSfx` 每次
// 都先 `resume()`（它自己就跑在点击处理器里，是合法的手势），**等它真的 resolve
// 了再 start**。之前的写法是 resume 不等就直接 start：Chrome 桌面上这样也响
// （排上去的音会在 resume 之后立刻响，不丢），但在真机上验证时发现 WKWebView
// 不认这一套——在 suspended 的上下文里 start() 排的音，resume 之后并不会响，
// 静默丢在原地（没有报错，因为整个模块的失败出口本来就是「不抛不提示」）。
//
// ── 不只是 suspended：还有 interrupted 和 closed（变更 80）──
// 变更 51 只处理了 `suspended`。但 WebKit 在 iOS 上还有一个非标准的 `interrupted`：
// 音频会话被别人动过（课文的 `<audio>` 一开一停、来电、切后台）之后，上下文停在
// 这一档。复习页偏偏就是「刚放完一句德语 → 马上点选项」，旧代码看到不是
// suspended 就直接 start()，排进一个不在跑的上下文里 —— 和变更 51 一模一样的
// 静默丢失，只是换了个状态名。现在的规矩是：**不是 running 就先 resume**；
// `closed`（系统回收）就扔掉重建，AudioBuffer 不绑上下文，解码好的三声照用。
//
// ── 每一次点击都顺手叫醒 ──
// 「答对 / 答错」是 120ms 之后从 setTimeout 里响的，那时已经不在手势里了。
// 所以在 document 上挂一个捕获阶段的 touchend / click：任何一次点击，只要上下文
// 不在跑，就趁着手势 resume 一下。
//
// ── 失败静默，但留痕 ──
// 这个模块里没有一件事值得让复习页报错，所以每个出口仍然是 return、不抛、
// 不往界面上写字。但「静默」正是它在真机上两次「修好了」都没人说得清卡在哪的原因，
// 所以每一次响、每一次没响都在内存里记一笔（`sfxStatus()`），设置页的诊断报告
// 会带上它 —— 下一次真机没声音，报告里写着停在哪一步。
//
// ── 静音开关 ──
// WebKit 把「只有 Web Audio 在响」归成环境音，跟着静音开关走（课文的 `<audio>` 不受影响）。
// 所以每次响之前都声明一次 playback 会话，见 session.ts。

import { currentSessionType, preferPlaybackSession } from './session';

/** 三个音效。名字是用途，不是文件名 —— 换音效只改 FILES 那张表。 */
export type SfxName = 'tap' | 'right' | 'wrong';

const FILES: Record<SfxName, string> = {
  tap: 'tap.wav',
  right: 'right.wav',
  wrong: 'wrong.wav',
};

/**
 * 统一衰减。三个文件都已经把峰值归一到 0.85（public/sfx/CREDITS.md），
 * 这里再压一道是因为它们要压在德语音频**上面**响：等响度的提示音会盖住句子。
 */
const GAIN = 0.55;

/**
 * resume 最多等多久。iOS 上被打断的上下文，resume 的 promise 可能一直不 settle
 * （「永不 settle」在这个项目里已经咬过好几次）。等不到就算这一声没了 ——
 * 迟到一秒半的「答对」音已经对不上它要确认的那个动作。
 */
const RESUME_TIMEOUT_MS = 1500;

/** 内存里最多留多少笔。 */
const MAX_EVENTS = 20;

type Ctor = new () => AudioContext;

let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
const buffers = new Map<SfxName, AudioBuffer>();
let preloading: Promise<void> | null = null;
let resuming: Promise<boolean> | null = null;
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

function contextCtor(): Ctor | null {
  const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function audioContext(): AudioContext | null {
  // 被系统回收的上下文再也起不来，只能换一个新的。
  if (ctx && ctx.state === 'closed') {
    note('上下文已 closed，重建');
    ctx = null;
    gain = null;
    resuming = null;
  }
  if (ctx) return ctx;
  const Ctor = contextCtor();
  if (!Ctor) return null;
  preferPlaybackSession();
  try {
    ctx = new Ctor();
    gain = ctx.createGain();
    gain.gain.value = GAIN;
    gain.connect(ctx.destination);
    note(`建上下文 state=${ctx.state}`);
  } catch (e) {
    note(`建上下文失败 ${errorText(e)}`);
    ctx = null;
    gain = null;
  }
  return ctx;
}

/**
 * 让上下文跑起来。同一时刻只有一趟 resume 在飞，后来的人等同一个结果。
 * **必须同步地从手势里调到这里**（iOS 只认手势当下发起的 resume）。
 */
function ensureRunning(context: AudioContext): Promise<boolean> {
  if (context.state === 'running') return Promise.resolve(true);
  if (resuming) return resuming;
  const from = context.state;
  let attempt: Promise<void>;
  try {
    attempt = context.resume();
  } catch (e) {
    note(`resume 抛错 ${errorText(e)}`);
    return Promise.resolve(false);
  }
  const p = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      note(`resume 超时（${from} → ${context.state}）`);
      resolve(false);
    }, RESUME_TIMEOUT_MS);
    attempt.then(
      () => {
        clearTimeout(timer);
        note(`resume ${from} → ${context.state}`);
        resolve(context.state === 'running');
      },
      (e: unknown) => {
        clearTimeout(timer);
        note(`resume 被拒（${from}）${errorText(e)}`);
        resolve(false);
      },
    );
  });
  resuming = p;
  void p.then(() => {
    if (resuming === p) resuming = null;
  });
  return p;
}

/** 任何一次点击都趁着手势把上下文叫醒（见模块头「每一次点击都顺手叫醒」）。 */
function installWakeOnTap(): void {
  if (unlockInstalled || typeof document === 'undefined') return;
  unlockInstalled = true;
  const wake = (): void => {
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    preferPlaybackSession();
    void ensureRunning(ctx);
  };
  document.addEventListener('touchend', wake, { capture: true, passive: true });
  document.addEventListener('click', wake, { capture: true });
}

/** 走 `BASE_URL` 而不是写死 `/`：原生壳里的 base 由构建决定（和 share/photos.ts 同一条）。 */
function sfxUrl(name: SfxName): string {
  return `${import.meta.env.BASE_URL}sfx/${FILES[name]}`;
}

/**
 * 预取并解码三个文件。**进复习页时调一次**：第一次答题才去 fetch 的话，
 * 提示音会比「答对」那一闪晚半秒到，而晚到的反馈比没有反馈更让人分神。
 *
 * 幂等，且失败不重试 —— 三个几十 KB 的静态文件取不到，多半是这台设备离线
 * 且没缓存，下一次进页面自然会再试。
 */
export function preloadSfx(): Promise<void> {
  preloading ??= (async () => {
    const context = audioContext();
    if (!context) {
      note('没有 AudioContext');
      return;
    }
    installWakeOnTap();
    await Promise.all(
      (Object.keys(FILES) as SfxName[]).map(async (name) => {
        try {
          const res = await fetch(sfxUrl(name));
          if (!res.ok) {
            note(`取 ${name} 失败 HTTP ${res.status}`);
            return;
          }
          buffers.set(name, await context.decodeAudioData(await res.arrayBuffer()));
        } catch (e) {
          // 这一个音效没有了，另外两个照常。
          note(`取/解码 ${name} 失败 ${errorText(e)}`);
        }
      }),
    );
    note(`预取完 ${buffers.size}/3`);
  })();
  return preloading;
}

/**
 * 响一下。**必须从用户手势里调**（iOS），否则 resume 不会成功。
 *
 * 还没预取完就调是正常情况（点得比 fetch 快）：那一下没声音，不排队补 ——
 * 一个迟到 400ms 的「答对」音已经对不上它要确认的那个动作了。
 * 但上下文照样趁这次手势叫醒，后面那声「答对」就有得响。
 */
export function playSfx(name: SfxName): void {
  const context = audioContext();
  if (!context) return;
  preferPlaybackSession();
  const woke = context.state === 'running' ? null : ensureRunning(context);
  const buffer = buffers.get(name);
  if (!buffer) {
    note(`${name}：还没取到，跳过`);
    return;
  }
  const start = (): void => {
    const destination = gain;
    if (!destination || ctx !== context) return;
    try {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      source.start();
      note(`${name}：响 state=${context.state} 会话=${currentSessionType() ?? '无API'}`);
    } catch (e) {
      // 上下文被系统回收了（iOS 长时间后台）之类 —— 下一次点击会重建。
      note(`${name}：start 失败 ${errorText(e)}`);
    }
  };
  // 必须等上下文真的在跑了再 start——WKWebView 上，不在跑的上下文里排的音
  // 之后不会响，是静默丢失，不是晚到（见上面模块头的注释）。
  if (!woke) {
    start();
    return;
  }
  void woke.then((ok) => {
    if (ok) start();
    else note(`${name}：上下文没叫醒（${context.state}），这一声没了`);
  });
}

/**
 * 设置页「试听」用：**从点击处理器里同步调**，趁手势把上下文建好并叫醒，
 * 之后再去预取、再 playSfx —— 不然第一次点试听时文件还没取，手势就白白过去了。
 */
export function wakeSfx(): void {
  const context = audioContext();
  if (!context) return;
  installWakeOnTap();
  preferPlaybackSession();
  if (context.state !== 'running') void ensureRunning(context);
}

/** 最近一笔记录，给「试听」按钮旁边那行字用。 */
export function lastSfxEvent(): string | null {
  return events.at(-1) ?? null;
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
  return {
    hasAudioContext: contextCtor() !== null,
    state: ctx?.state ?? '还没建',
    loaded: [...buffers.keys()],
    session: currentSessionType() ?? '无 navigator.audioSession',
    events: [...events],
  };
}

/** 只给测试用：把模块状态清回没初始化过的样子。 */
export function resetSfxForTests(): void {
  ctx = null;
  gain = null;
  buffers.clear();
  preloading = null;
  resuming = null;
  events.length = 0;
}
