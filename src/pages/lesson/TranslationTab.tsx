// FR-19 译文页：把在外面译好的一整篇中文切回一句一句。
//
// 这一页**不在 tab 条里**（§12.9）。它跟「切句」同类 —— 一次性的准备工作，
// 不是每天要走的动线，所以收在课程页头部的「⋯」里。
//
// 三步：复制走（提示词 + 编号原文）→ 在外面翻 → 粘回来。
// 保存前先看对照预览：编号是锚，但锚本身贴错了（贴了另一课、或者贴完之后重切过句）
// 这里就该看得出来，而不是等到跟读时发现中文说的是下一句的事。

import { useMemo, useState } from 'react';
import { useLessonStore } from '@/state/useLessonStore';
import {
  applyTranslations,
  clearTranslations,
  parseTranslations,
  translationCoverage,
  translationRequest,
} from '@/lesson/translation';
import { displayNumbers } from '@/lesson/sentences';
import { Button, Hint, Note, Section, field } from '@/components/ui';
import type { Lesson, LessonCache } from '@/types/models';

export function TranslationTab({ lesson }: { lesson: Lesson; cache: LessonCache | undefined }) {
  const patchLesson = useLessonStore((s) => s.patchLesson);
  const [pasted, setPasted] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  /** 写剪贴板被浏览器拒了。和「自己点开手动复制」分开记，否则退路会静默出现。 */
  const [copyFailed, setCopyFailed] = useState(false);

  const request = useMemo(() => translationRequest(lesson.sentences, lesson.title), [lesson]);
  const coverage = translationCoverage(lesson.sentences);
  const numbers = useMemo(() => displayNumbers(lesson.sentences), [lesson.sentences]);

  // 一边打字一边解析：预览就是「保存之后会变成什么样」，没有第二套逻辑。
  const parsed = useMemo(() => parseTranslations(pasted), [pasted]);
  const preview = useMemo(() => {
    const rows: Array<{ n: number; text: string; translation: string | undefined }> = [];
    for (const sentence of lesson.sentences) {
      const n = numbers.get(sentence.index);
      if (n === undefined) continue;
      rows.push({ n, text: sentence.text, translation: parsed.get(n) });
    }
    return rows;
  }, [lesson.sentences, numbers, parsed]);
  const stray = useMemo(
    () => [...parsed.keys()].filter((n) => ![...numbers.values()].includes(n)).sort((a, b) => a - b),
    [parsed, numbers],
  );
  const missing = preview.filter((row) => row.translation === undefined).map((row) => row.n);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(request);
      setCopied(true);
      setManualCopy(false);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // WKWebView / 未授权剪贴板：退回「自己选中复制」，不假装成功也不报一句死消息。
      setManualCopy(true);
      setCopyFailed(true);
    }
  };

  const save = async () => {
    const { sentences, applied, strayNumbers } = applyTranslations(lesson.sentences, parsed);
    if (applied === 0) {
      setMessage('没有一条译文被写入 —— 检查一下编号是不是对得上。');
      return;
    }
    await patchLesson(lesson.id, (current) => ({ ...current, sentences }));
    setPasted('');
    setMessage(
      strayNumbers.length > 0
        ? `写入 ${applied} 条；有 ${strayNumbers.length} 个编号在这一课里不存在（${strayNumbers.slice(0, 8).join(', ')}），已忽略。`
        : `写入 ${applied} 条译文。`,
    );
  };

  const clear = async () => {
    if (!window.confirm(`清空这一课全部 ${coverage.translated} 条译文？这一步撤不回来。`)) return;
    await patchLesson(lesson.id, (current) => ({
      ...current,
      sentences: clearTranslations(current.sentences),
    }));
    setMessage('译文已清空。');
  };

  return (
    <div className="space-y-4">
      <Note tone={coverage.translated > 0 ? 'accent' : 'neutral'}>
        {coverage.translated > 0
          ? `${coverage.total} 句里 ${coverage.translated} 句有译文。译文在通听和跟读里显示，开关在那两页上。`
          : `还没有译文。这里不翻译 —— 复制原文去你惯用的地方翻，再把结果粘回来。`}
      </Note>

      <Section
        title="第一步：复制原文"
        aside={<Hint>{coverage.total} 句（排除句不在内）</Hint>}
      >
        <Hint>
          连提示词一起复制，粘给 Claude 之类的工具。提示词里已经写明「保留编号、一句一行」——
          编号是把译文对回句子的唯一依据。
        </Hint>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => void copy()}>
            {copied ? '已复制 ✓' : '复制原文与提示词'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setManualCopy((v) => !v);
              setCopyFailed(false);
            }}
          >
            {manualCopy ? '收起' : '自己选中复制'}
          </Button>
        </div>
        {copyFailed && (
          <Hint tone="warn">
            这个浏览器不让直接写剪贴板 —— 下面这一框已经选好了，自己复制走。
          </Hint>
        )}
        {manualCopy && (
          <textarea
            readOnly
            rows={8}
            value={request}
            onFocus={(e) => e.currentTarget.select()}
            className={`${field} w-full p-3 font-mono`}
          />
        )}
      </Section>

      <Section title="第二步：粘回译文">
        <textarea
          rows={8}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder={'1. 第一句的中文…\n2. 第二句的中文…'}
          className={`${field} w-full p-3`}
        />
        {pasted.trim().length > 0 && (
          <>
            <Note tone={parsed.size > 0 ? 'accent' : 'warn'}>
              认到 {parsed.size} 条
              {missing.length > 0 && `，${missing.length} 句没有对应的编号`}
              {stray.length > 0 && `；${stray.length} 个编号这一课里没有`}。
            </Note>
            {parsed.size === 0 && (
              <Hint tone="warn">
                一条都没认到 —— 多半是译文里没有编号。没有编号时这里宁可什么都不做，
                也不按行数去猜：猜错就是每一句的中文都指向另一句。
              </Hint>
            )}
            {stray.length > 0 && (
              <Hint tone="warn">
                这一课里没有第 {stray.slice(0, 8).join('、')} 句。是不是贴错了课，
                或者贴的是重新切句之前的那一份？
              </Hint>
            )}
            {parsed.size > 0 && (
              <>
                <Hint>保存前扫一眼对照，看中文说的是不是同一句的事。</Hint>
                <ol className="max-h-[50vh] space-y-2 overflow-y-auto rounded-box border border-line bg-surface p-3">
                  {preview.map((row) => (
                    <li key={row.n} className="space-y-0.5">
                      <p className="text-de">
                        <span className="mr-2 text-note text-faint tnum">{row.n}</span>
                        {row.text}
                      </p>
                      <p
                        className={`pl-6 text-ui ${row.translation ? 'text-muted' : 'text-warn'}`}
                      >
                        {row.translation ?? '（这一句没有对应的编号）'}
                      </p>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={parsed.size === 0} onClick={() => void save()}>
            保存译文
          </Button>
          {coverage.translated > 0 && (
            <Button variant="danger" onClick={() => void clear()}>
              清空全部译文
            </Button>
          )}
        </div>
        {message && <Hint tone="ok">{message}</Hint>}
        <Hint>
          这次没给到的句子保留原来的译文 —— 一篇太长分两次贴是常事。
        </Hint>
      </Section>
    </div>
  );
}
