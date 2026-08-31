// FR-2.3 手工修正 + FR-1.4 段落排除 + FR-1.5 重新编辑原文。
//
// 这个界面是切句质量的兜底。§7.1 已经说清楚：规则再好也不可能覆盖全部，
// `Intl.Segmenter` 对 `z. B.` 一定会断错。所以合并/拆分不是「高级功能」，是主路径的一部分。

import { useMemo, useRef, useState } from 'react';
import { useLessonStore } from '@/state/useLessonStore';
import { segmentSentences } from '@/lesson/segment';
import { resegment } from '@/lesson/resegment';
import { displayNumbers, excludeLastN, mergeWithNext, setExcluded, splitSentence } from '@/lesson/sentences';
import { Banner, Button, Hint } from '@/components/ui';
import type { Lesson, LessonCache, Sentence } from '@/types/models';

interface Props {
  lesson: Lesson;
  cache: LessonCache | undefined;
}

export function SentencesTab({ lesson, cache }: Props) {
  const { updateSentences, resegmentLesson } = useLessonStore();
  const plainText = cache?.plainText ?? '';
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const numbers = useMemo(() => displayNumbers(lesson.sentences), [lesson.sentences]);
  const includedCount = numbers.size;

  const apply = async (
    next: { sentences: Sentence[]; indexMap?: Map<number, number> },
    message?: string,
  ) => {
    await updateSentences(lesson.id, next.sentences, next.indexMap);
    if (message) setNotice(message);
  };

  const doMerge = (index: number) => {
    setNotice(null);
    void apply(mergeWithNext(lesson.sentences, index, plainText));
    setActiveIndex(index);
  };

  const doSplit = (index: number) => {
    const caret = textareaRef.current?.selectionStart;
    if (caret === undefined) return;
    const result = splitSentence(lesson.sentences, index, caret, plainText);
    if (result.sentences === lesson.sentences) {
      setNotice('光标在句首或句尾，拆不出两句。');
      return;
    }
    void apply(
      result,
      result.droppedBlanks.length > 0
        ? `已拆分。${result.droppedBlanks.length} 个横跨切点的挖空无处安放，已丢弃：${result.droppedBlanks.map((b) => b.surface).join('、')}`
        : undefined,
    );
    setActiveIndex(index);
  };

  if (!plainText) {
    return (
      <Banner tone="warn">
        本机没有这一课的原文（缓存层已清除或从备份恢复而来）。补齐素材后才能重新切句；
        已有的句子与标注不受影响。
      </Banner>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-neutral-600">
          共 {lesson.sentences.length} 句，其中 {lesson.sentences.length - includedCount} 句已排除
        </span>
        <ExcludeTailControl
          onExclude={(n) => void apply({ sentences: excludeLastN(lesson.sentences, n) })}
        />
      </div>

      {notice && <Banner tone="info">{notice}</Banner>}

      <ol className="divide-y divide-neutral-200 rounded-lg border border-neutral-200">
        {lesson.sentences.map((sentence, i) => {
          const active = activeIndex === sentence.index;
          return (
            <li
              key={sentence.index}
              className={`flex gap-3 p-3 ${sentence.excluded ? 'bg-neutral-50 text-neutral-400' : ''}`}
            >
              <span className="w-10 shrink-0 pt-1 text-right text-xs text-neutral-400">
                {numbers.get(sentence.index) ?? '—'}
              </span>
              <div className="min-w-0 flex-1 space-y-2">
                {active ? (
                  <textarea
                    ref={textareaRef}
                    readOnly
                    autoFocus
                    className="w-full resize-y rounded border border-sky-400 bg-white p-2 text-sm leading-relaxed"
                    rows={Math.max(2, Math.ceil(sentence.text.length / 80))}
                    value={sentence.text}
                  />
                ) : (
                  <p
                    className="cursor-text text-sm leading-relaxed"
                    onClick={() => {
                      setActiveIndex(sentence.index);
                      setNotice(null);
                    }}
                  >
                    {sentence.text}
                  </p>
                )}

                {active && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={() => doSplit(sentence.index)}>在光标处拆分</Button>
                    <Button
                      disabled={i === lesson.sentences.length - 1}
                      onClick={() => doMerge(sentence.index)}
                    >
                      与下一句合并
                    </Button>
                    <Button
                      variant={sentence.excluded ? 'secondary' : 'ghost'}
                      onClick={() =>
                        void apply({
                          sentences: setExcluded(lesson.sentences, sentence.index, !sentence.excluded),
                        })
                      }
                    >
                      {sentence.excluded ? '取消排除' : '标为非朗读内容'}
                    </Button>
                    <Button variant="ghost" onClick={() => setActiveIndex(null)}>
                      收起
                    </Button>
                  </div>
                )}

                {active && (
                  <Hint>
                    拆分点 = 上面文本框里的光标位置。点一下要断开的地方，再按「在光标处拆分」。
                  </Hint>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <ResegmentPanel lesson={lesson} plainText={plainText} onCommit={resegmentLesson} />
    </div>
  );
}

function ExcludeTailControl({ onExclude }: { onExclude: (n: number) => void }) {
  const [n, setN] = useState(5);
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-neutral-600">批量排除文末</span>
      <input
        type="number"
        min={1}
        value={n}
        onChange={(e) => setN(Math.max(1, Number(e.target.value) || 1))}
        className="w-16 rounded border border-neutral-300 px-2 py-1"
      />
      <span className="text-neutral-600">句</span>
      <Button onClick={() => onExclude(n)}>执行</Button>
    </div>
  );
}

/**
 * FR-1.5：重新编辑原文并重新切句。
 * 先预览再提交 —— 有标注但匹配不上的旧句要摆到用户面前确认，不能推上去才说「顺便丢了 3 处标注」。
 */
function ResegmentPanel({
  lesson,
  plainText,
  onCommit,
}: {
  lesson: Lesson;
  plainText: string;
  onCommit: (lessonId: string, plainText: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(plainText);
  const [preview, setPreview] = useState<ReturnType<typeof resegment> | null>(null);

  if (!open) {
    return (
      <Button variant="ghost" onClick={() => { setDraft(plainText); setOpen(true); }}>
        重新编辑原文…
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-neutral-300 p-4">
      <h3 className="font-semibold">重新编辑原文并重新切句</h3>
      <textarea
        className="h-64 w-full rounded border border-neutral-300 p-3 font-mono text-sm"
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setPreview(null); }}
      />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setPreview(resegment(lesson.sentences, segmentSentences(draft)))}>
          预览重切结果
        </Button>
        <Button
          variant="primary"
          disabled={!preview}
          onClick={() => {
            void onCommit(lesson.id, draft);
            setOpen(false);
            setPreview(null);
          }}
        >
          确认重新切句
        </Button>
        <Button variant="ghost" onClick={() => { setOpen(false); setPreview(null); }}>
          取消
        </Button>
      </div>

      {preview && (
        <div className="space-y-2 text-sm">
          <p>
            新文稿切出 {preview.sentences.length} 句，其中 {preview.carriedOver.size} 句沿用了原有标注。
          </p>
          {preview.orphaned.length > 0 ? (
            <Banner tone="warn">
              下面 {preview.orphaned.length} 句带着标注，但在新文稿里找不到对应句子，确认后其时间戳与挖空将被丢弃：
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {preview.orphaned.map((s) => (
                  <li key={s.index}>{s.text}</li>
                ))}
              </ul>
            </Banner>
          ) : (
            <Banner tone="ok">没有标注会丢失。</Banner>
          )}
        </div>
      )}
    </div>
  );
}
