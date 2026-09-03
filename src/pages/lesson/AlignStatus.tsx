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
  const { current, queue, blocked, native, remote, enqueue } = useAlignStore();

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
          <>
            <Button
              // 显眼程度跟着「这一下要付多少代价」走：
              // 桌面本机 26 秒、服务器一两分钟 —— 都可以是 primary；
              // 而「在这台手机上算」是十几分钟且必须一直亮屏，它永远是 ghost。
              variant={timed.length === 0 && (!native || remote) ? 'primary' : 'ghost'}
              onClick={() =>
                enqueue(lesson.id, { manual: true, backend: remote ? 'remote' : 'auto' })
              }
            >
              {remote
                ? timed.length === 0
                  ? '用服务器对齐（约一两分钟）'
                  : '用服务器重对'
                : native
                  ? timed.length === 0
                    ? '在这台手机上对齐（约十几分钟）'
                    : '在这台手机上重对（约十几分钟）'
                  : timed.length === 0
                    ? '自动对齐'
                    : '重新对齐'}
            </Button>
            {/*
              有服务器时手机上仍然留着本地那条 —— 服务器会挂、会没网，而
              「今天就想练这一课」不该被那件事完全挡住。它是 ghost 且写明代价。
            */}
            {remote && native && (
              <Button variant="ghost" onClick={() => enqueue(lesson.id, { manual: true, backend: 'local' })}>
                在这台手机上算（约十几分钟）
              </Button>
            )}
          </>
        )}
      </div>

      {/*
        手机上「还没有时间戳」是个**正常状态**，不是故障 —— 主路径是桌面算完同步过来。
        这条必须说清楚，否则用户看到的是「导入完了什么也没发生」，
        而那和 §7.10 那次「进程被系统杀掉」在界面上又是同一个样子。
      */}
      {native && !remote && hasAudio && timed.length === 0 && !busy && !queued && (
        <Banner tone="info">
          这一课还没有时间戳。手机上导入后<strong>不会</strong>自动对齐 —— 一课要十几分钟满载，
          而且必须一直亮屏、别切出去（iOS 会把后台进程挂起）。
          在桌面上对齐一次，句级和词级时间戳都会跟着同步回来，这台手机上直接就能练。
          <strong>或者登录同步</strong> —— 登录之后手机上导入的课会自动送到服务器算（约一两分钟，
          这期间手机可以锁屏）。真的只有手机又没网的时候，点上面那个按钮：
          它一块一块算，中途被打断下次接着算。
        </Banner>
      )}

      {native && remote && hasAudio && timed.length === 0 && !busy && !queued && (
        <Banner tone="info">
          这一课还没有时间戳。点上面那个按钮送到服务器算 —— 上传音频（6~10MB）之后
          <strong>手机可以锁屏、可以退出 App</strong>，回来再看结果。
          文稿不上传，服务器只拿音频算声音那一半。
        </Banner>
      )}

      {blocked && !remote && hasAudio && (
        <Banner tone="warn">
          这台设备上两档对齐后端都被系统杀过（见「设置 → 对齐后端」里的记录），所以不再自动跑。
          在桌面上对齐这一课、或者登录同步让服务器算 —— 句级与词级时间戳都会跟着同步回来。
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
