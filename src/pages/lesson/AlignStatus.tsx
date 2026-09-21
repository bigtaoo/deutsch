// 一课的对齐状态。FR-15 之后**这是时间戳的唯一来源** —— 手工「标注」那一页已经去掉了。
//
// 措辞上刻意不说「已标注 37/37 完成」——自动对齐产出的是**待校对**，不是完成。
// DW 素材里固定有几类会漂的地方（台标音乐、播音员交替、背景音效、被丢掉的数字），
// 所以低置信度的句数一定要摆在明面上，而不是藏起来假装全对。
//
// 进度条不在这里：它常驻在应用底部（AlignBar），因为对齐要跑几分钟，
// 而人在这几分钟里一定会切页面。这一块只负责「这一课现在是什么状态 + 重跑」。
//
// ── 这一块的散文搬走了（SPEC §12.3）──
// 它以前会连着挂三到四条整宽横幅，每条三到五行，内容是 jetsam、UIBackgroundModes、
// 亮屏时长这些取舍论证 —— 而它们出现在课程页头部，也就是每次点开一课都读一遍。
// 现在：状态是一行（Note），「为什么手机上不自动跑」收进折叠块，
// 只有**真的过不去**那一种（两档后端都被系统杀过）才留在拦路那一档。

import { reviewQueue } from '@/align/apply';
import { useAlignStore } from '@/state/useAlignStore';
import { Banner, Button, Disclosure, Note } from '@/components/ui';
import type { Lesson } from '@/types/models';

export function AlignStatus({ lesson }: { lesson: Lesson }) {
  const { current, queue, blocked, phone, remote, enqueue } = useAlignStore();

  const hasAudio = lesson.audioDuration !== undefined;
  const usable = lesson.sentences.filter((s) => !s.excluded);
  const timed = usable.filter((s) => s.startTime !== undefined);
  const pending = reviewQueue(lesson.sentences);
  const busy = current?.lessonId === lesson.id;
  const queued = queue.some((t) => t.lessonId === lesson.id);
  const idle = hasAudio && !busy && !queued;
  const untimed = timed.length === 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="tnum text-note text-muted">
          已对齐 {timed.length} / {usable.length} 句
          {pending.length > 0 && ` · ${pending.length} 句置信度偏低`}
        </span>
        {busy && <span className="text-note text-accent">正在对齐 —— 进度在页面底部</span>}
        {queued && <span className="text-note text-accent">排队中</span>}
        {!hasAudio && <span className="text-note text-faint">这一课还没有音频</span>}
        {idle && !phone && (
          <>
            <Button
              variant={untimed ? 'primary' : 'ghost'}
              onClick={() => enqueue(lesson.id, { manual: true, backend: 'local' })}
            >
              {untimed ? '自动对齐' : '重新对齐'}
            </Button>
            {/*
              桌面上服务器那条是 ghost：本机几十秒、服务器几分钟，日常没有理由绕出去。
              它留着是为了「验一下服务器算得对不对」，以及本机跑不动时的退路。
            */}
            {remote && (
              <Button variant="ghost" onClick={() => enqueue(lesson.id, { manual: true, backend: 'remote' })}>
                送到服务器算
              </Button>
            )}
          </>
        )}
        {idle && phone && remote && (
          <Button
            variant={untimed ? 'primary' : 'ghost'}
            onClick={() => enqueue(lesson.id, { manual: true, backend: 'remote' })}
          >
            {untimed ? '用服务器对齐（约几分钟）' : '用服务器重对'}
          </Button>
        )}
      </div>

      {/*
        手机上「还没有时间戳」是个**正常状态**，不是故障 —— 主路径是桌面算完同步过来。
        这一句必须说出来，否则用户看到的是「导入完了什么也没发生」，
        而那和 §7.10 那次「进程被系统杀掉」在界面上又是同一个样子。
        但它是「顺便说一声」而不是「你过不去」，所以是一行，理由在折叠块里。
      */}
      {phone && !remote && idle && untimed && (
        <Note tone="warn">
          这一课还没有时间戳。<strong>手机上不自己算对齐</strong> —— 登录同步之后由服务器算，
          或者在桌面上对一次，句级与词级时间戳都会跟着同步回来。
          <Disclosure summary="为什么手机上不自己算">
            <p>
              手机上曾经有一条原生 ONNX 的路（变更 31/33），它要随包带 418MB 权重、
              一课十几分钟满载，而且必须一直亮屏别切出去 —— iOS 会把后台进程挂起，
              带着几百 MB 常驻被挂起的进程又正是系统最先挑的那一个。
              也就是说它十有八九跑不完。<strong>变更 42 把它整条删掉了</strong>：
              装机体积因此少了 400 多 MB，而手机上时间戳的来源变成两个 ——
              服务器算（约几分钟，这期间手机可以锁屏），或者桌面算完同步过来。
            </p>
          </Disclosure>
        </Note>
      )}

      {phone && remote && idle && untimed && (
        <Note tone="accent">
          这一课还没有时间戳。点上面那个按钮送到服务器算 —— 上传音频（6~10MB）之后
          手机可以锁屏、可以退出 App，回来再看结果。文稿不上传。
        </Note>
      )}

      {/* 这一条是真的过不去：这台设备跑不动这个模型，本机没有任何路径能拿到时间戳。 */}
      {blocked && !remote && hasAudio && (
        <Banner tone="warn" title="这台设备跑不动对齐模型">
          <p>
            两档后端都被系统杀过（记录在「设置 → 对齐后端」里），所以不再自动跑。
            在桌面上对齐这一课、或者登录同步让服务器算 —— 句级与词级时间戳都会跟着同步回来。
          </p>
        </Banner>
      )}

      {/*
        FR-15.19：这条提示现在**能被消掉** —— 报的是「还没核对的低置信句」，
        在通听里逐句确认完就回到静默（§12.3）。以前它是永久的：低置信句大多其实是对的，
        而一条听完也不会消失的提示，教会人的只有忽略它。
      */}
      {timed.length > 0 && pending.length > 0 && (
        <Note tone="warn">
          {pending.length} 句的置信度明显低于本课水平（多半是采访同期声、台标音乐、播音员交替或数字）。
          在「通听」里展开文本，点带 ? 的行号听一下：起点对就点一下行号消掉它，不对就重新对齐一次。
        </Note>
      )}
    </div>
  );
}
