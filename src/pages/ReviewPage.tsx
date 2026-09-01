// FR-10 SRS 复习 —— 手机上的主界面。
//
// 卡片正面放**句子音频**（自动播放一次）+ 挖空后的原句。
// 音频里包含答案是设计意图（FR-10.2）：要训练的是「听到 /ˈtsuːfɐˌzɪçt/ 反应过来是 Zuversicht」，
// 不是遮蔽听觉线索。遮掉音频就把这张卡退化成了看图识字。

import { useEffect, useMemo, useState } from 'react';
import { navigate } from '@/app/router';
import { audioPlayer } from '@/audio/player';
import { getAudioBlob } from '@/db/cache';
import { resolveRange } from '@/lesson/timing';
import { toClozeSegments } from '@/lesson/tokens';
import { buildReviewQueue, cardAudioStatus } from '@/srs/queue';
import { formatInterval, previewIntervals, review, type ReviewRating } from '@/srs/fsrs';
import { backupVocabNow } from '@/github/backupTrigger';
import { useLessonStore } from '@/state/useLessonStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useVocabStore } from '@/state/useVocabStore';
import { Banner, Button, EmptyState } from '@/components/ui';
import type { Lesson, VocabEntry } from '@/types/models';

const RATINGS: Array<{ key: ReviewRating; label: string; hotkey: string; className: string }> = [
  { key: 'again', label: '忘了', hotkey: '1', className: 'bg-red-600 text-white' },
  { key: 'hard', label: '勉强', hotkey: '2', className: 'bg-amber-500 text-white' },
  { key: 'good', label: '记得', hotkey: '3', className: 'bg-emerald-600 text-white' },
  { key: 'easy', label: '太简单', hotkey: '4', className: 'bg-sky-600 text-white' },
];

export function ReviewPage() {
  const { entries, updateEntry, loaded } = useVocabStore();
  const { lessons, caches } = useLessonStore();
  const { settings } = useSettingsStore();

  // 队列在进入页面时算一次并冻结：随着评分实时重算会让卡片在手底下跳来跳去。
  const [session, setSession] = useState<VocabEntry[] | null>(null);
  const [position, setPosition] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [finished, setFinished] = useState(false);

  const breakdown = useMemo(
    () => buildReviewQueue(entries, { newPerDay: settings.newPerDay, reviewPerDay: settings.reviewPerDay }),
    // entries 每次评分都会变，但 session 一旦建立就不再看它
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded],
  );

  useEffect(() => {
    if (loaded && session === null) setSession(breakdown.queue);
  }, [loaded, session, breakdown.queue]);

  const queue = session ?? [];
  const entry = queue[position];
  // 评分会改 entries，卡面要用最新的那一份
  const current = entry ? (entries.find((e) => e.id === entry.id) ?? entry) : undefined;
  const lesson = current ? lessons.find((l) => l.id === current.lessonId) : undefined;

  const grade = async (rating: ReviewRating) => {
    if (!current) return;
    await updateEntry({ ...current, fsrs: review(current.fsrs, rating) });
    if (position + 1 < queue.length) {
      setPosition(position + 1);
      setRevealed(false);
    } else {
      setFinished(true);
      // FR-11.6：每次复习会话结束就推 vocab.json —— 不可重建的数据不过夜。
      void backupVocabNow();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!current) return;
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); setRevealed(true); return; }
      const rating = RATINGS.find((r) => r.hotkey === e.key);
      if (revealed && rating) { e.preventDefault(); void grade(rating.key); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!loaded) return <EmptyState>加载中…</EmptyState>;

  if (finished || (session !== null && queue.length === 0)) {
    return (
      <EmptyState>
        <p className="text-base">{finished ? '这一轮做完了。' : '今天没有到期的卡片。'}</p>
        {breakdown.nextDueAt && (
          <p className="mt-2">下一张卡 {new Date(breakdown.nextDueAt).toLocaleString('zh-CN', { hour12: false })} 到期。</p>
        )}
        <div className="mt-4 flex justify-center gap-2">
          <Button onClick={() => navigate({ name: 'lessons' })}>回到课程</Button>
          <Button onClick={() => navigate({ name: 'vocab' })}>看生词本</Button>
        </div>
      </EmptyState>
    );
  }

  if (!current) return <EmptyState>加载中…</EmptyState>;

  return (
    <div className="mx-auto flex min-h-[80vh] max-w-2xl flex-col gap-4">
      <p className="text-sm text-neutral-500">
        {position + 1} / {queue.length} · 新卡 {breakdown.newCount} · 复习 {breakdown.reviewCount}
      </p>

      <CardFace entry={current} lesson={lesson} hasMaterial={Boolean(caches[current.lessonId]?.hasAudio)} revealed={revealed} />

      {/* FR-10.7：手机端按钮在拇指可达区 —— 评分区固定在底部，不跟着卡片长度浮动 */}
      <div className="mt-auto space-y-2">
        {!revealed ? (
          <Button variant="primary" className="w-full py-4 text-base" onClick={() => setRevealed(true)}>
            显示答案 (Space)
          </Button>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {RATINGS.map((rating) => {
              const due = previewIntervals(current.fsrs)[rating.key];
              return (
                <button
                  key={rating.key}
                  onClick={() => void grade(rating.key)}
                  className={`rounded-lg py-4 text-sm ${rating.className}`}
                >
                  <span className="block font-medium">{rating.label}</span>
                  <span className="block text-xs opacity-80">{formatInterval(due)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function CardFace({
  entry,
  lesson,
  hasMaterial,
  revealed,
}: {
  entry: VocabEntry;
  lesson: Lesson | undefined;
  hasMaterial: boolean;
  revealed: boolean;
}) {
  const audioStatus = cardAudioStatus(entry, hasMaterial);
  const sentence = lesson?.sentences[entry.sentenceIndex];
  const range = sentence && lesson ? resolveRange(lesson.sentences, sentence.index, lesson.audioDuration) : null;

  const [playable, setPlayable] = useState(false);

  // 正面自动播一次（FR-10.2）。每张卡都要重新 load —— 相邻两张卡多半来自不同课程。
  useEffect(() => {
    let cancelled = false;
    setPlayable(false);
    if (audioStatus !== 'ok' || !range || !lesson) return;
    void (async () => {
      const blob = await getAudioBlob(lesson.id);
      if (!blob || cancelled) return;
      await audioPlayer.load(lesson.id, blob);
      if (cancelled) return;
      setPlayable(true);
      void audioPlayer.playRange(range.start, range.end).catch(() => {
        // iOS 上没有手势链时会被拒绝：留着「重播」按钮让用户点一下即可。
      });
    })();
    return () => { cancelled = true; audioPlayer.pause(); };
  }, [entry.id, audioStatus, lesson?.id, range?.start, range?.end]);

  const clozeText = useMemo(() => {
    if (!sentence) return entry.contextSentence;
    const blank = sentence.blanks.find((b) => b.vocabEntryId === entry.id);
    if (!blank) return sentence.text;
    return toClozeSegments(sentence.text, [blank.ranges])
      .map((s) => (s.type === 'blank' ? '_'.repeat(Math.max(3, s.text.length)) : s.text))
      .join('');
  }, [sentence, entry]);

  return (
    <div className="space-y-4 rounded-lg border border-neutral-200 p-6">
      {audioStatus === 'ok' ? (
        <Button disabled={!playable} onClick={() => range && void audioPlayer.playRange(range.start, range.end)}>
          ▶ 重播句子
        </Button>
      ) : (
        // FR-10.5：两种无音频原因给不同出口，绝不静默降级成纯文本卡
        <Banner tone="warn">
          {audioStatus === 'no-timestamp' ? (
            <>
              <p>这张卡没有音频：来源句还没有时间戳（自动对齐没覆盖到它）。</p>
              {lesson && (
                <Button
                  className="mt-2"
                  onClick={() => navigate({ name: 'lesson', lessonId: lesson.id, tab: 'sentences' })}
                >
                  去这一课重新对齐
                </Button>
              )}
            </>
          ) : (
            <>
              <p>这张卡没有音频：本机没有《{lesson?.title ?? '这一课'}》的素材。一键可解。</p>
              <Button className="mt-2" onClick={() => navigate({ name: 'sources' })}>
                去下载素材
              </Button>
            </>
          )}
        </Banner>
      )}

      <p className="text-lg leading-loose">{clozeText}</p>

      {revealed && (
        <div className="space-y-2 border-t border-neutral-200 pt-4">
          <p className="text-2xl font-semibold">
            {entry.gender && <span className="mr-2 text-neutral-500">{{ m: 'der', f: 'die', n: 'das' }[entry.gender]}</span>}
            {entry.lemma ?? entry.surface}
            {entry.plural && <span className="ml-2 text-base text-neutral-500">{entry.plural}</span>}
          </p>
          <p className="text-base">{entry.meaning ?? <span className="text-neutral-400">（释义还没填）</span>}</p>
          <p className="text-sm text-neutral-500">{sentence?.text ?? entry.contextSentence}</p>
          {lesson && <p className="text-xs text-neutral-400">出自《{lesson.title}》</p>}
        </div>
      )}
    </div>
  );
}
