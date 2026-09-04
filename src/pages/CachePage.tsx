// FR-3.8 / FR-3.9：缓存管理。
//
// 关键是把「清了还能自动拿回来」和「清了就得自己再找一遍文件」分开显示。
// 前者对 DW 课程是无损操作（R-缓存-3），后者是真的丢东西 —— 两者同一个按钮同一个颜色，
// 早晚有一天会点错。

import { useEffect, useState } from 'react';
import { getStorageEstimate, type StorageEstimateResult } from '@/db';
import { useLessonStore, isRehydratable } from '@/state/useLessonStore';
import { Button, Chip, EmptyState, Hint, Note, Section, formatBytes } from '@/components/ui';

export function CachePage() {
  const { lessons, caches, clearCache } = useLessonStore();
  const [estimate, setEstimate] = useState<StorageEstimateResult | null>(null);

  useEffect(() => {
    void getStorageEstimate().then(setEstimate);
  }, [caches]);

  const cached = lessons.filter((l) => caches[l.id]?.hasAudio);
  const total = cached.reduce((sum, l) => sum + (caches[l.id]?.audioBytes ?? 0), 0);

  const clearAll = () => {
    const lossy = cached.filter((l) => !isRehydratable(l));
    const message =
      lossy.length > 0
        ? `清除全部 ${cached.length} 课的素材？其中 ${lossy.length} 课是手动导入的，音频清掉后要你自己再找回来。`
        : `清除全部 ${cached.length} 课的素材？这些都来自 DW，随时可以重新抓取，标注不受影响。`;
    if (confirm(message)) {
      for (const lesson of cached) void clearCache(lesson.id);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="hidden text-title font-semibold sm:block">素材缓存</h1>

      {/* 这条以前是整宽横幅。它说的是「你在这一页做什么都不会丢东西」——
          那是让人放心的话，不是拦路的话，所以它属于一行那一档（§12.3）。 */}
      <Note tone="ok">
        这一页只动缓存层（音频与原文）。无论清掉多少，时间戳、挖空、生词、FSRS 状态一个字都不会少。
      </Note>

      <Section
        title="用量"
        aside={
          cached.length > 0 ? (
            <Button variant="danger" onClick={clearAll}>清除全部</Button>
          ) : null
        }
      >
        <p className="text-ui text-muted">
          本应用音频合计 {formatBytes(total)}（{cached.length} 课）
          {estimate && !estimate.unsupported && (
            <> · 浏览器统计已用 {formatBytes(estimate.usageBytes)} / 配额 {formatBytes(estimate.quotaBytes)}</>
          )}
        </p>
        {estimate?.unsupported && <Hint>此浏览器不支持用量查询。</Hint>}
      </Section>

      {cached.length === 0 ? (
        <EmptyState>本机没有任何已缓存的音频。</EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-box border border-line bg-raised">
          {cached.map((lesson) => {
            const rehydratable = isRehydratable(lesson);
            return (
              <li key={lesson.id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{lesson.title}</p>
                  <p className="text-note text-muted">
                    {formatBytes(caches[lesson.id]?.audioBytes ?? 0)}
                  </p>
                </div>
                <Chip
                  tone={rehydratable ? 'ok' : 'warn'}
                  title={
                    rehydratable
                      ? '来自 DW，可以按 lesson id 重新抓取，清除是无损的'
                      : '手动导入，清了要自己重新找回音频文件'
                  }
                >
                  {rehydratable ? '可自动补齐' : '清了找不回'}
                </Chip>
                <Button
                  variant={rehydratable ? 'ghost' : 'danger'}
                  onClick={() => {
                    const ok = rehydratable
                      ? confirm(`清除《${lesson.title}》的素材？随时可以按 lesson id 重新抓取，标注不受影响。`)
                      : // 不可补齐的走二次确认（FR-3.9）
                        confirm(`《${lesson.title}》是手动导入的，音频清掉后**无法自动找回**，需要你重新选择本地文件。确定清除？`) &&
                        confirm('再确认一次：这一课的音频没有别的来源，确定要清除吗？');
                    if (ok) void clearCache(lesson.id);
                  }}
                >
                  清除
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
