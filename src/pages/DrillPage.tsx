// FR-22 背单词 —— 每天 200 个，一次会话背完（变更 84）。
//
// 打开就是今天剩下的那些：到期的在前，新词在后（计划见 src/drill/daily.ts）。
// 随时可以「先停在这里」，回来接着背 —— 做没做完看的是每个词今天有没有复习记录，
// 不靠这一页记位置，所以换台设备接着背也对得上。
//
// ── 与变更 84 之前的区别 ──
// 以前首页选模式 / 范围 / 轮长再开一轮；现在没有首页（单词页的今日卡片就是入口），
// 两种模式合并成一种：卡面是词形，同时自动念一遍（FR-22.4′），进度只写 `word:`。
// 评分仍然是系统算（FR-10.4 的 gradeFromAnswer），**只有今天第一次作答进调度**（FR-22.7）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { href, navigate } from '@/app/router';
import { preloadSfx, playSfx } from '@/audio/sfx';
import { prefetchWordAudio } from '@/dict/audio';
import { newCard, review } from '@/srs/fsrs';
import { gradeFromAnswer } from '@/srs/grade';
import {
  advanceRun,
  buildDrillChoices,
  isRetry,
  recordAnswer,
  runFinished,
  skipCurrent,
  startRun,
  summarizeRun,
  type DrillChoice,
  type RoundRun,
} from '@/drill/round';
import { dayProgress, unifiedCard } from '@/drill/daily';
import { updateDrillState, withMark, withProgress } from '@/drill/state';
import { ensureToday } from '@/drill/useDrillToday';
import { buildPool, refreshWordbank } from '@/drill/wordbank';
import type { DrillState, PoolItem } from '@/drill/types';
import { scheduleDrillSync, syncDrillNow } from '@/sync/trigger';
import { useSettingsStore } from '@/state/useSettingsStore';
import { Button, EmptyState, Hint } from '@/components/ui';
import { DrillCard, drillArticled, type CardPhase } from './drill/DrillCard';

const FLASH_MS = 600;
const VERDICT_SFX_MS = 120;

export interface Session {
  items: Map<string, PoolItem>;
  /** 出题用的池子（干扰项从这里取），开始时冻结。 */
  pool: PoolItem[];
  run: RoundRun;
  /** 开始时今天已经做了几个 —— 顶部 `x / 200` 的起点。 */
  doneBefore: number;
  total: number;
}

export function DrillPage() {
  const { settings } = useSettingsStore();
  const [state, setState] = useState<DrillState | null>(null);
  const [session, setSession] = useState<Session | null | 'empty'>(null);
  const [ended, setEnded] = useState<Session | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 先问一次服务器有没有新版词库（FR-22.3）；拿不到就用手上那份。
      const bank = await refreshWordbank();
      const s = await ensureToday(bank);
      if (cancelled) return;
      setState(s);
      const pool = buildPool(bank, s);
      const byId = new Map(pool.map((p) => [p.id, p]));
      const progress = dayProgress(s, new Set(byId.keys()), Date.now());
      const items = (progress?.remaining ?? []).flatMap((id) => {
        const it = byId.get(id);
        return it ? [it] : [];
      });
      if (items.length === 0) {
        setSession('empty');
        return;
      }
      setSession({
        items: new Map(items.map((i) => [i.id, i])),
        pool,
        run: startRun(items),
        doneBefore: progress?.done ?? 0,
        total: progress?.total ?? items.length,
      });
      // 发音放后台取，不挡开始（取过的词它自己跳过）。答题时没网也有声音（FR-17.6 同一条）。
      void prefetchWordAudio(items.map((i) => i.w)).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (settings.soundEffects) void preloadSfx();
  }, [settings.soundEffects]);

  // 离开页面：进度不等去抖，立刻推（FR-22.11）。
  useEffect(() => () => void syncDrillNow(), []);

  const update = useCallback(async (fn: (s: DrillState) => DrillState) => {
    const next = await updateDrillState(fn);
    setState(next);
    scheduleDrillSync();
    return next;
  }, []);

  const stop = useCallback((s: Session) => {
    setEnded(s);
    void syncDrillNow();
  }, []);

  if (state === null || session === null) return <EmptyState>加载中…</EmptyState>;

  if (session === 'empty') {
    return (
      <EmptyState>
        <p className="text-ui">今天的背完了。</p>
        <div className="mt-4 flex justify-center">
          <Button onClick={() => navigate({ name: 'vocab' })}>回单词页</Button>
        </div>
      </EmptyState>
    );
  }

  if (ended) return <Summary session={ended} state={state} />;

  return (
    <SessionView
      session={session}
      state={state}
      soundOn={settings.soundEffects}
      onSession={setSession}
      onUpdate={update}
      onStop={stop}
    />
  );
}

function Summary({ session, state }: { session: Session; state: DrillState }) {
  const sum = summarizeRun(session.run);
  const finished = runFinished(session.run);
  return (
    <EmptyState>
      <p className="text-ui">
        {finished ? '今天的背完了。' : '先停在这里，回来接着背。'}这次 {sum.total} 个词，一次答对 {sum.firstTry} 个。
      </p>
      {sum.missed.length > 0 && (
        <ul className="mx-auto mt-3 max-w-md space-y-1 text-left">
          {sum.missed.map((id) => {
            const it = session.items.get(id);
            if (!it) return null;
            const zh = state.marks[id]?.zh?.trim() || it.zh;
            return (
              <li key={id} className="flex justify-between gap-3 text-ui">
                <span className="text-de font-medium">{drillArticled(it)}</span>
                <span className="text-muted">{zh}</span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-4 flex justify-center">
        <a className="flex min-h-11 items-center rounded-ctl border border-line px-4 text-ui" href={href({ name: 'vocab' })}>
          回单词页
        </a>
      </div>
    </EmptyState>
  );
}

/** 顶部的数：开始前做了的 + 这次第一次答过的（重做不再算）+ 这次斩掉的。 */
export function sessionDone(session: Session): number {
  const { run } = session;
  const killed = run.queue.slice(0, run.position).filter((x) => !(x in run.first)).length;
  return Math.min(session.total, session.doneBefore + Object.keys(run.first).length + killed);
}

function SessionView({
  session,
  state,
  soundOn,
  onSession,
  onUpdate,
  onStop,
}: {
  session: Session;
  state: DrillState;
  soundOn: boolean;
  onSession: (s: Session) => void;
  onUpdate: (fn: (s: DrillState) => DrillState) => Promise<DrillState>;
  onStop: (s: Session) => void;
}) {
  const [phase, setPhase] = useState<CardPhase>('asking');
  const [picked, setPicked] = useState<string | null>(null);
  /** 作答要等一次落库：那几十毫秒里再点一下不能算第二次作答。 */
  const answering = useRef(false);
  const { run } = session;
  const id = run.queue[run.position];
  const base = session.items.get(id)!;
  // 标记里改过的中文要立刻生效：卡背保存之后，「正确项」那一格也跟着变。
  const item: PoolItem = { ...base, zh: state.marks[id]?.zh?.trim() || base.zh };
  const retry = isRetry(run);

  // 选项每张卡只组一次（position 变了才重组）—— 否则改中文时选项会在手底下重排。
  const choicesRef = useRef<{ key: string; choices: DrillChoice[] } | null>(null);
  const choiceKey = `${run.position}:${id}`;
  if (choicesRef.current?.key !== choiceKey) {
    choicesRef.current = { key: choiceKey, choices: buildDrillChoices(item, session.pool) };
  }
  const choices = choicesRef.current.choices.map((c) => (c.correct ? { ...c, text: item.zh } : c));

  const answer = async (choiceId: string | null, correct: boolean, elapsedMs: number) => {
    if (phase !== 'asking' || answering.current) return;
    answering.current = true;
    setPicked(choiceId);
    if (soundOn) {
      const verdict = correct ? 'right' : 'wrong';
      setTimeout(() => playSfx(verdict), VERDICT_SFX_MS);
    }
    // FR-22.7：只有今天第一次作答进调度。进度一律写 `word:`（FR-22.4′）。
    if (!retry) {
      const card = unifiedCard(state, id) ?? newCard();
      const rating = gradeFromAnswer({ correct, gaveUp: choiceId === null, elapsedMs }, card);
      const next = review(card, rating);
      await onUpdate((s) => withProgress(s, 'word', id, next, Date.now()));
    }
    onSession({ ...session, run: recordAnswer(run, correct) });
    setPhase(correct ? 'flash' : 'revealed');
    answering.current = false;
  };

  const goTo = useCallback(
    (nextRun: RoundRun) => {
      setPhase('asking');
      setPicked(null);
      const next = { ...session, run: nextRun };
      if (runFinished(nextRun)) onStop(next);
      else onSession(next);
    },
    [session, onSession, onStop],
  );

  const advance = useCallback(() => goTo(advanceRun(session.run)), [goTo, session.run]);

  /** 斩（FR-22.15）：认识了，以后都不出。可以在单词页「斩掉的」里撤回。 */
  const kill = async () => {
    if (answering.current) return;
    answering.current = true;
    await onUpdate((s) => withMark(s, id, { known: true }, Date.now()));
    answering.current = false;
    goTo(skipCurrent(session.run));
  };

  useEffect(() => {
    if (phase !== 'flash') return;
    const timer = setTimeout(advance, FLASH_MS);
    return () => clearTimeout(timer);
  }, [phase, advance]);

  return (
    <div className="mx-auto flex min-h-[80vh] max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 text-ui text-muted">
        <span className="tnum">
          {sessionDone(session)} / {session.total}
        </span>
        <button type="button" className="min-h-11 text-note underline" onClick={() => onStop(session)}>
          先停在这里
        </button>
        {phase === 'asking' && !retry && (
          <button
            type="button"
            onClick={() => void kill()}
            className="ml-auto min-h-11 rounded-ctl border border-line px-3 text-ui text-muted active:scale-95"
            title="认识了，以后不再出"
          >
            斩
          </button>
        )}
      </div>
      <DrillCard
        key={choiceKey}
        item={item}
        mode="word"
        autoplay
        choices={choices}
        phase={phase}
        picked={picked}
        retry={retry}
        mark={state.marks[id]}
        soundOn={soundOn}
        onAnswer={(c, ok, ms) => void answer(c, ok, ms)}
        onContinue={advance}
        onSaveMark={async (patch) => {
          await onUpdate((s) => withMark(s, id, patch, Date.now()));
        }}
      />
      <Hint>键盘：1–4 选择 · 0 不认识 · 空格继续</Hint>
    </div>
  );
}
