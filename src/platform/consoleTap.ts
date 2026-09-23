// 把 console 抄一份留在内存里（变更 56）。
//
// ── 为什么值得做这件事 ──
// Capgo 热更插件的**原生**日志是通过 `webView.evaluateJavaScript("console.info(...)")`
// 打进 JS console 的（node_modules/@capgo/capacitor-updater/ios/Sources/
// CapacitorUpdaterPlugin/Logger.swift:206）。也就是说：只要在 JS 这一侧把 console 抄下来，
// 就等于**把 Xcode 控制台搬进了应用本身** —— 而这个项目的开发机是 Windows，
// 从来没有过 Xcode 控制台可看。插件 `load()` 里那几十行 `logger.info`
// （「init for device …」「version native …」「appId …」）正是回答
// 「插件到底初始化到哪一步」的唯一证据，而它们原来全部落在一个没人看得见的地方。
//
// ── 为什么是环形缓冲、为什么不落盘 ──
// 只留最近这些行：这块内存要在整个会话里一直挂着，不能无限长。不落 localStorage
// 是因为写入频率太高（插件启动时一口气几十条），而它的用处只在「这一次启动发生了什么」，
// 跨会话的那一份由 `nativeUpdate.ts` 的 CheckLogEntry 负责。
//
// ── 这一层自己绝不能成为故障源 ──
// 它包住的是每一次 console 调用。所以：原函数**永远**先调用（放在 try 外面不行，
// 得先调再记，否则记录出错就吞掉了真正的日志），记录这一步整个包在 try 里，
// 出任何问题都当没发生过。`installConsoleTap()` 幂等 —— StrictMode 下模块级副作用
// 也可能跑两遍，装两层钩子会让每条日志记两份。

/** 抄下来的一行。 */
export interface ConsoleLine {
  /** `Date.now()`。 */
  at: number;
  level: ConsoleLevel;
  /** 已经拼好、截断过的文本。 */
  text: string;
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

const LEVELS: ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

/** 留多少行。插件启动时一口气几十条，几百行足够覆盖一次冷启动加一次手动查更新。 */
const MAX_LINES = 500;

/** 单行最多留多少字符 —— 防一条 base64 或一份大 JSON 把整个缓冲挤掉。 */
const MAX_TEXT = 600;

let buffer: ConsoleLine[] = [];
let installed = false;

/** 把一个 console 参数变成短字符串。**不能抛** —— 它跑在每一次 console 调用里。 */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // 循环引用、getter 抛异常、BigInt……都到这里。
    try {
      return String(value);
    } catch {
      return '（无法转成字符串的参数）';
    }
  }
}

function record(level: ConsoleLevel, args: unknown[]): void {
  const text = args.map(stringify).join(' ');
  buffer.push({ at: Date.now(), level, text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text });
  if (buffer.length > MAX_LINES) buffer = buffer.slice(-MAX_LINES);
}

/**
 * 装上钩子。幂等，在浏览器和原生壳里都装（web 版同样会用到「复制诊断」那条路）。
 * 尽量早调用 —— 插件 `load()` 的日志只在它真正初始化的那一刻出现一次，错过就没有了。
 */
export function installConsoleTap(): void {
  if (installed) return;
  installed = true;
  for (const level of LEVELS) {
    const original = console[level] as ((...args: unknown[]) => void) | undefined;
    if (typeof original !== 'function') continue;
    console[level] = (...args: unknown[]) => {
      // **先把原来的事做完**：记录这一步出任何问题都不该让一条日志消失。
      original.apply(console, args);
      try {
        record(level, args);
      } catch {
        // 见上。
      }
    };
  }
}

/** 抄下来的行，按时间先后。返回副本 —— 调用方拿去序列化时缓冲还在继续写。 */
export function consoleLines(): ConsoleLine[] {
  return buffer.slice();
}

/**
 * 只留跟原生桥有关的那些行。Capgo 的 logger 把每条都拼成
 * `<emoji> <tag> : <message>`，tag 里带 `capacitor-updater`（大小写不定）；
 * Capacitor 自己的桥日志也带 `Capacitor`。宁可多留几行无关的，也不要把关键那条滤掉。
 */
export function nativeConsoleLines(): ConsoleLine[] {
  return buffer.filter((l) => /capacitor|capgo|updater|bundle/i.test(l.text));
}

/** 测试用：清空缓冲并摘掉钩子标记。生产代码不调。 */
export function resetConsoleTapForTests(): void {
  buffer = [];
  installed = false;
}
