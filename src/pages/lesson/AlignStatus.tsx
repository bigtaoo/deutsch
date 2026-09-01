// 一课的对齐状态。FR-15 之后**这是时间戳的唯一来源** —— 手工「标注」那一页已经去掉了。
//
// 措辞上刻意不说「已标注 37/37 完成」——自动对齐产出的是**待校对**，不是完成。
// DW 素材里固定有几类会漂的地方（台标音乐、播音员交替、背景音效、被丢掉的数字），
// 所以低置信度的句数一定要摆在明面上，而不是藏起来假装全对。
//
// 进度条不在这里：它常驻在应用底部（AlignBar），因为对齐要跑几分钟，
// 而人在这几分钟里一定会切页面。这一块只负责「这一课现在是什么状态 + 重跑」。

import { reviewQueue } from '@/align/apply';
import { useAlignStore } from '@/state/useAlignStore';
import { Banner, Button } from '@/components/ui';
import type { Lesson } from '@/types/models';

export function AlignStatus({ lesson }: { lesson: Lesson }) {
  const { current, queue, blocked, enqueue } = useAlignStore();

  const hasAudio = lesson.audioDuration !== undefined;
  const usable = lesson.sentences.filter((s) => !s.excluded);
  const timed = usable.filter((s) => s.startTime !== undefined);
  const pending = reviewQueue(lesson.sentences);
  const busy = current?.lessonId === lesson.id;
  const queued = queue.some((t) => t.lessonId === lesson.id);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <span>
          已对齐 {timed.length} / {usable.length} 句
          {pending.length > 0 && ` · ${pending.length} 句置信度偏低`}
        </span>
        {busy && <span className="text-sky-700">正在对齐 —— 进度在页面底部</span>}
        {queued && <span className="text-sky-700">排队中</span>}
        {!hasAudio && <span className="text-neutral-400">这一课还没有音频</span>}
        {hasAudio && !busy && !queued && (
          <Button
            variant={timed.length === 0 ? 'primary' : 'ghost'}
            onClick={() => enqueue(lesson.id, { manual: true })}
          >
            {timed.length === 0 ? '自动对齐' : '重新对齐'}
          </Button>
        )}
      </div>

      {blocked && hasAudio && (
        <Banner tone="warn">
          这台设备上两档对齐后端都被系统杀过（见「设置 → 对齐后端」里的记录），所以不再自动跑。
          在桌面上对齐这一课，句级时间戳会跟着备份同步回来 —— 手机端照样能跟读和听写。
        </Banner>
      )}

      {timed.length > 0 && pending.length > 0 && (
        <Banner tone="warn">
          {pending.length} 句的置信度明显低于本课水平（多半是台标音乐、播音员交替、英语借词或数字）。
          在「通听」里点这几句听一下，起点不对就重新对齐一次。
        </Banner>
      )}
    </div>
  );
}
