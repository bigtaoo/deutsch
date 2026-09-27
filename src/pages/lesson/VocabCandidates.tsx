// FR-9.13：本课生词候选。形状见 SPEC §12.20。

import { useEffect, useMemo, useState } from 'react';
import { findCandidates, COMMON_BANDS, type CandidateResult, type VocabCandidate } from '@/lesson/vocabCandidates';
import { loadDeck, lookupDict } from '@/dict/lookup';
import { normalizeKey } from '@/dict/bucket';
import { queueZhGloss } from '@/ai/gloss';
import { useLessonStore } from '@/state/useLessonStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useVocabStore, vocabKey } from '@/state/useVocabStore';
import { Button, Hint, Section } from '@/components/ui';
import type { Lesson } from '@/types/models';

const ARTICLE = { m: 'der', f: 'die', n: 'das' } as const;

interface Common {
  keys: Set<string>;
  forms: Set<string>;
}
let commonPromise: Promise<Common> | null = null;

/**
 * 「常见」的两份表：牌组 1~3 档的词元（约 260KB）+ 前一万的词形（约 100KB）。整个会话只取一次。
 * 不走 lookup.ts 的 fetchJson：那个是模块内部的；这里同样不看 res.ok（SPA 回退给 200 + HTML），靠 parse 判。
 */
function loadCommon(): Promise<Common> {
  commonPromise ??= (async () => {
    const [decks, forms] = await Promise.all([
      Promise.all(COMMON_BANDS.map((id) => loadDeck(id))),
      fetch('/dict/common-forms.json')
        .then((r) => r.text())
        .then((t) => JSON.parse(t) as string[])
        .catch(() => [] as string[]),
    ]);
    const keys = new Set<string>();
    for (const deck of decks) for (const w of deck?.words ?? []) keys.add(normalizeKey(w.w));
    const result = { keys, forms: new Set(Array.isArray(forms) ? forms : []) };
    // 缺了哪一份（词典没部署、断网）：别缓存，下次再试
    if (keys.size === 0 || result.forms.size === 0) commonPromise = null;
    return result;
  })();
  return commonPromise;
}

/**
 * 串行加一批。模块级函数、每一轮都从 store 重取这一课 —— 与 acceptCandidate 同一个理由：
 * 挖空写在 Lesson 上，上一轮刚写回去，闭包里的 lesson 立刻就是旧的。
 */
export async function addCandidates(
  lessonId: string,
  candidates: readonly VocabCandidate[],
  onProgress?: (done: number) => void,
): Promise<{ added: number; failed: string[] }> {
  const created: string[] = [];
  const failed: string[] = [];
  for (const [i, c] of candidates.entries()) {
    const lesson = useLessonStore.getState().lessons.find((l) => l.id === lessonId);
    const sentence = lesson?.sentences[c.sentenceIndex];
    if (!lesson || !sentence || sentence.startTime === undefined) {
      failed.push(c.surface);
      continue;
    }
    try {
      const entry = await useVocabStore.getState().createFromSelection({ lesson, sentence, ranges: c.ranges });
      created.push(entry.id);
    } catch {
      failed.push(c.surface);
    }
    onProgress?.(i + 1);
  }
  queueZhGloss(created); // FR-9.15
  return { added: created.length, failed };
}

export function VocabCandidates({ lesson }: { lesson: Lesson }) {
  const entries = useVocabStore((s) => s.entries);
  const knownWords = useSettingsStore((s) => s.settings.knownWords);
  const updateSettings = useSettingsStore((s) => s.update);
  const [result, setResult] = useState<CandidateResult | null>(null);
  const [dictMissing, setDictMissing] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const takenKeys = useMemo(() => new Set(entries.map(vocabKey)), [entries]);
  const knownKeys = useMemo(() => new Set(knownWords ?? []), [knownWords]);

  useEffect(() => {
    // 加的过程中不重算：每加一个词 entries 都变一次，那会让列表在手底下跳
    if (progress) return;
    let cancelled = false;
    void (async () => {
      const common = await loadCommon();
      if (cancelled) return;
      // 少了哪一份都会把满篇常用词列成候选 —— 宁可不列
      if (common.keys.size === 0 || common.forms.size === 0) {
        setDictMissing(true);
        return;
      }
      setDictMissing(false);
      const next = await findCandidates(lesson, {
        lookup: lookupDict,
        commonKeys: common.keys,
        commonForms: common.forms,
        takenKeys,
        knownKeys,
      });
      if (!cancelled) setResult(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [lesson, takenKeys, knownKeys, progress]);

  // 勾过的词已经不在列表里了（加进去了、标了认识）就从勾选里拿掉
  const all = useMemo(() => [...(result?.found ?? []), ...(result?.unknown ?? [])], [result]);
  const selected = all.filter((c) => checked.has(c.key));
  const unchecked = all.filter((c) => !checked.has(c.key));

  if (dictMissing) {
    return (
      <Section title="本课生词候选">
        <Hint tone="warn">词典没加载到（多半是断网），列不出候选。正文里照样可以点词加。</Hint>
      </Section>
    );
  }
  if (!result) return null;
  if (!result.timed) {
    return (
      <Section title="本课生词候选">
        <Hint>这一课还没有时间戳，候选挂不上挖空 —— 先在课程页头部跑一次自动对齐。</Hint>
      </Section>
    );
  }
  if (all.length === 0 && !message) return null;

  const toggle = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const markKnown = async (keys: string[]) => {
    const merged = [...new Set([...(knownWords ?? []), ...keys])];
    await updateSettings({ knownWords: merged });
  };

  const add = async () => {
    const batch = selected;
    setMessage(null);
    setProgress({ done: 0, total: batch.length });
    try {
      const { added, failed } = await addCandidates(lesson.id, batch, (done) => setProgress({ done, total: batch.length }));
      setChecked(new Set());
      setMessage(
        `加进生词本 ${added} 个${failed.length ? `；没加上：${failed.join('、')}` : ''}。中文释义会在后台补上。`,
      );
    } finally {
      setProgress(null);
    }
  };

  const busy = progress !== null;

  return (
    <Section
      title={`本课生词候选（${all.length}）`}
      aside={
        <Button variant="ghost" onClick={() => setOpen(!open)}>
          {open ? '收起' : '展开'}
        </Button>
      }
    >
      {open && (
        <>
          <Hint>
            去掉了口语里常见的词和生词本里已有的，剩下的按难度排。不是「你不认识的词」—— 勾上不认识的，一次加进去。
          </Hint>
          {result.found.length > 0 && (
            <CandidateList lesson={lesson} items={result.found} checked={checked} busy={busy} onToggle={toggle} onKnown={(k) => void markKnown([k])} />
          )}
          {result.unknown.length > 0 && (
            <>
              <p className="text-note text-muted">词典里没有（多半是复合词，也可能是人名）</p>
              <CandidateList lesson={lesson} items={result.unknown} checked={checked} busy={busy} onToggle={toggle} onKnown={(k) => void markKnown([k])} />
            </>
          )}
          {message && <Hint tone="ok">{message}</Hint>}
          {all.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={busy || selected.length === 0} onClick={() => void add()}>
                {progress ? `正在加 ${progress.done}/${progress.total}…` : `加入选中的 ${selected.length} 个`}
              </Button>
              <Button
                disabled={busy || unchecked.length === 0}
                title="以后任何一课都不再列出这些词"
                onClick={() => void markKnown(unchecked.map((c) => c.key))}
              >
                没勾的 {unchecked.length} 个都认识
              </Button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function CandidateList({
  lesson,
  items,
  checked,
  busy,
  onToggle,
  onKnown,
}: {
  lesson: Lesson;
  items: VocabCandidate[];
  checked: ReadonlySet<string>;
  busy: boolean;
  onToggle: (key: string) => void;
  onKnown: (key: string) => void;
}) {
  return (
    <ul className="divide-y divide-line">
      {items.map((c) => (
        <li key={c.key} className="flex items-start gap-3 py-2 text-ui">
          <input
            type="checkbox"
            className="mt-1.5 shrink-0"
            aria-label={c.headword}
            checked={checked.has(c.key)}
            disabled={busy}
            onChange={() => onToggle(c.key)}
          />
          <div className="min-w-0 flex-1 cursor-pointer" onClick={() => !busy && onToggle(c.key)}>
            <p>
              <span className="text-de font-medium">
                {c.gender ? `${ARTICLE[c.gender]} ` : ''}
                {c.headword}
              </span>
              {c.surface !== c.headword && <span className="ml-2 text-note text-muted">{c.surface}</span>}
            </p>
            {c.meaning && <p className="truncate text-muted">{c.meaning}</p>}
            <p className="truncate text-note text-faint">{lesson.sentences[c.sentenceIndex]?.text.slice(0, 60)}</p>
          </div>
          <Button variant="ghost" className="shrink-0" disabled={busy} onClick={() => onKnown(c.key)}>
            认识
          </Button>
        </li>
      ))}
    </ul>
  );
}
