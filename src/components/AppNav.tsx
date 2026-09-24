// 应用导航（SPEC §12.1）。
//
// ── 为什么从六个平级 tab 收成「三个活动 + 一个抽屉」 ──
// 旧导航是 课程/来源/生词本/复习/素材/设置 六项横排，权重完全不同：「来源」和
// 「素材」是管道，不是活动 —— 你不会「今天去做一下素材」。六项在手机上要横向
// 滚动，于是 §2.1 写着「手机是复习工位」，而复习是滚动条里的第 4 个小字。
// 而且它们是 <a>，拿不到 index.css 里那条 44px 规则，热区只有约 30px。
//
// 判据一句话：**这是不是一件我今天要做的事**。不是的收进「⋯」。
//
// ── 手机为什么放底部 ──
// 拇指可达。同一个理由让 FR-10.7 把复习的评分按钮钉在底部；导航没有理由例外。
// 底部标签栏在**课程页与导入页**隐藏 —— 那两页是「推进去」的详情页，而课程页的
// 底部归音频条（§12.2 的底部单浮层契约，两者不并存）。

import { useRef, useState } from 'react';
import { href, type Route } from '@/app/router';
import { useVocabStore } from '@/state/useVocabStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { buildReviewQueue } from '@/srs/queue';
import { useBottomLayer } from './bottomLayer';
import { SyncChip } from './SyncChip';

interface Activity {
  /** 底部标签栏与顶部导航共用的名字。 */
  label: string;
  route: Route;
  icon: (props: { className: string }) => React.ReactElement;
}

/** 三个活动，三个动词：听、练、词。 */
const ACTIVITIES: Activity[] = [
  { label: '课程', route: { name: 'lessons' }, icon: HeadphonesIcon },
  { label: '复习', route: { name: 'review' }, icon: CardsIcon },
  { label: '生词本', route: { name: 'vocab' }, icon: ListIcon },
];

/** 抽屉里的管道页。它们仍是完整页面，只是不占导航位。 */
const DRAWER: Array<{ label: string; route: Route; note: string }> = [
  { label: '来源', route: { name: 'sources' }, note: '从 DW 拉列表、回填旧刊、补齐素材' },
  { label: '素材', route: { name: 'cache' }, note: '本机音频用量与清理' },
  { label: '记录', route: { name: 'record' }, note: '学习时长、连续天数与分享图' },
  { label: '设置', route: { name: 'settings' }, note: '账号与同步、备份、词典、对齐后端' },
];

/** 详情/流程页：底部让给音频条，标签栏收起，顶部给一个返回。 */
function isDetail(route: Route): boolean {
  return route.name === 'lesson' || route.name === 'import';
}

function activeActivity(route: Route): Activity | undefined {
  return ACTIVITIES.find((a) => a.route.name === route.name);
}

/**
 * 今天到期几张。**每天唯一的待办**，所以它在两处导航上都是一个角标，
 * 而不是首页上一条会被读一次就再也不读的横幅。
 *
 * 数字必须跟复习页的「新卡 N · 复习 M」加起来一致 —— 都走 `buildReviewQueue`，
 * 套 `newPerDay`/`reviewPerDay` 的每日上限与同日互斥去重。早先这里是一个不设上限
 * 的原始 `due <= now` 计数，于是角标写着 19、进页面却只有 10 张能刷，两个数字
 * 对不上（用户发现的）。「到期总共多少」不是这个角标要回答的问题。
 */
export function useDueCount(): number {
  const entries = useVocabStore((s) => s.entries);
  const newPerDay = useSettingsStore((s) => s.settings.newPerDay);
  const reviewPerDay = useSettingsStore((s) => s.settings.reviewPerDay);
  const { newCount, reviewCount } = buildReviewQueue(entries, { newPerDay, reviewPerDay });
  return newCount + reviewCount;
}

export function TopBar({ route }: { route: Route }) {
  const drawerRef = useRef<HTMLDetailsElement>(null);
  const dueCount = useDueCount();
  const current = activeActivity(route);
  const drawerPage = DRAWER.find((d) => d.route.name === route.name);

  return (
    <header className="app-nav sticky top-0 z-30 border-b border-line bg-raised/95 backdrop-blur">
      <div className="mx-auto flex max-w-4xl items-center gap-2 px-4 pb-2">
        {/* 桌面：三个活动直接排在顶部。手机：只显示你在哪儿，切换交给底部标签栏。 */}
        <nav className="hidden items-center gap-1 sm:flex">
          {ACTIVITIES.map((item) => (
            <a
              key={item.label}
              href={href(item.route)}
              aria-current={route.name === item.route.name ? 'page' : undefined}
              className={`flex min-h-11 items-center rounded-ctl px-3 text-ui ${
                route.name === item.route.name
                  ? 'bg-accent text-accent-ink'
                  : 'text-muted hover:bg-sunken hover:text-ink'
              }`}
            >
              {item.label}
              {item.route.name === 'review' && dueCount > 0 && (
                <span
                  className={`tnum ml-1.5 rounded-full px-1.5 text-note ${
                    route.name === 'review' ? 'bg-accent-ink/20' : 'bg-accent text-accent-ink'
                  }`}
                >
                  {dueCount > 99 ? '99+' : dueCount}
                </span>
              )}
            </a>
          ))}
        </nav>

        <div className="min-w-0 flex-1 sm:hidden">
          {isDetail(route) ? (
            <a
              href={href({ name: 'lessons' })}
              className="-ml-2 flex min-h-11 items-center gap-1 rounded-ctl px-2 text-ui text-muted"
            >
              <span aria-hidden>‹</span> 课程
            </a>
          ) : (
            <span className="text-title font-semibold">{current?.label ?? drawerPage?.label ?? '努力学德语'}</span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <SyncChip />

          <details ref={drawerRef} className="relative">
            <summary
              aria-label="更多"
              className="flex size-11 cursor-pointer list-none items-center justify-center rounded-ctl text-muted hover:bg-sunken hover:text-ink"
            >
              <span aria-hidden className="text-title leading-none">
                ⋯
              </span>
            </summary>
            {/* 点别处收起。<details> 自己不做这件事，一个透明层最省事。 */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => drawerRef.current?.removeAttribute('open')}
            />
            <div className="absolute right-0 z-50 mt-1 w-64 overflow-hidden rounded-box border border-line bg-raised shadow-lg">
              {DRAWER.map((item) => (
                <a
                  key={item.label}
                  href={href(item.route)}
                  onClick={() => drawerRef.current?.removeAttribute('open')}
                  className={`block px-4 py-3 text-ui hover:bg-sunken ${
                    route.name === item.route.name ? 'text-accent' : 'text-ink'
                  }`}
                >
                  {item.label}
                  <span className="block text-note text-faint">{item.note}</span>
                </a>
              ))}
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}

export function BottomTabs({ route }: { route: Route }) {
  // 回调 ref 而不是 useRef：useRef 在首帧是 null，而读 `.current` 不会触发重渲染，
  // 高度就永远是 0。useState 让「元素挂上了」成为一次真实的状态变化。
  const [el, setEl] = useState<HTMLElement | null>(null);
  useBottomLayer('tabbar', el);

  const dueCount = useDueCount();

  return (
    <nav
      ref={setEl}
      className="app-bottom-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-raised/95 backdrop-blur sm:hidden"
    >
      <div className="mx-auto flex max-w-4xl">
        {ACTIVITIES.map((item) => {
          const active = route.name === item.route.name;
          const Icon = item.icon;
          return (
            <a
              key={item.label}
              href={href(item.route)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 ${
                active ? 'text-accent' : 'text-muted'
              }`}
            >
              <Icon className="size-6" />
              <span className="text-note leading-none">{item.label}</span>
              {/* 到期张数只贴在「复习」上。它是这个应用每天唯一的待办。 */}
              {item.route.name === 'review' && dueCount > 0 && (
                <span className="absolute top-1.5 right-[calc(50%-1.5rem)] min-w-4 rounded-full bg-accent px-1 text-center text-[0.625rem] leading-4 text-accent-ink">
                  {dueCount > 99 ? '99+' : dueCount}
                </span>
              )}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

/** 详情页上不画标签栏（见文件头）。 */
export function shouldShowBottomTabs(route: Route): boolean {
  return !isDetail(route);
}

/* ── 图标 ──
   纯手写路径，不引图标库：一共三个，而 stroke 宽度和圆角要跟这套令牌对齐。
   全部 24×24、`currentColor`、只用 stroke —— 于是深色模式下不需要第二份。 */

function HeadphonesIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className} aria-hidden>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" strokeLinecap="round" />
      <rect x="2.5" y="13.5" width="4" height="7" rx="2" />
      <rect x="17.5" y="13.5" width="4" height="7" rx="2" />
    </svg>
  );
}

function CardsIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className} aria-hidden>
      <rect x="6.5" y="7.5" width="15" height="12" rx="2.5" />
      <path d="M17 4.5H5A2.5 2.5 0 0 0 2.5 7v9" strokeLinecap="round" />
    </svg>
  );
}

function ListIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className} aria-hidden>
      <path d="M5 6.5h14M5 12h14M5 17.5h9" strokeLinecap="round" />
    </svg>
  );
}
