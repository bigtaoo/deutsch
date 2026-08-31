// FR-15 的入口：一键自动打点，以及跑完之后的校对提示。
//
// 措辞上刻意不说「已标注 37/37」——自动对齐产出的是**待校对**，不是完成。
// 说成完成会让人跳过校对，而 DW 素材里固定有几类会漂的地方（台标音乐、播音员交替、
// 背景音效、被丢掉的数字），漂了不看就直接带进跟读和听写。

import { useState } from 'react';
import { alignLesson } from '@/align/client';
import type { AlignProgress } from '@/align/align';
import { reviewQueue } from '@/align/apply';
import { Banner, Button, formatBytes } from '@/components/ui';
import type { Lesson } from '@/types/models';

const STAGE_LABEL: Record<AlignProgress['stage'], string> = {
  model: '加载对齐模型',
  infer: '识别音频',
  align: '对齐文本',
};

function describe(p: AlignProgress): string {
  const label = STAGE_LABEL[p.stage];
  if (p.stage === 'model') {
    // 首次使用要下 200MB 权重；之后 transformers.js 从 Cache API 直接拿，这行会一闪而过。
    if (p.total) return `${label}：${formatBytes(p.loaded ?? 0)} / ${formatBytes(p.total)}`;
    return `${label}…`;
  }
  return `${label} ${Math.round((p.fraction ?? 0) * 100)}%`;
}

export function AutoAlignPanel({ lesson }: { lesson: Lesson }) {
  const [progress, setProgress] = useState<AlignProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ applied: number; skippedManual: number } | null>(null);

  const hasAudio = lesson.audioDuration !== undefined;
  const pending = reviewQueue(lesson.sentences);
  const autoCount = lesson.sentences.filter((s) => s.timingSource === 'auto').length;

  const run = async () => {
    setError(null);
    setResult(null);
    setProgress({ stage: 'model' });
    try {
      const outcome = await alignLesson(lesson, setProgress);
      setResult({ applied: outcome.applied, skippedManual: outcome.skippedManual });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!hasAudio || progress !== null} onClick={() => void run()}>
          {autoCount > 0 ? '重新自动打点' : '自动打点'}
        </Button>
        {progress && <span className="text-xs text-neutral-500">{describe(progress)}</span>}
        {!hasAudio && <span className="text-xs text-neutral-400">这一课还没有音频</span>}
        {!progress && autoCount > 0 && (
          <span className="text-xs text-neutral-500">
            {autoCount} 句由自动对齐给出
            {pending.length > 0 && ` · ${pending.length} 句建议校对`}
          </span>
        )}
      </div>

      {progress && (
        <Banner tone="info">
          对齐在后台线程跑，可以切到别的标签页，但不要关掉应用。
          {progress.stage === 'model' && progress.total
            ? '第一次要下载一次模型权重，之后就走本机缓存了。'
            : null}
        </Banner>
      )}

      {error && <Banner tone="error">自动打点失败：{error}</Banner>}

      {result && (
        <Banner tone={pending.length > 0 ? 'warn' : 'ok'}>
          写入 {result.applied} 句
          {result.skippedManual > 0 && `，跳过 ${result.skippedManual} 句已人工标注的`}。
          {pending.length > 0
            ? `其中 ${pending.length} 句置信度偏低，下面用黄色标出来了，听一遍确认起点。`
            : '所有句子的置信度都不错，但仍然建议抽查几句 —— 尤其是开头和结尾。'}
        </Banner>
      )}
    </div>
  );
}
