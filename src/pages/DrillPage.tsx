// FR-22 速背 —— 独立于复习（FR-10 / FR-21）的「快速背单词」。
//
// 首页选模式 / 范围 / 轮长 → 开一轮 → 一张张答 → 小结。形状见 SPEC §12.21。
//
// ── 与复习页的区别，一句话 ──
// 复习页受 newPerDay 管、一个词挂两张 FSRS 卡、题面按卡龄换题型；
// 这里想背多少背多少、进度是自己的（`drill` 文档）、四个选项永远是中文。
// 评分仍然是系统算（FR-10.4 的 gradeFromAnswer），**只有一轮里第一次作答进调度**（FR-22.7）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from '@/app/router';
import { preloadSfx, playSfx } from '@/audio/sfx';
import { lookupDict } from '@/dict/lookup';
import { prefetchWordAudio } from '@/dict/audio';
import { newCard, review } from '@/srs/fsrs';
import { gradeFromAnswer } from '@/srs/grade';
import { aiAvailable } from '@/ai/explain';
import { glossWithAi } from '@/ai/gloss';
import {
  advanceRun,
  buildDrillChoices,
  cardOf,
  isRetry,
  planRound,
  recordAnswer,
  runFinished,
  splitPool,
  startRun,
  summarizeRun,
  type DrillChoice,
  type RoundRun,
} from '@/drill/round';
import {
  getDrillState,
  ROUND_SIZES,
  updateDrillState,
  withCustom,
  withMark,
  withPrefs,
  withProgress,
} from '@/drill/state';
import { buildPool, countByCategory, customItemId, findInWordbank, getCachedWordbank, refreshWordbank } from '@/drill/wordbank';
import { CATEGORY_LABELS, type CachedWordbank, type DrillCategory, type DrillMode, type DrillState, type PoolItem } from '@/drill/types';
import { scheduleDrillSync, syncDrillNow } from '@/sync/trigger';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useVocabStore } from '@/state/useVocabStore';
import { Banner, Button, Disclosure, EmptyState, Hint, Note, field } from '@/components/ui';
import { DrillCard, drillArticled, type CardPhase } from './drill/DrillCard';
import { toDrillPos } from './drill/AddToDrill';

const FLASH_MS = 600;
const VERDICT_SFX_MS = 120;
const CATEGORIES: DrillCategory[] = ['daily', 'work', 'it', 'mine'];

interface ActiveRound {
  mode: DrillMode;
  items: Map<string, PoolItem>;
  /** 出题用的池子（干扰项从这里取），开轮时冻结。 */
  pool: PoolItem[];
  run: RoundRun;
}

export function DrillPage() {
  const { settings } = useSettingsStore();
  const [state, setState] = useState<DrillState | null>(null);
  const [bank, setBank] = useState<CachedWordbank | undefined | 'loading'>('loading');
  const [round, setRound] = useState<ActiveRound | null>(null);
  const [done, setDone] = useState<{ mode: DrillMode; run: RoundRun; items: Map<string, PoolItem> } | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [s, cached] = await Promise.all([getDrillState(), getCachedWordbank()]);
      if (cancelled) return;
      setState(s);
      setBank(cached);
      // 进页面就问一次服务器有没有新版（FR-22.3）。手上有旧的就先用旧的，不等它。
      const fresh = await refreshWordbank();
      if (!cancelled && fresh) setBank(fresh);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (settings.soundEffects) void preloadSfx();
  }, [settings.soundEffects]);

  // 离开页面：这一轮的进度不等去抖，立刻推（FR-22.11）。
  useEffect(() => () => void syncDrillNow(), []);

  const update = useCallback(async (fn: (s: DrillState) => DrillState) => {
    const next = await updateDrillState(fn);
    setState(next);
    scheduleDrillSync();
    return next;
  }, []);

  const wordbank = bank === 'loading' ? undefined : bank;

  const start = async () => {
    // 从库里现读，不用 render 时的 `state`：刚点完「单词」「10」马上点「开始」时，
    // 那两次偏好还在落库的路上，闭包里的是旧的（浏览器里实测踩到过：开出来的是音频 20）。
    // updateDrillState 串行，所以排在它后面读，一定读到那两次写之后的值。
    const state = await updateDrillState((s) => s);
    setState(state);
    const mode = state.prefs.mode;
    const pool = buildPool(wordbank, state);
    const items = planRound(pool, state, mode, state.prefs.roundSize, Date.now());
    if (items.length === 0) return;
    setDone(null);
    // 音频模式先把这一轮的发音取好（FR-17.6 同一条：答题时很可能没网）。
    // 已经取过的词 prefetchWordAudio 自己会跳过，所以第二轮起几乎是零请求。
    if (mode === 'audio') {
      setPreparing(`取发音 0/${items.length}`);
      await prefetchWordAudio(
        items.map((i) => i.w),
        (d, t) => setPreparing(`取发音 ${d}/${t}`),
      ).catch(() => undefined);
    }
    setPreparing(null);
    setRound({ mode, pool, items: new Map(items.map((i) => [i.id, i])), run: startRun(items) });
  };

  const finish = useCallback((r: ActiveRound) => {
    setRound(null);
    setDone({ mode: r.mode, run: r.run, items: r.items });
    void syncDrillNow();
  }, []);

  if (state === null || bank === 'loading') return <EmptyState>加载中…</EmptyState>;

  if (preparing) return <EmptyState>{preparing}</EmptyState>;

  if (round) {
    return (
      <RoundView
        round={round}
        state={state}
        soundOn={settings.soundEffects}
        onRound={setRound}
        onUpdate={update}
        onFinish={finish}
        onQuit={() => finish(round)}
      />
    );
  }

  if (done) {
    const sum = summarizeRun(done.run);
    return (
      <EmptyState>
        <p className="text-ui">
          这一轮 {sum.total} 个词，一次答对 {sum.firstTry} 个。
        </p>
        {sum.missed.length > 0 && (
          <ul className="mx-auto mt-3 max-w-md space-y-1 text-left">
            {sum.missed.map((id) => {
              const it = done.items.get(id);
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
        <div className="mt-4 flex justify-center gap-2">
          <Button variant="primary" onClick={() => void start()}>
            再来一轮
          </Button>
          <Button onClick={() => setDone(null)}>回速背首页</Button>
        </div>
      </EmptyState>
    );
  }

  return (
    <DrillHome
      state={state}
      wordbank={wordbank}
      onUpdate={update}
      onStart={() => void start()}
      onRetryBank={async () => {
        const fresh = await refreshWordbank();
        if (fresh) setBank(fresh);
      }}
    />
  );
}

// ── 首页 ────────────────────────────────────────────────────────────────

function DrillHome({
  state,
  wordbank,
  onUpdate,
  onStart,
  onRetryBank,
}: {
  state: DrillState;
  wordbank: CachedWordbank | undefined;
  onUpdate: (fn: (s: DrillState) => DrillState) => Promise<DrillState>;
  onStart: () => void;
  onRetryBank: () => Promise<void>;
}) {
  const { prefs } = state;
  const counts = useMemo(() => countByCategory(wordbank, state), [wordbank, state]);
  const pool = useMemo(() => buildPool(wordbank, state), [wordbank, state]);
  const split = useMemo(() => splitPool(pool, state, prefs.mode, Date.now()), [pool, state, prefs.mode]);

  if (!wordbank && counts.mine === 0) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="hidden text-title font-semibold sm:block">快速背单词</h1>
        <Banner tone="warn" title="词库还没下载" action={<Button onClick={() => void onRetryBank()}>重试</Button>}>
          <p>速背的词库放在同步服务器上，联网后打开这一页就会自动下载。</p>
        </Banner>
      </div>
    );
  }

  const setPrefs = (patch: Parameters<typeof withPrefs>[1]) => void onUpdate((s) => withPrefs(s, patch, Date.now()));
  const toggleCategory = (c: DrillCategory) => {
    const has = prefs.categories.includes(c);
    const next = has ? prefs.categories.filter((x) => x !== c) : [...prefs.categories, c];
    if (next.length > 0) setPrefs({ categories: next });
  };

  const total = split.due.length + split.fresh.length;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="hidden text-title font-semibold sm:block">快速背单词</h1>

      {/* 模式：两个大分段按钮，各自一份进度（FR-22.4） */}
      <div className="space-y-1">
        <div className="grid grid-cols-2 gap-2">
          {(['audio', 'word'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={prefs.mode === m}
              onClick={() => setPrefs({ mode: m })}
              className={`min-h-14 rounded-box border text-de font-semibold ${
                prefs.mode === m ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong bg-raised text-ink'
              }`}
            >
              {m === 'audio' ? '🔊 音频' : 'Aa 单词'}
            </button>
          ))}
        </div>
        <p className="text-note text-faint">
          {prefs.mode === 'audio' ? '只放声音，听出来选中文意思。' : '只给词形，不放声音，选中文意思。'}两种模式各记各的进度。
        </p>
      </div>

      {/* 范围：三大类 + 我加的 */}
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((c) => {
          const on = prefs.categories.includes(c);
          return (
            <button
              key={c}
              type="button"
              aria-pressed={on}
              onClick={() => toggleCategory(c)}
              className={`rounded-full border px-3 py-1 text-ui ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'}`}
            >
              {CATEGORY_LABELS[c]}（{counts[c]}）
            </button>
          );
        })}
      </div>

      {/* 轮长 */}
      <div className="flex items-center gap-2">
        <span className="text-ui text-muted">一轮</span>
        {ROUND_SIZES.map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={prefs.roundSize === n}
            onClick={() => setPrefs({ roundSize: n })}
            className={`min-w-11 rounded-ctl border px-2 py-1 text-ui tnum ${
              prefs.roundSize === n ? 'border-accent text-accent' : 'border-line text-muted'
            }`}
          >
            {n}
          </button>
        ))}
        <span className="text-ui text-muted">个词</span>
      </div>

      <div className="space-y-1">
        <Button variant="primary" className="w-full py-4 text-de" disabled={total === 0} onClick={onStart}>
          开始一轮
        </Button>
        <p className="text-center text-note text-faint tnum">
          这个模式里到期 {split.due.length} · 还没学过 {split.fresh.length}
        </p>
      </div>

      <ImportLookups state={state} wordbank={wordbank} onUpdate={onUpdate} />

      <FlaggedList state={state} wordbank={wordbank} onUpdate={onUpdate} />

      <p className="text-note text-faint">
        {wordbank
          ? `词库 ${wordbank.items.length} 个词 · 版本 ${wordbank.version} · ${new Date(wordbank.fetchedAt).toLocaleString('zh-CN', { hour12: false })} 从服务器更新`
          : '词库还没下载（只有你自己加的词）'}
      </p>
    </div>
  );
}

/** 「已标记（N）」：集中改中文、取消标记（FR-22.9）。 */
function FlaggedList({
  state,
  wordbank,
  onUpdate,
}: {
  state: DrillState;
  wordbank: CachedWordbank | undefined;
  onUpdate: (fn: (s: DrillState) => DrillState) => Promise<DrillState>;
}) {
  const flagged = useMemo(() => {
    const byId = new Map(buildPool(wordbank, state, CATEGORIES).map((i) => [i.id, i]));
    return Object.entries(state.marks)
      .filter(([, m]) => m.flagged)
      .sort((a, b) => b[1].ts - a[1].ts)
      .map(([id]) => byId.get(id))
      .filter((x): x is PoolItem => Boolean(x));
  }, [state, wordbank]);

  if (flagged.length === 0) return null;
  return (
    <Disclosure summary={`已标记（${flagged.length}）`}>
      <ul className="divide-y divide-line rounded-box border border-line bg-raised">
        {flagged.map((item) => (
          <FlaggedRow key={item.id} item={item} onUpdate={onUpdate} />
        ))}
      </ul>
    </Disclosure>
  );
}

function FlaggedRow({
  item,
  onUpdate,
}: {
  item: PoolItem;
  onUpdate: (fn: (s: DrillState) => DrillState) => Promise<DrillState>;
}) {
  const [draft, setDraft] = useState(item.zh);
  useEffect(() => setDraft(item.zh), [item.zh]);
  const dirty = draft.trim() !== '' && draft.trim() !== item.zh;
  return (
    <li className="flex flex-wrap items-center gap-2 p-3">
      <span className="min-w-24 text-de font-medium">{drillArticled(item)}</span>
      <input
        className={`${field} min-w-0 flex-1 px-2 py-1`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={`${item.w} 的中文`}
      />
      <Button disabled={!dirty} onClick={() => void onUpdate((s) => withMark(s, item.id, { zh: draft.trim() }, Date.now()))}>
        保存
      </Button>
      <Button variant="ghost" onClick={() => void onUpdate((s) => withMark(s, item.id, { flagged: false }, Date.now()))}>
        取消标记
      </Button>
    </li>
  );
}

/**
 * FR-22.10 的第二个入口：生词本里查词加进来的词（`VocabEntry.lookup`），一键也进速背。
 * 中文：词条上的 `meaningZh` → 内置词典第一条 → 一批问 AI；三样都没有的跳过并说出来。
 */
function ImportLookups({
  state,
  wordbank,
  onUpdate,
}: {
  state: DrillState;
  wordbank: CachedWordbank | undefined;
  onUpdate: (fn: (s: DrillState) => DrillState) => Promise<DrillState>;
}) {
  const entries = useVocabStore((s) => s.entries);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const candidates = useMemo(
    () =>
      entries.filter((e) => {
        if (!e.lookup) return false;
        const word = e.lemma ?? e.surface;
        const mine = state.custom[customItemId(word)];
        return !(mine && !mine.deleted) && !findInWordbank(wordbank, word);
      }),
    [entries, state.custom, wordbank],
  );

  if (candidates.length === 0 && !result) return null;
  if (result) return <Note tone="ok">{result}</Note>;

  const run = async () => {
    setBusy(true);
    try {
      const rows = await Promise.all(
        candidates.map(async (e) => {
          const word = e.lemma ?? e.surface;
          const hit = await lookupDict(word).catch(() => null);
          const sense = hit?.entry.s[0];
          return { word, pos: sense?.p, gender: e.gender ?? sense?.g, zh: e.meaningZh?.trim() || sense?.zh?.[0] || '' };
        }),
      );
      const missing = rows.filter((r) => !r.zh);
      if (missing.length > 0 && (await aiAvailable())) {
        try {
          const glosses = await glossWithAi(missing.slice(0, 40).map((r) => ({ word: r.word })));
          missing.slice(0, 40).forEach((r, i) => (r.zh = glosses[i]?.trim() ?? ''));
        } catch {
          // 问不到就跳过那几个，下面如实说
        }
      }
      const ok = rows.filter((r) => r.zh);
      const now = Date.now();
      await onUpdate((s) =>
        ok.reduce(
          (acc, r, i) =>
            withCustom(acc, { id: customItemId(r.word), w: r.word, p: toDrillPos(r.pos), g: r.gender, zh: r.zh }, now + i),
          s,
        ),
      );
      const skipped = rows.length - ok.length;
      setResult(`加进速背 ${ok.length} 个${skipped > 0 ? `；${skipped} 个没有中文、没加（在查词面板里补上中文再加）` : ''}。`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Note
      tone="accent"
      action={
        <Button disabled={busy} onClick={() => void run()}>
          {busy ? '正在加…' : `把查词加的 ${candidates.length} 个也加进来`}
        </Button>
      }
    >
      生词本里有 {candidates.length} 个查词加的词还不在速背里。
    </Note>
  );
}

// ── 一轮 ────────────────────────────────────────────────────────────────

function RoundView({
  round,
  state,
  soundOn,
  onRound,
  onUpdate,
  onFinish,
  onQuit,
}: {
  round: ActiveRound;
  state: DrillState;
  soundOn: boolean;
  onRound: (r: ActiveRound) => void;
  onUpdate: (fn: (s: DrillState) => DrillState) => Promise<DrillState>;
  onFinish: (r: ActiveRound) => void;
  onQuit: () => void;
}) {
  const [phase, setPhase] = useState<CardPhase>('asking');
  const [picked, setPicked] = useState<string | null>(null);
  /** 作答要等一次落库：那几十毫秒里再点一下不能算第二次作答。 */
  const answering = useRef(false);
  const { run, mode } = round;
  const id = run.queue[run.position];
  const base = round.items.get(id)!;
  // 标记里改过的中文要立刻生效：卡背保存之后，「正确项」那一格也跟着变。
  const item: PoolItem = { ...base, zh: state.marks[id]?.zh?.trim() || base.zh };
  const retry = isRetry(run);

  // 选项每张卡只组一次（position 变了才重组）—— 否则改中文时选项会在手底下重排。
  const choicesRef = useRef<{ key: string; choices: DrillChoice[] } | null>(null);
  const choiceKey = `${run.position}:${id}`;
  if (choicesRef.current?.key !== choiceKey) {
    choicesRef.current = { key: choiceKey, choices: buildDrillChoices(item, round.pool) };
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
    // FR-22.7：只有这一轮里第一次作答进调度。
    if (!retry) {
      const card = cardOf(state, mode, id) ?? newCard();
      const rating = gradeFromAnswer({ correct, gaveUp: choiceId === null, elapsedMs }, card);
      const next = review(card, rating);
      await onUpdate((s) => withProgress(s, mode, id, next, Date.now()));
    }
    onRound({ ...round, run: recordAnswer(run, correct) });
    setPhase(correct ? 'flash' : 'revealed');
    answering.current = false;
  };

  const advance = useCallback(() => {
    setPhase('asking');
    setPicked(null);
    const next = advanceRun(round.run);
    if (runFinished(next)) onFinish({ ...round, run: next });
    else onRound({ ...round, run: next });
  }, [round, onFinish, onRound]);

  useEffect(() => {
    if (phase !== 'flash') return;
    const timer = setTimeout(advance, FLASH_MS);
    return () => clearTimeout(timer);
  }, [phase, advance]);

  const wrongSoFar = Object.values(run.first).filter((v) => !v).length;

  return (
    <div className="mx-auto flex min-h-[80vh] max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 text-ui text-muted">
        <span className="tnum">
          {run.position + 1} / {run.queue.length}
        </span>
        <span>{mode === 'audio' ? '音频' : '单词'}</span>
        {wrongSoFar > 0 && <span className="tnum">本轮错 {wrongSoFar}</span>}
        <button type="button" className="ml-auto text-note underline" onClick={onQuit}>
          结束这一轮
        </button>
      </div>
      <DrillCard
        key={choiceKey}
        item={item}
        mode={mode}
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

/** 生词本页上那块入口卡片（§12.21）。 */
export function DrillEntryCard() {
  const [info, setInfo] = useState<{ total: number; due: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [s, bank] = await Promise.all([getDrillState(), getCachedWordbank()]);
      if (cancelled) return;
      const pool = buildPool(bank, s, CATEGORIES);
      const now = Date.now();
      const due = new Set<string>();
      for (const m of ['audio', 'word'] as const) for (const it of splitPool(pool, s, m, now).due) due.add(it.id);
      setInfo({ total: pool.length, due: due.size });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-box border border-line bg-raised p-4">
      <div className="mr-auto">
        <p className="font-semibold">快速背单词</p>
        <p className="text-note text-faint tnum">
          {info ? (info.total > 0 ? `词库 ${info.total} · 今天到期 ${info.due}` : '日常 · 工作 · IT，中文四选一') : '…'}
        </p>
      </div>
      <Button variant="primary" onClick={() => navigate({ name: 'drill' })}>
        开始
      </Button>
    </div>
  );
}
