// FR-9.11 / FR-9.12 / §12.16：把没弄明白的词交给外面的 AI，再把解释接回来。
//
// 形状是 `ZhPanel` 的双胞胎（复制走 → 在外面问 → 粘回来 → 对照预览 → 保存），
// 有意逐处对齐：这两块挨着放在生词本页底部，动作长得不一样只会让人每次重新学一遍。
//
// 一处关键差别：这里的解释是**多行自由文本**，所以预览里只摆第一行加一个字数 ——
// 摆全文的话四十个词的预览要翻十屏，而那一屏存在的意义是「编号有没有错位一格」，
// 看一眼词头对着的是不是那个意思就够了。

import { useMemo, useState } from 'react';
import { aiPreview, aiRequest, applyAiNotes, countMissingMeaning, pendingAi } from '@/srs/aiNotes';
import { parseTranslations } from '@/lesson/translation';
import { syncVocabNow } from '@/sync/trigger';
import { useVocabStore } from '@/state/useVocabStore';
import { Button, Disclosure, Hint, field } from '@/components/ui';

export function AiNotesPanel() {
  const { entries, updateEntries } = useVocabStore();
  const [pasted, setPasted] = useState('');
  const [manualCopy, setManualCopy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // 这一份顺序**就是编号**，所以它必须在复制和保存两次之间保持一致。
  // 依赖 entries：中间真的又标记了一个词，重算之后它排在末尾（createdAt 升序），
  // 前面的编号不动 —— 这正是 pendingAi 排序规则存在的理由。
  const pending = useMemo(() => pendingAi(entries), [entries]);
  const parsed = useMemo(() => parseTranslations(pasted), [pasted]);
  const preview = useMemo(() => aiPreview(pending, parsed), [pending, parsed]);

  // §12.16：一个词都不待办时整块不出现（与 ZhPanel、与「没贴过译文就不出现译文开关」同一条）。
  if (pending.length === 0) return null;

  const request = aiRequest(pending);
  const missing = countMissingMeaning(pending);

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
    const { updated, applied, strayNumbers } = applyAiNotes(pending, parsed);
    if (applied === 0) {
      setMessage('没有一条解释被写入 —— 检查一下编号是不是对得上。');
      return;
    }
    await updateEntries(updated);
    setPasted('');
    const stray =
      strayNumbers.length > 0
        ? `；${strayNumbers.length} 个编号没有对应的词（${strayNumbers.slice(0, 5).join('、')}…）`
        : '';
    setMessage(`写入 ${applied} 条解释${stray}`);
    // 不可重建的数据不过夜（FR-11.6）
    void syncVocabNow();
  };

  return (
    <Disclosure summary={`问 AI 补解释（${pending.length} 个词等着）`}>
      <Hint>
        {missing > 0
          ? `其中 ${missing} 个词两个词典都查不到，只有这条路能补；其余是你自己点「问 AI」标记的。`
          : '这些是你自己点「问 AI」标记的词。'}
        {' '}这里不解释词 —— 复制词表去 AI 会话里问，再把结果粘回来。
      </Hint>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => void copy()}>
          {copied ? '已复制 ✓' : '复制词表与提示词'}
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
        <Hint tone="warn">这个浏览器不让直接写剪贴板 —— 下面这一框已经选好了，自己复制走。</Hint>
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

      <textarea
        rows={6}
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        placeholder={'1. 第一个词的解释…\n2. 第二个词的解释…'}
        className={`${field} w-full p-3`}
      />

      {preview.length > 0 && (
        <>
          {/* 保存前的最后一道防线（§12.16）：编号错位一格在这里一眼看得见 */}
          <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-box border border-line">
            {preview.map((row) => (
              // 两行而不是一行四列：手机上 343px 宽挤四列的结果是德语词和中文各剩十来个
              // 像素，而这一屏要回答的正是「这个词对着的是不是这个意思」。
              <li key={row.n} className="px-3 py-1.5 text-ui">
                <div className="flex items-baseline gap-3">
                  <span className="w-8 shrink-0 text-note text-faint">{row.n}</span>
                  <span className="min-w-0 flex-1 truncate text-de" title={row.word}>{row.word}</span>
                  <span className="shrink-0 text-note text-faint">{row.note.length} 字</span>
                </div>
                <p className="truncate pl-11 text-muted" title={row.note}>
                  {row.note.split('\n')[0]}
                </p>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => void save()}>
              保存这 {preview.length} 条
            </Button>
            <Hint>认到 {parsed.size} 个编号 / 共 {pending.length} 个词</Hint>
          </div>
        </>
      )}

      {message && <Hint tone="ok">{message}</Hint>}
    </Disclosure>
  );
}
