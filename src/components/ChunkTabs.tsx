// 变更 82 / §12.22：长列表按 11 个一组切成几页，上面一排分段按钮「1–11」「12–22」「23–33」。
//
// 起因是他说「列表不要过长，每 11 集折叠进一个 tab」：剧集一季 33 集，平铺着要滚三屏；
// 他按 33 集一个阶段学，11 集正好是一阶段的三分之一。
//
// 只有超过一组时才出那排按钮 —— 11 个以内的列表套一层分页只是多点一下。
// 选中哪一页记在本机（`storageKey`），进一课再返回不该又跳回第一页；不同步，是个人习惯。

import { useState, type ReactNode } from 'react';

export const CHUNK_SIZE = 11;

/** 按 `size` 切块。 */
export function chunk<T>(items: readonly T[], size = CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 「1–11」「12–22」「34」：按位置数，从 1 开始。 */
export function chunkLabel(index: number, length: number, size = CHUNK_SIZE): string {
  const from = index * size + 1;
  const to = index * size + length;
  return from === to ? `${from}` : `${from}–${to}`;
}

const STORE_KEY = 'chunkTabs';

function readSaved(key: string): number | undefined {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, unknown>;
    const v = all[key];
    return typeof v === 'number' ? v : undefined;
  } catch {
    return undefined;
  }
}

function writeSaved(key: string, index: number) {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, unknown>;
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...all, [key]: index }));
  } catch {
    // 私密窗口里写不进去就算了
  }
}

export function ChunkTabs<T>({
  items,
  defaultIndex = 0,
  storageKey,
  children,
}: {
  items: readonly T[];
  /** 没记过选哪页时默认哪页（来源页给「第一个没导的那一集」所在的页） */
  defaultIndex?: number;
  storageKey?: string;
  children: (page: T[]) => ReactNode;
}) {
  const pages = chunk(items);
  const [picked, setPicked] = useState(() => (storageKey ? readSaved(storageKey) : undefined) ?? defaultIndex);
  if (pages.length <= 1) return <>{children([...items])}</>;
  const current = Math.min(Math.max(picked, 0), pages.length - 1);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="分页">
        {pages.map((page, i) => (
          <button
            key={i}
            type="button"
            aria-pressed={i === current}
            onClick={() => {
              setPicked(i);
              if (storageKey) writeSaved(storageKey, i);
            }}
            className={`min-h-11 min-w-16 rounded-ctl border px-3 text-ui tnum ${
              i === current ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'
            }`}
          >
            {chunkLabel(i, page.length)}
          </button>
        ))}
      </div>
      {children(pages[current])}
    </div>
  );
}
