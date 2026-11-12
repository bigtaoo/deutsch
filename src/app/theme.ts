// 深浅主题（变更 90 / SPEC §12.25）。
//
// ── 为什么不再「只跟系统走」──
// §12.5 当初定的是「深浅跟系统走，应用里不另设开关」，理由是少一个状态就少一处要维护。
// 2026-11-12 的反馈把这条推翻了：系统已经是深色，晚上关了灯还是刺眼。
// 也就是说深色这一档对「亮房间」合适、对「关灯躺着」不合适，而这两种情况在同一台设备上
// 都会发生 —— 系统外观回答不了这个问题，只能让人自己说。
//
// ── 为什么存在 localStorage 而不是 Settings ──
// Settings 是**跟着人走**的（会同步到所有设备）。深浅不是：桌面在亮着灯的房间、
// 手机在床上关着灯，是同一个人的两个不同答案。同步过去只会让人每天在两台设备上各改一次。
// 另一个硬理由是时机：index.html 里那段内联脚本必须在**首次绘制前**同步读到这个值，
// 而 Settings 在 IndexedDB 里，读它是异步的 —— 等它读完，夜间用户已经被闪了一屏浅色。
//
// ── 和 CSS 的分工 ──
// 这里只负责把选择解析成 `data-theme="light|dark|night"` 写到 <html> 上；
// 三套色值全在 src/index.css 里。组件仍然对主题完全无感（§12.5 那条没变）。

/** 人选的那一档。`system` 是默认值，含义是「跟系统外观走」。 */
export type ThemeChoice = 'system' | 'light' | 'dark' | 'night';

/** 真正写进 `data-theme` 的值 —— `system` 在这一层已经被解析掉了。 */
export type ResolvedTheme = 'light' | 'dark' | 'night';

export const THEME_KEY = 'theme';

export const THEME_CHOICES: ThemeChoice[] = ['system', 'light', 'dark', 'night'];

export const THEME_LABELS: Record<ThemeChoice, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
  night: '夜间',
};

/**
 * 状态栏颜色（index.html 里那条 `<meta name="theme-color">`）。
 * 浅色用图标底色，深色与夜间用各自的 `--color-surface` ——
 * 值必须和 src/index.css 对得上，theme.test.ts 守着这件事。
 */
export const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: '#e0f2fe',
  dark: '#171716',
  night: '#0b0b0a',
};

/** 把选择解析成真正要应用的那一档。和 index.html 里那段内联脚本是同一套口径。 */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): ResolvedTheme {
  if (choice === 'system') return systemDark ? 'dark' : 'light';
  return choice;
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * 读本机选的那一档。读不出来、或者存着一个不认识的值（老版本写的、手动改坏的）
 * 一律当 `system` —— 主题是一个永远要有答案的问题，不能因为存储坏了就没有界面。
 */
export function readThemeChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return (THEME_CHOICES as string[]).includes(raw ?? '') ? (raw as ThemeChoice) : 'system';
  } catch {
    return 'system';
  }
}

/**
 * 应用一档主题：写 `data-theme`、改状态栏颜色。
 * 不写 localStorage —— 那是 `setThemeChoice` 的事，这里也被「系统外观变了」那条路复用。
 */
export function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(choice, systemPrefersDark());
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  const meta = document.getElementById('theme-color');
  if (meta instanceof HTMLMetaElement) meta.content = THEME_COLOR[resolved];
  return resolved;
}

/** 人选了一档：落盘 + 立刻生效。存不下（隐私模式）也照样生效本次会话。 */
export function setThemeChoice(choice: ThemeChoice): ResolvedTheme {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    // 存不下就只影响下次冷启动，不该连这一次的切换都不认
  }
  return applyTheme(choice);
}

/**
 * 跟住系统外观的变化。只在选择是 `system` 时才重新应用 —— 手动选了夜间的人
 * 不希望太阳一出来（iOS 的「自动」外观）就被切回浅色。
 *
 * 返回取消订阅函数。没有 `matchMedia` 的环境里是空操作。
 */
export function watchSystemTheme(getChoice: () => ThemeChoice): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (getChoice() === 'system') applyTheme('system');
  };
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}
