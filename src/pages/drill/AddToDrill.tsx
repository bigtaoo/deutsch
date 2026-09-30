// FR-22.10：查词面板里的「加入速背」。
//
// 与「加入生词本」**并列而不合并**：速背是独立的功能，一个词进不进 FSRS 复习
// 与进不进速背是两个决定（SPEC FR-22.10）。
//
// 中文预填：内置词典有中文就用第一条；没有、而 AI 可用，就问一次（按词义给一句）。
// 预填**只是预填**，输入框随时可改 —— 词典的中文不准正是这个功能存在的理由之一。

import { useEffect, useState } from 'react';
import { href } from '@/app/router';
import { aiAvailable } from '@/ai/explain';
import { glossWithAi } from '@/ai/gloss';
import { getDrillState, updateDrillState, withCustom } from '@/drill/state';
import { customItemId, findInWordbank, getCachedWordbank } from '@/drill/wordbank';
import type { DrillPos } from '@/drill/types';
import type { DictPos } from '@/dict/types';
import { scheduleDrillSync } from '@/sync/trigger';
import { Button, Hint, Note, field } from '@/components/ui';

export function toDrillPos(pos: DictPos | undefined): DrillPos {
  return pos === 'noun' || pos === 'verb' || pos === 'adj' || pos === 'adv' ? pos : 'other';
}

type Status = 'checking' | 'ready' | 'in-bank' | 'in-mine' | 'added';

export function AddToDrill({
  word,
  pos,
  gender,
  zh,
}: {
  /** 词头（查词还原过的那个）。 */
  word: string;
  pos?: DictPos;
  gender?: 'm' | 'f' | 'n';
  /** 内置词典的中文（第一条）；没有是 undefined。 */
  zh?: string;
}) {
  const [status, setStatus] = useState<Status>('checking');
  const [draft, setDraft] = useState(zh ?? '');
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus('checking');
    setDraft(zh ?? '');
    void (async () => {
      const [state, bank] = await Promise.all([getDrillState(), getCachedWordbank()]);
      if (cancelled) return;
      const mine = state.custom[customItemId(word)];
      if (mine && !mine.deleted) setStatus('in-mine');
      else if (findInWordbank(bank, word)) setStatus('in-bank');
      else setStatus('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [word, zh]);

  // 没有中文时自动问一次 AI —— 只在「可以加」的时候问，已经在词库里的词不花这笔钱。
  useEffect(() => {
    if (status !== 'ready' || zh) return;
    let cancelled = false;
    void (async () => {
      if (!(await aiAvailable())) return;
      setAsking(true);
      try {
        const [gloss] = await glossWithAi([{ word }]);
        if (!cancelled && gloss) setDraft((d) => d || gloss);
      } catch {
        // 问不到就让人自己填，不报错。输入框空着时「加入速背」按不下去 —— 这里中文是必需的。
      } finally {
        if (!cancelled) setAsking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, word, zh]);

  if (status === 'checking') return null;
  if (status === 'in-bank' || status === 'in-mine') {
    return (
      <Note tone="accent" action={<a className="underline" href={href({ name: 'drill' })}>去速背</a>}>
        <b>{word}</b> {status === 'in-bank' ? '已在速背词库里' : '已经加进速背了'}。
      </Note>
    );
  }
  if (status === 'added') {
    return (
      <Note tone="ok" action={<a className="underline" href={href({ name: 'drill' })}>去速背</a>}>
        <b>{word}</b> 已加进速背，下一轮新词里排最前。
      </Note>
    );
  }

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    await updateDrillState((s) =>
      withCustom(s, { id: customItemId(word), w: word, p: toDrillPos(pos), g: gender, zh: text }, Date.now()),
    );
    scheduleDrillSync();
    setStatus('added');
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        className={`${field} min-w-0 flex-1 px-2 py-1`}
        value={draft}
        placeholder={asking ? 'AI 正在给中文…' : '中文（速背的正确答案）'}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="速背用的中文"
      />
      <Button onClick={() => void add()} disabled={!draft.trim()}>
        加入速背
      </Button>
      <Hint>中文就是速背四选一的正确答案，可以先改好再加。</Hint>
    </div>
  );
}
