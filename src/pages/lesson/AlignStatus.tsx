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
  const { current, queue, blocked, native, enqueue } = useAlignStore();

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
            // 手机上这个按钮不再是 primary：主路径是「桌面算完同步过来」，
            // 在这台手机上跑是那条要付十几分钟的备用路。按钮的显眼程度要跟这件事一致。
            variant={timed.length === 0 && !native ? 'primary' : 'ghost'}
            onClick={() => enqueue(lesson.id, { manual: true })}
          >
            {native
              ? timed.length === 0
                ? '在这台手机上对齐（约十几分钟）'
                : '在这台手机上重对（约十几分钟）'
              : timed.length === 0
                ? '自动对齐'
                : '重新对齐'}
          </Button>
        )}
      </div>

      {/*
        手机上「还没有时间戳」是个**正常状态**，不是故障 —— 主路径是桌面算完同步过来。
        这条必须说清楚，否则用户看到的是「导入完了什么也没发生」，
        而那和 §7.10 那次「进程被系统杀掉」在界面上又是同一个样子。
      */}
      {native && hasAudio && timed.length === 0 && !busy && !queued && (
        <Banner tone="info">
          这一课还没有时间戳。手机上导入后<strong>不会</strong>自动对齐 —— 一课要十几分钟满载，
          而且必须一直亮屏、别切出去（iOS 会把后台进程挂起）。
          在桌面上对齐一次，句级和词级时间戳都会跟着同步回来，这台手机上直接就能练。
          真的只有手机的时候，点上面那个按钮 —— 它一块一块算，中途被打断下次接着算。
        </Banner>
      )}

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
