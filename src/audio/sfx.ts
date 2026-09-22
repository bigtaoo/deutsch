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
// 网页上正常、手机上没声音，根子就在这一行「先后」顺序上。
//
// ── 失败一律静默 ──
// 这个模块里没有一件事值得让复习页报错：没有 AudioContext（jsdom、老 WebView）、
// 取不到文件、解不出来 —— 结果都只是「这一下没声音」。所以每个出口都是 return，
// 不抛，也不往界面上写一个字。

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

type Ctor = new () => AudioContext;

let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
const buffers = new Map<SfxName, AudioBuffer>();
let preloading: Promise<void> | null = null;

function contextCtor(): Ctor | null {
  const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = contextCtor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    gain = ctx.createGain();
    gain.gain.value = GAIN;
    gain.connect(ctx.destination);
  } catch {
    ctx = null;
    gain = null;
  }
  return ctx;
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
    if (!context) return;
    await Promise.all(
      (Object.keys(FILES) as SfxName[]).map(async (name) => {
        try {
          const res = await fetch(sfxUrl(name));
          if (!res.ok) return;
          buffers.set(name, await context.decodeAudioData(await res.arrayBuffer()));
        } catch {
          // 这一个音效没有了，另外两个照常。
        }
      }),
    );
  })();
  return preloading;
}

/**
 * 响一下。**必须从用户手势里调**（iOS），否则 resume 不会成功。
 *
 * 还没预取完就调是正常情况（点得比 fetch 快）：那一下没声音，不排队补 ——
 * 一个迟到 400ms 的「答对」音已经对不上它要确认的那个动作了。
 */
export function playSfx(name: SfxName): void {
  const context = audioContext();
  const buffer = buffers.get(name);
  const destination = gain;
  if (!context || !destination || !buffer) return;
  const start = (): void => {
    try {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      source.start();
    } catch {
      // 上下文被系统回收了（iOS 长时间后台）之类 —— 下一次点击会重新 resume。
    }
  };
  // 必须等 resume 真的 resolve 了再 start——WKWebView 上，suspended 的上下文
  // 里排的音在 resume 之后不会响，是静默丢失，不是晚到（见上面模块头的注释）。
  if (context.state === 'suspended') {
    void context.resume().then(start).catch(() => {});
  } else {
    start();
  }
}

/** 只给测试用：把模块状态清回没初始化过的样子。 */
export function resetSfxForTests(): void {
  ctx = null;
  gain = null;
  buffers.clear();
  preloading = null;
}
