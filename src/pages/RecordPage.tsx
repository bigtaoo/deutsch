// FR-18：记录页 —— 今天学了多久、连续几天、一共几天，以及把这三个数做成一张图发出去。
//
// 为什么在「⋯」抽屉里而不是导航上（§12.1 的判据：这是不是一件我今天要做的事）：
// 看记录不是一件要做的事，它是做完之后回头看的东西。把它放进导航会挤掉三个活动
// 之一，而那三个才是每天真的要点开的。
//
// 页面只有两块：上面是数字，下面是那张图的**真实预览**（同一个 canvas，同一份
// 渲染代码，所见即所得）。中间不设「样式」「模板」这类东西 —— 换一句、换张图
// 两个按钮就是全部的可调项。

import { useEffect, useRef, useState } from 'react';
import { Button, Card, Disclosure, Hint, Note, Section, field } from '@/components/ui';
import { useStudyStore } from '@/state/useStudyStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useSyncStore } from '@/state/useSyncStore';
import { localDateKey } from '@/study/log';
import {
  MIN_STUDY_SECONDS,
  formatCardDate,
  formatDuration,
  formatDurationCompact,
  recentDays,
} from '@/study/stats';
import { renderShareCard, renderShareCardBlob, type ShareCardData } from '@/share/card';
import { photoForDate, SHARE_PHOTOS } from '@/share/photos';
import { quoteForDate } from '@/share/quotes';
import { shareCardFileName, shareCardImage } from '@/share/save';

export function RecordPage() {
  const { log, stats, load } = useStudyStore();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);
  const account = useSyncStore((s) => s.account);

  const [quoteOffset, setQuoteOffset] = useState(0);
  const [photoOffset, setPhotoOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 进页面时重读一次：计时器是每 30 秒才落一次库的，而从课程页走过来的那一刻
  // 刚好有一笔还在内存里 —— 不重读的话「今天」会比实际少半分钟。
  useEffect(() => {
    void load();
  }, [load]);

  const today = localDateKey();
  const quote = quoteForDate(today, quoteOffset);
  const photo = photoForDate(today, photoOffset);
  // 没设过名字就用登录账号的名字。设成空字符串是「别印我的名字」，那时就不印。
  const name = settings.displayName ?? account?.name ?? '';

  const cardData: ShareCardData = {
    quote,
    photoId: photo.id,
    name,
    dateText: formatCardDate(),
    todayText: formatDurationCompact(stats.todaySeconds),
    streakDays: stats.streakDays,
    totalDays: stats.totalDays,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    void renderShareCard(canvas, cardData).catch((err: unknown) => {
      if (!cancelled) setMessage(err instanceof Error ? err.message : '预览生成失败');
    });
    return () => {
      cancelled = true;
    };
    // cardData 每次渲染都是新对象，所以依赖列成它真正的组成部分。
  }, [
    quote.de,
    photo.id,
    name,
    stats.todaySeconds,
    stats.streakDays,
    stats.totalDays,
  ]);

  const share = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const blob = await renderShareCardBlob(cardData);
      const target = await shareCardImage(blob, shareCardFileName(today));
      setMessage(target === 'browser-download' ? '图片已下载' : '已交给系统分享面板');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '生成失败');
    } finally {
      setBusy(false);
    }
  };

  const days = recentDays(log, 14);
  const peak = Math.max(600, ...days.map((d) => d.seconds));

  return (
    <div className="space-y-4">
      <h1 className="hidden text-title font-semibold sm:block">学习记录</h1>

      <Section title="今天">
        <div className="flex gap-6">
          <Stat label="今天" value={formatDuration(stats.todaySeconds)} />
          <Stat label="连续" value={`${stats.streakDays} 天`} />
          <Stat label="累计" value={`${stats.totalDays} 天`} />
        </div>

        {/* 最近两周。不做图表库（§12.7），十四个 div 就够，而且它跟着颜色令牌走。
            柱子给固定宽度而不是 flex-1：十四根等分一整行时每根有四十多像素宽，
            配上 6px 圆角看着是一排圆疙瘩，不像一张图。 */}
        <div className="flex items-end gap-1.5" aria-hidden>
          {days.map((d) => (
            <div key={d.date} className="w-3" title={`${d.date}：${formatDuration(d.seconds)}`}>
              <div
                className={`rounded-ctl ${d.seconds >= MIN_STUDY_SECONDS ? 'bg-accent' : 'bg-sunken'}`}
                style={{ height: `${Math.max(3, Math.round((d.seconds / peak) * 56))}px` }}
              />
            </div>
          ))}
        </div>
        <Hint>最近 14 天，最右边是今天。</Hint>

        {stats.totalDays === 0 && stats.todaySeconds < MIN_STUDY_SECONDS && (
          <Note>今天先练一分钟，这一页就有东西了。以前的学习没有留下逐日记录，所以是从头攒的。</Note>
        )}

        <Disclosure summary="什么算「学了多久」">
          <Hint>
            只有在通听、跟读、学词、听写、复习这五个界面上才走表，而且要求页面在前台、
            最近一分钟内点过键盘或屏幕，或者音频正在播。切出去、锁屏、暂停着放在一边，
            表都会停 —— 这个数字是要发给别人看的，宁可少算。
          </Hint>
          <Hint>一天累计满 {MIN_STUDY_SECONDS} 秒才算「学过的一天」，连续天数和累计天数都按这个算。</Hint>
        </Disclosure>
      </Section>

      <Section title="分享图">
        <div className="flex flex-col gap-4 sm:flex-row">
          <Card className="overflow-hidden sm:w-72 sm:shrink-0">
            <canvas ref={canvasRef} className="block w-full" aria-label="分享图预览" />
          </Card>

          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <label className="block space-y-1">
              <span className="text-note text-muted">图上的名字</span>
              <input
                className={`${field} w-full px-3 py-2`}
                value={name}
                placeholder="留空就不印名字"
                onChange={(e) => void updateSettings({ displayName: e.target.value })}
              />
            </label>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setQuoteOffset((n) => n + 1)}>换一句</Button>
              <Button onClick={() => setPhotoOffset((n) => n + 1)}>换张图</Button>
              <Button variant="primary" onClick={() => void share()} disabled={busy}>
                {busy ? '生成中…' : '保存 / 分享'}
              </Button>
            </div>

            <Hint>
              底图：{photo.label}（共 {SHARE_PHOTOS.length} 张，均为 CC0）。
              句子是公有领域的德语谚语与引文，换一句会按固定顺序往下走。
            </Hint>
            {message && <Note tone="ok">{message}</Note>}
          </div>
        </div>
      </Section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-note text-muted">{label}</div>
      <div className="tnum text-title font-semibold">{value}</div>
    </div>
  );
}
