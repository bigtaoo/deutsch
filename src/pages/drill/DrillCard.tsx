// FR-22 速背的一张题卡：音频 / 单词两种题面，中文四选一，答错展开卡背（可标记、可改中文）。
//
// 形状与复习页同一套（§12.21 / §12.13）：卡面居中、选项钉在底部拇指区、下面一个「不认识」。
// 声音走全局单例 `<audio>`（键前缀 `word:`）—— §3.2：iOS 只让手势链上的元素开始播放，
// 每张卡 new 一个 Audio 的话第二张起就静默被拒。

import { useCallback, useEffect, useRef, useState } from 'react';
import { audioPlayer } from '@/audio/player';
import { playSfx } from '@/audio/sfx';
import { aiAvailable, explainWithAi, getCachedAiNote } from '@/ai/explain';
import { ensureWordAudio, germanVoice, speak, type WordAudioSource } from '@/dict/audio';
import { lookupDict } from '@/dict/lookup';
import type { DictEntry } from '@/dict/types';
import type { DrillChoice } from '@/drill/round';
import type { DrillMark, DrillMode, PoolItem } from '@/drill/types';
import { Banner, Button, Card, field } from '@/components/ui';

export type CardPhase = 'asking' | 'flash' | 'revealed';

/** 带冠词的词形。只有复数的名词写 `die … (Pl.)`。 */
export function drillArticled(item: Pick<PoolItem, 'w' | 'g'>): string {
  if (item.g === 'pl') return `die ${item.w}（复数）`;
  if (!item.g) return item.w;
  return `${{ m: 'der', f: 'die', n: 'das' }[item.g]} ${item.w}`;
}

/** 反身动词的题面要带上 sich —— 不带就是另一个词。 */
function withSich(item: PoolItem): string {
  return item.n?.startsWith('sich ~') ? `sich ${item.w}` : item.w;
}

export function DrillCard({
  item,
  mode,
  choices,
  phase,
  picked,
  retry,
  mark,
  soundOn,
  onAnswer,
  onContinue,
  onSaveMark,
}: {
  item: PoolItem;
  mode: DrillMode;
  choices: DrillChoice[];
  phase: CardPhase;
  picked: string | null;
  /** 本轮里的重做（§12.21：标一个小字，免得以为是 bug）。 */
  retry: boolean;
  mark: DrillMark | undefined;
  soundOn: boolean;
  onAnswer: (choiceId: string | null, correct: boolean, elapsedMs: number) => void;
  onContinue: () => void;
  onSaveMark: (patch: { flagged?: boolean; zh?: string }) => void | Promise<void>;
}) {
  const [source, setSource] = useState<WordAudioSource | 'loading'>('loading');
  const startedAt = useRef(Date.now());

  const playWord = useCallback(async () => {
    const blob = await ensureWordAudio(item.w).catch(() => undefined);
    if (blob) {
      try {
        await audioPlayer.load(`word:${item.w}`, blob);
        await audioPlayer.play(0).catch(() => {});
        return;
      } catch {
        // 解码失败：退合成音
      }
    }
    speak(item.w);
  }, [item.w]);

  // 音频模式：进卡先判定有没有音源、再自动播一次（与复习页 word-only 那一档同一条顺序：
  // 「查」和「播」并成一步的话，iOS 拒绝自动播放时会被当成「没有音源」）。
  // 单词模式也要提前判定：卡背「念一遍」要在点击前就问好，否则撞 iOS 的手势链。
  useEffect(() => {
    let cancelled = false;
    setSource('loading');
    startedAt.current = Date.now();
    void (async () => {
      const blob = await ensureWordAudio(item.w).catch(() => undefined);
      if (cancelled) return;
      const s: WordAudioSource = blob ? 'human' : germanVoice() ? 'tts' : 'none';
      setSource(s);
      if (mode !== 'audio') return;
      startedAt.current = Date.now();
      if (blob) {
        try {
          await audioPlayer.load(`word:${item.w}`, blob);
          if (!cancelled) await audioPlayer.play(0).catch(() => {});
        } catch {
          // 解码失败：source 已经算出来了
        }
      } else if (s === 'tts' && !cancelled) {
        speak(item.w);
      }
    })();
    return () => {
      cancelled = true;
      audioPlayer.pause();
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    };
  }, [item.w, mode]);

  const tap = () => {
    if (soundOn) playSfx('tap');
  };
  const choose = (id: string | null, correct: boolean) => {
    tap();
    onAnswer(id, correct, Date.now() - startedAt.current);
  };

  // 键盘：1–4 选项，0 = 不认识，空格/回车继续。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return; // 正在改中文
      if (phase === 'revealed' && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        onContinue();
        return;
      }
      if (phase !== 'asking') return;
      if (e.key === '0') {
        e.preventDefault();
        choose(null, false);
        return;
      }
      const i = Number(e.key) - 1;
      if (Number.isInteger(i) && i >= 0 && i < choices.length) {
        e.preventDefault();
        choose(choices[i].id, choices[i].correct);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const noAudio = mode === 'audio' && source === 'none';

  return (
    <>
      {/* FR-10.11 同款：答对那 600ms 是名词的性露脸的地方 */}
      <div className="flex h-9 items-center justify-center">
        {phase === 'flash' && <p className="text-de font-semibold text-ok">✓ {drillArticled(item)}</p>}
      </div>

      <Card className="flex flex-1 flex-col justify-center space-y-4 p-6">
        {retry && phase === 'asking' && <p className="text-center text-note text-warn">重做</p>}
        {mode === 'audio' ? (
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              disabled={source === 'loading' || source === 'none'}
              onClick={() => void playWord()}
              aria-label="播放"
              className="flex size-20 items-center justify-center rounded-full bg-accent text-word text-accent-ink transition active:scale-95 disabled:opacity-40"
            >
              ▶
            </button>
            {noAudio ? (
              <Banner tone="warn" title="这个词没有声音，只能当文字题">
                <p>Wiktionary 上没有录音，系统里也没有德语嗓音。</p>
              </Banner>
            ) : (
              <p className="text-note text-faint">
                {source === 'human' ? '真人录音（Wiktionary，CC BY-SA）' : source === 'tts' ? '系统合成音' : '取音频中…'}
                {' · '}听这个词，选出它的意思
              </p>
            )}
            {noAudio && <p className="text-center text-word font-semibold">{withSich(item)}</p>}
          </div>
        ) : (
          <div className="space-y-2 text-center">
            <p className="text-note text-faint">这个词是什么意思</p>
            {/* 裸词形，不带冠词：性留给答对的 600ms 与卡背（FR-10.11 同一条） */}
            <p className="text-word font-semibold">{withSich(item)}</p>
            {item.n && item.n !== 'sich ~' && <p className="text-note text-muted">{item.n}</p>}
          </div>
        )}

        {phase === 'revealed' && (
          <DrillBack
            item={item}
            mark={mark}
            onPlay={source === 'human' || source === 'tts' ? () => void playWord() : undefined}
            onSaveMark={onSaveMark}
          />
        )}
      </Card>

      <div className="mt-auto space-y-2">
        <ChoiceGrid choices={choices} picked={picked} revealed={phase === 'revealed'} onPick={phase === 'asking' ? choose : undefined} />
        {phase === 'revealed' ? (
          <Button variant="primary" className="w-full py-4 text-de" onClick={onContinue}>
            继续 (Space)
          </Button>
        ) : (
          <Button className="w-full py-3" disabled={phase !== 'asking'} onClick={() => choose(null, false)}>
            {mode === 'audio' ? '没听清 / 不认识' : '不认识'}
          </Button>
        )}
      </div>
    </>
  );
}

/** 四个中文选项。**手机上也是 2×2**（§12.21）：中文一句话够短，2×2 省手。 */
function ChoiceGrid({
  choices,
  picked,
  revealed,
  onPick,
}: {
  choices: DrillChoice[];
  picked: string | null;
  revealed: boolean;
  onPick?: (id: string, correct: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {choices.map((choice, i) => {
        const tone = !revealed
          ? 'border-line-strong bg-raised hover:border-accent'
          : choice.correct
            ? 'border-ok bg-ok-soft text-ok'
            : choice.id === picked
              ? 'border-danger bg-danger-soft text-danger'
              : 'border-line bg-raised text-faint';
        return (
          <button
            key={choice.id}
            type="button"
            disabled={!onPick}
            onClick={() => onPick?.(choice.id, choice.correct)}
            className={`min-h-[4.5rem] rounded-box border px-3 py-3 text-left text-ui leading-snug ${tone}`}
          >
            <span className="mr-2 text-note text-faint">{i + 1}</span>
            {choice.text}
          </button>
        );
      })}
    </div>
  );
}

type AiState = 'idle' | 'loading' | 'failed' | 'off' | { note: string };

/**
 * 答错的卡背（FR-22.8）。顺序同 §12.13：词 → IPA → **正确中文**（这张卡的答案）→ 备注 →
 * 德语释义 → 例句 → AI 解析。中文那一行带「标记」；标记之后中文可改（FR-22.9）。
 */
function DrillBack({
  item,
  mark,
  onPlay,
  onSaveMark,
}: {
  item: PoolItem;
  mark: DrillMark | undefined;
  onPlay?: () => void;
  onSaveMark: (patch: { flagged?: boolean; zh?: string }) => void | Promise<void>;
}) {
  const [dict, setDict] = useState<DictEntry | null | 'loading'>('loading');
  const [ai, setAi] = useState<AiState>('idle');
  const [draft, setDraft] = useState(item.zh);
  const [saved, setSaved] = useState(false);
  const flagged = mark?.flagged ?? false;

  useEffect(() => {
    let cancelled = false;
    void lookupDict(item.w)
      .catch(() => null)
      .then((hit) => {
        if (!cancelled) setDict(hit?.entry ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [item.w]);

  /**
   * AI 解析：先查缓存（变更 49，跨设备同步），没有才问一次。
   * 与 FR-10.14 不同的地方：那边只在「一个中文字都没有」时问，这里每个词都有中文，
   * 照那条判据就永远不问了 —— 所以速背答错就要解析（SPEC FR-22.8），缓存保证一个词只付一次钱。
   */
  const askedRef = useRef(false);
  const askAi = useCallback(() => {
    if (askedRef.current) return;
    askedRef.current = true;
    setAi('loading');
    void (async () => {
      try {
        const cached = await getCachedAiNote(item.w).catch(() => undefined);
        if (cached !== undefined) {
          setAi({ note: cached });
          return;
        }
        if (!(await aiAvailable())) {
          setAi('off');
          return;
        }
        const note = await explainWithAi({ word: withSich(item), existing: item.zh });
        setAi({ note });
      } catch {
        setAi('failed');
      }
    })();
  }, [item]);

  useEffect(() => {
    askAi();
  }, [askAi]);

  const entry = dict === 'loading' ? null : dict;
  const sense = entry?.s.find((s) => (item.p === 'other' ? true : s.p === item.p)) ?? entry?.s[0];
  const plural = sense?.pl;
  const de = sense?.de?.[0];

  const save = async () => {
    const text = draft.trim();
    if (!text) return;
    await onSaveMark({ zh: text });
    setSaved(true);
  };

  return (
    <div className="space-y-2 border-t border-line pt-4">
      <p className="text-word font-semibold">
        {drillArticled(item)}
        {plural && <span className="ml-2 text-ui text-muted">{plural}</span>}
        {onPlay && (
          <button
            type="button"
            onClick={onPlay}
            className="ml-3 rounded-box border border-line px-2 py-1 align-middle text-note text-muted active:scale-95"
          >
            ♪ 念一遍
          </button>
        )}
      </p>
      {sense?.ipa && <p className="text-ui text-faint">[{sense.ipa}]</p>}

      <div className="flex flex-wrap items-center gap-2">
        {flagged ? (
          <>
            <input
              className={`${field} min-w-0 flex-1 px-2 py-1 text-de`}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setSaved(false);
              }}
              aria-label="改正确答案的中文"
            />
            <Button onClick={() => void save()} disabled={!draft.trim() || draft.trim() === item.zh}>
              保存
            </Button>
          </>
        ) : (
          <p className="mr-auto text-de">{item.zh}</p>
        )}
        <button
          type="button"
          onClick={() => void onSaveMark({ flagged: !flagged })}
          className={`rounded-box border px-2 py-1 text-note active:scale-95 ${flagged ? 'border-warn text-warn' : 'border-line text-muted'}`}
          aria-pressed={flagged}
        >
          {flagged ? '★ 已标记' : '☆ 标记'}
        </button>
      </div>
      {saved && <p className="text-note text-ok">已改，下次出题用这一版</p>}
      {flagged && !saved && <p className="text-note text-faint">标记了：可以直接改上面的中文，改完点保存。</p>}

      {item.n && <p className="text-note text-muted">{item.n}</p>}
      {de && <p className="text-ui text-muted">{de}</p>}
      {entry?.ex?.slice(0, 2).map((ex) => (
        <p key={ex} className="text-ui text-muted">
          {ex}
        </p>
      ))}

      {typeof ai === 'object' && (
        <p className="whitespace-pre-line border-l-2 border-line pl-3 text-ui text-muted">{ai.note}</p>
      )}
      {ai === 'loading' && <p className="text-note text-faint">AI 解析中…</p>}
      {ai === 'failed' && (
        <p className="text-note text-faint">
          AI 服务暂时不可用
          <button
            type="button"
            onClick={() => {
              askedRef.current = false;
              askAi();
            }}
            className="ml-2 rounded-box border border-line px-2 py-0.5 align-middle text-note text-muted active:scale-95"
          >
            重试
          </button>
        </p>
      )}
    </div>
  );
}
