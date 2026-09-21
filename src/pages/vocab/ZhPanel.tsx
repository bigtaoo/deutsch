// FR-21.9 / §12.14：给生词本里缺中译的词补上中文。
//
// **应用自己不翻译**（FR-19 同一条立场），只做交接：复制走 → 在外面翻 → 粘回来。
// 形状和 TranslationTab 是双胞胎，只有一处关键差别值得警惕 ——
// 那边的编号是句子的显示号（跟着课文走、稳定），这里的编号是**导出那一刻的序号**。
// 导出之后删过词，整篇就错位一格，而那种错误在数据里看不出来。
// 挡住它的是保存前那一屏对照预览：`Vorhang` 对着「过程」，一眼就发现了。

import { useMemo, useState } from 'react';
import { applyZh, pendingZh, zhPreview, zhRequest } from '@/srs/glossZh';
import { parseTranslations } from '@/lesson/translation';
import { syncVocabNow } from '@/sync/trigger';
import { useVocabStore } from '@/state/useVocabStore';
import { Button, Disclosure, Hint, field } from '@/components/ui';

export function ZhPanel() {
  const { entries, updateEntries } = useVocabStore();
  const [pasted, setPasted] = useState('');
  const [manualCopy, setManualCopy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // 这一份顺序**就是编号**，所以它必须在复制和保存两次之间保持一致。
  // 依赖 entries：中间真的加了词，重算之后新词排在末尾（createdAt 升序），
  // 前面的编号不动 —— 这正是 pendingZh 排序规则存在的理由。
  const pending = useMemo(() => pendingZh(entries), [entries]);
  const parsed = useMemo(() => parseTranslations(pasted), [pasted]);
  const preview = useMemo(() => zhPreview(pending, parsed), [pending, parsed]);

  // §12.14：一个词都不缺时整块不出现。永远显示「0 个词待补」只是每次打开生词本时
  // 提醒你它没用。
  if (pending.length === 0) return null;

  const request = zhRequest(pending);

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
    const { updated, applied, strayNumbers } = applyZh(pending, parsed);
    if (applied === 0) {
      setMessage('没有一条中文被写入 —— 检查一下编号是不是对得上。');
      return;
    }
    await updateEntries(updated);
    setPasted('');
    const stray = strayNumbers.length > 0 ? `；${strayNumbers.length} 个编号没有对应的词（${strayNumbers.slice(0, 5).join('、')}…）` : '';
    setMessage(`写入 ${applied} 条中文${stray}`);
    // 不可重建的数据不过夜（FR-11.6）
    void syncVocabNow();
  };

  return (
    <Disclosure summary={`补中译（${pending.length} 个词还没有中文）`}>
      <Hint>
        词典里的中译只覆盖一小半，所以复习的题面一律是德语释义，中文只出现在卡背。
        这里不翻译 —— 复制词表去你惯用的地方翻，再把结果粘回来。
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
        placeholder={'1. 第一个词的中文…\n2. 第二个词的中文…'}
        className={`${field} w-full p-3`}
      />

      {preview.length > 0 && (
        <>
          {/* 保存前的最后一道防线（§12.14）：编号错位一格在这里一眼看得见 */}
          <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-box border border-line">
            {preview.map((row) => (
              <li key={row.n} className="flex gap-3 px-3 py-1.5 text-ui">
                <span className="w-8 shrink-0 text-note text-faint">{row.n}</span>
                <span className="w-40 shrink-0 text-de">{row.word}</span>
                <span className="text-muted">{row.zh}</span>
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
