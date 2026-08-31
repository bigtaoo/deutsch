// FR-14：DW 素材的 Glossar 候选词。
//
// FR-14.1 的分寸在这里：候选**不自动建条目**。DW 标的是「DW 认为该讲的词」，
// 不是「我不认识的词」—— 原始需求明确抱怨过现有 app 不能按后者挖空。
// 所以默认是一条条点，「全部接受」只是一个按钮（FR-14.5），不是默认行为。

import { useMemo, useState } from 'react';
import { useLessonStore } from '@/state/useLessonStore';
import { useVocabStore } from '@/state/useVocabStore';
import { Button, Hint, Section } from '@/components/ui';
import type { GlossaryCandidate, Lesson, LessonCache } from '@/types/models';

export interface AcceptResult {
  ok: boolean;
  reason?: string;
}

/**
 * 接受一条候选 = FR-7.3 的一次点击版本。
 *
 * 模块级函数而不是 hook：正文里的下划线（StudyTab）和下面的列表面板都要用它，
 * 而且「全部接受」是个串行循环 —— 每一轮都必须从 store 重新取这一课，
 * 因为上一轮已经把挖空写回去了，闭包里的 lesson 立刻就是旧的。
 */
export async function acceptCandidate(lessonId: string, candidate: GlossaryCandidate): Promise<AcceptResult> {
  const lesson = useLessonStore.getState().lessons.find((l) => l.id === lessonId);
  const sentence = lesson?.sentences[candidate.sentenceIndex];
  if (!lesson || !sentence) return { ok: false, reason: '这一句在重新切句后已不存在' };

  // §3.3 R1 对候选词一样成立：没有时间戳的挖空既不能听写、也生成不了带音频的卡。
  if (sentence.startTime === undefined) return { ok: false, reason: '所在句还没有时间戳，先去「标注」打点' };

  try {
    // FR-14.3：surface / lemma / gender / plural / meaning 一次填满，省掉手工录入。
    await useVocabStore.getState().createFromSelection({
      lesson,
      sentence,
      ranges: candidate.ranges,
      prefill: {
        lemma: candidate.lemma,
        gender: candidate.gender,
        plural: candidate.plural,
        meaning: candidate.meaning,
        dwKnowledgeId: candidate.dwKnowledgeId,
      },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function GlossaryCandidates({ lesson, cache }: { lesson: Lesson; cache: LessonCache | undefined }) {
  const entries = useVocabStore((s) => s.entries);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Array<{ surface: string; reason: string }>>([]);

  // FR-14.1 验收：已接受的候选（靠 dwKnowledgeId 反查）不再出现在列表里。
  const accepted = useMemo(
    () => new Set(entries.filter((e) => e.dwKnowledgeId).map((e) => e.dwKnowledgeId!)),
    [entries],
  );

  const pending = (cache?.glossary ?? []).filter((c) => !accepted.has(c.dwKnowledgeId));
  if (pending.length === 0) return null;

  const accept = async (candidate: GlossaryCandidate) => {
    const result = await acceptCandidate(lesson.id, candidate);
    if (!result.ok) {
      setFailed((f) => [...f, { surface: candidate.surface, reason: result.reason ?? '未知原因' }]);
    }
  };

  const acceptAll = async () => {
    setBusy(true);
    setFailed([]);
    try {
      for (const candidate of pending) await accept(candidate);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={`Glossar 候选词（${pending.length}）`}
      aside={
        <Button disabled={busy} onClick={() => void acceptAll()}>
          {busy ? '接受中…' : '全部接受'}
        </Button>
      }
    >
      <Hint>
        这是 DW 给这一期标的生词，不是「你不认识的词」。挑着接受 —— 有些期次二十多条，
        全接受会把生词本灌满你本来就认识的词。正文里带虚线下划线的就是它们，点一下即接受。
      </Hint>
      <ul className="divide-y divide-neutral-100">
        {pending.map((candidate) => (
          <li key={candidate.dwKnowledgeId} className="flex items-start gap-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p>
                <span className="font-medium">{candidate.surface}</span>
                {/* FR-14.4：解析不出格式时 title 原样保留，至少还认得出这是什么词条 */}
                <span className="ml-2 text-neutral-500">{candidate.title}</span>
              </p>
              {candidate.meaning && <p className="text-neutral-600">{candidate.meaning}</p>}
              <p className="text-xs text-neutral-400">
                {lesson.sentences[candidate.sentenceIndex]?.text.slice(0, 70) ?? '（这一句在重新切句后已不存在）'}
              </p>
            </div>
            <Button disabled={busy} onClick={() => void accept(candidate)}>
              接受
            </Button>
          </li>
        ))}
      </ul>
      {failed.length > 0 && (
        <Hint tone="warn">
          没能接受：{failed.map((f) => `${f.surface}（${f.reason}）`).join('、')}
        </Hint>
      )}
    </Section>
  );
}
