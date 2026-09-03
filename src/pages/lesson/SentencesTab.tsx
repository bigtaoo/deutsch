// FR-2.3 手工修正 + FR-1.4 段落排除 + FR-1.5 重新编辑原文。
//
// 这个界面是切句质量的兜底。§7.1 已经说清楚：规则再好也不可能覆盖全部，
// `Intl.Segmenter` 对 `z. B.` 一定会断错。所以合并/拆分不是「高级功能」，是主路径的一部分。

import { useMemo, useRef, useState } from 'react';
import { useLessonStore } from '@/state/useLessonStore';
import { segmentSentences } from '@/lesson/segment';
import { resegment } from '@/lesson/resegment';
import {
  displayNumbers,
  excludeLastN,
  mergeWithNext,
  setExcluded,
  setExcludedFirstN,
  splitSentence,
} from '@/lesson/sentences';
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
        <HeadControl
          onSet={(n, excluded) =>
            void apply(
              { sentences: setExcludedFirstN(lesson.sentences, n, excluded) },
              `开头 ${n} 句已${excluded ? '排除' : '恢复'}。排除范围变了 —— 去页头点「重新对齐」把时间戳按新范围重算一遍。`,
            )
          }
        />
        <ExcludeTailControl
          onExclude={(n) =>
            void apply(
              { sentences: excludeLastN(lesson.sentences, n) },
              `文末 ${n} 句已排除。排除范围变了 —— 去页头点「重新对齐」把时间戳按新范围重算一遍。`,
            )
          }
        />
      </div>

      <Hint>
        「排除」只留给音频里根本没念的段落（手动粘贴时的文末 Glossar）——
        排除句不参与对齐、跟读和听写。DW 的标题和导语是<strong>会被念出来</strong>的，
        所以不再自动排除；早先导入的课里那几句仍是排除态，用上面的「开头 N 句 → 恢复」一次撤掉。
      </Hint>

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

/**
 * 开头 N 句：排除 / 恢复。
 *
 * 默认 **0**，不是 3。曾经默认 3（DW 的「标题 + 导语」块恰好三句），但那是把
 * 「上一次我想排除几句」当成了「下一次该排除几句」—— 排除范围一改就得重新对齐，
 * 一个非零默认值加一次误点，代价是整课时间戳重算。0 时两个按钮都禁用，
 * 想批量操作的人自己填一个数，这一步同时就是确认。
 */
function HeadControl({ onSet }: { onSet: (n: number, excluded: boolean) => void }) {
  const [n, setN] = useState(0);
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-neutral-600">开头</span>
      <input
        type="number"
        min={0}
        value={n}
        onChange={(e) => setN(Math.max(0, Number(e.target.value) || 0))}
        className="w-16 rounded border border-neutral-300 px-2 py-1"
      />
      <span className="text-neutral-600">句</span>
      <Button disabled={n === 0} onClick={() => onSet(n, false)}>
        恢复
      </Button>
      <Button variant="ghost" disabled={n === 0} onClick={() => onSet(n, true)}>
        排除
      </Button>
    </div>
  );
}

/** 同上，默认 0：文末那几句 Glossar 只有手动粘贴的课才有，不该由默认值替所有课猜。 */
function ExcludeTailControl({ onExclude }: { onExclude: (n: number) => void }) {
  const [n, setN] = useState(0);
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-neutral-600">批量排除文末</span>
      <input
        type="number"
        min={0}
        value={n}
        onChange={(e) => setN(Math.max(0, Number(e.target.value) || 0))}
        className="w-16 rounded border border-neutral-300 px-2 py-1"
      />
      <span className="text-neutral-600">句</span>
      <Button disabled={n === 0} onClick={() => onExclude(n)}>
        执行
      </Button>
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
