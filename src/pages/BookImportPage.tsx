// FR-1.8：整份教材文稿一次导入多课，一课 = 一个 Aufgabe。
//
// 形状（§12.18）：粘文稿 → 自动整理断行、按题目标题切段 → 按章勾要导的题 →
// 一次选这几题的全部音频，按文件名顺序依次分给勾上的题，每题「用几轨」可以调 →
// 导入。音轨号在文稿里已经丢了位置（印在页边，复制出来挤到页尾），
// 所以「哪几轨属于哪一题」只能由人在这一页上对一眼，这里不猜。
//
// FR-1.10：直接选 PDF 文件时音轨号有了位置（`pdfExtract.ts`），每题知道自己是哪几轨，
// 音频按文件名里的轨号配对，「轨」的 −/+ 换成每一轨一个开关（重放轨默认关掉）。
//
// 2026-09-27：选了音频就替人勾题 —— 要用的轨全在选的文件里、这一组里还没有的题自动勾上
// （sectionsWithFullAudio），不用再一章一章点；也可以直接选整个音频文件夹。
//
// 这一页和 ImportPage 一样是 FR-13 的地板：不碰 sources/ 里任何代码，只用浏览器自带能力。

import { useMemo, useState } from 'react';
import { useLessonStore } from '@/state/useLessonStore';
import { isEmptyShell } from '@/lesson/emptyShell';
import { useAlignStore } from '@/state/useAlignStore';
import { concatAudioFiles } from '@/audio/concat';
import { unwrapPdfText } from '@/lesson/pdfText';
import { segmentSentences } from '@/lesson/segment';
import { detectSpeakers } from '@/lesson/speakers';
import { extractPdfText } from '@/lesson/pdfExtract';
import {
  assignByTrackNumber,
  assignTracks,
  audioFilesOnly,
  sectionsWithFullAudio,
  parseBookSections,
  sectionTitle,
  sortByName,
  type BookSection,
} from '@/lesson/bookImport';
import { navigate } from '@/app/router';
import type { Lesson } from '@/types/models';
import { SpeakerPicker, defaultSpeakers } from '@/components/SpeakerPicker';
import { Banner, Button, FilePicker, Hint, Note, Section, field } from '@/components/ui';
import { useCollections } from './ImportPage';

interface Parsed {
  text: string;
  sections: BookSection[];
  /** 文稿里带了音轨号（从 PDF 文件读进来的）：按轨号配对，不按顺序数 */
  byTrack: boolean;
}

export function BookImportPage() {
  const createLesson = useLessonStore((s) => s.createLesson);
  const lessons = useLessonStore((s) => s.lessons);
  const caches = useLessonStore((s) => s.caches);
  const attachAudio = useLessonStore((s) => s.attachAudio);
  const patchLesson = useLessonStore((s) => s.patchLesson);
  const enqueueAlign = useAlignStore((s) => s.enqueue);
  const collections = useCollections();

  const [collection, setCollection] = useState('');
  const [raw, setRaw] = useState('');
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [tracks, setTracks] = useState<Map<number, number>>(new Map());
  /** 按轨号配对时，每题关掉的那几轨（默认是重放轨） */
  const [skipped, setSkipped] = useState<Map<number, Set<string>>>(new Map());
  const [files, setFiles] = useState<File[]>([]);
  const [pdfState, setPdfState] = useState<{ reading: boolean; error?: string }>({ reading: false });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 选音频之后替人勾了几题 —— 说一声，免得以为是自己点的 */
  const [autoChecked, setAutoChecked] = useState<number | null>(null);

  // 20000 字符以上不能卡（FR-1.2）：只在失焦时解析一次。
  const parse = (source = raw) => {
    if (!source.trim()) return setParsed(null);
    const text = unwrapPdfText(source);
    const sections = parseBookSections(text).filter((s) => s.body.length > 0);
    setParsed({ text, sections, byTrack: sections.some((s) => s.tracks.length > 0) });
    setSpeakers(defaultSpeakers(detectSpeakers(text)));
    setTracks(new Map(sections.map((s) => [s.id, s.suggestedTracks])));
    setSkipped(new Map(sections.map((s) => [s.id, new Set(s.replayTracks)])));
    setChecked(new Set());
  };

  const pickPdf = async (file: File | undefined) => {
    if (!file) return;
    setPdfState({ reading: true });
    try {
      const text = await extractPdfText(file);
      setRaw(text);
      parse(text);
      setPdfState({ reading: false });
    } catch (err) {
      setPdfState({ reading: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const candidates = useMemo(() => (parsed ? detectSpeakers(parsed.text) : []), [parsed]);

  const chapters = useMemo(() => {
    const out = new Map<string, BookSection[]>();
    for (const s of parsed?.sections ?? []) {
      const list = out.get(s.chapter) ?? [];
      list.push(s);
      out.set(s.chapter, list);
    }
    return [...out.entries()];
  }, [parsed]);

  const sentenceCounts = useMemo(
    () => new Map((parsed?.sections ?? []).map((s) => [s.id, segmentSentences(s.body, { speakers }).length])),
    [parsed, speakers],
  );

  /** 这一组里已经有同名的课 —— 标出来，免得同一题导两遍（同步之后两门课各自一套标注）。 */
  const existing = useMemo(() => {
    const name = collection.trim();
    return new Set(lessons.filter((l) => l.collection === name && !isEmptyShell(l, caches[l.id])).map((l) => l.title));
  }, [lessons, caches, collection]);
  /**
   * 同名但只是个空壳的课（2026-09-27：先不带音频导过一遍）：再导时把音频补进它，不另起一门。
   * 它不算「已经有了」—— 选了音频时照样替人勾上。
   */
  const shells = useMemo(() => {
    const name = collection.trim();
    const out = new Map<string, Lesson>();
    for (const l of lessons) {
      if (l.collection === name && isEmptyShell(l, caches[l.id]) && !out.has(l.title)) out.set(l.title, l);
    }
    return out;
  }, [lessons, caches, collection]);

  const selected = (parsed?.sections ?? []).filter((s) => checked.has(s.id));
  const byTrack = parsed?.byTrack ?? false;
  const usedTracks = (s: BookSection) => s.tracks.filter((t) => !skipped.get(s.id)?.has(t));
  const matched = byTrack
    ? assignByTrackNumber(
        selected.map((s) => ({ id: s.id, tracks: usedTracks(s) })),
        files,
      )
    : { ...assignTracks(selected.map((s) => ({ id: s.id, tracks: tracks.get(s.id) ?? 1 })), files), missing: new Map<number, string[]>() };
  const { assigned, leftover, missing } = matched;
  const tracksWanted = selected.reduce((n, s) => n + (tracks.get(s.id) ?? 1), 0);
  const missingCount = [...missing.values()].reduce((n, l) => n + l.length, 0);

  const fullAudioIds = (picked: readonly File[]) =>
    sectionsWithFullAudio(
      (parsed?.sections ?? []).map((s) => ({ id: s.id, tracks: usedTracks(s) })),
      picked,
      (id) => {
        const section = parsed?.sections.find((s) => s.id === id);
        return section ? existing.has(sectionTitle(section)) : false;
      },
    );

  /** 选了音频：按轨号配对时，还一题没勾就替人把音频齐全的题全勾上；已经勾过的不动。 */
  const pickAudio = (picked: File[]) => {
    const audio = sortByName(audioFilesOnly(picked));
    setFiles(audio);
    if (byTrack && checked.size === 0 && audio.length > 0) {
      const ids = fullAudioIds(audio);
      setChecked(new Set(ids));
      setAutoChecked(ids.length);
    } else {
      setAutoChecked(null);
    }
  };

  const allIds = (parsed?.sections ?? []).map((s) => s.id);
  const allChecked = allIds.length > 0 && allIds.every((id) => checked.has(id));

  const toggleTrack = (id: number, track: string) => {
    const next = new Map(skipped);
    const set = new Set(next.get(id));
    if (set.has(track)) set.delete(track);
    else set.add(track);
    next.set(id, set);
    setSkipped(next);
  };

  const toggle = (ids: number[], on: boolean) => {
    const next = new Set(checked);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setChecked(next);
  };

  const setTrackCount = (id: number, n: number) => {
    const next = new Map(tracks);
    next.set(id, Math.max(1, Math.min(40, n)));
    setTracks(next);
  };

  const canSave = collection.trim().length > 0 && selected.length > 0 && progress === null;

  const save = async () => {
    setError(null);
    setProgress({ done: 0, total: selected.length });
    try {
      for (const [i, section] of selected.entries()) {
        const audioFiles = assigned.get(section.id) ?? [];
        const joined = audioFiles.length > 0 ? await concatAudioFiles(audioFiles) : undefined;
        const shell = shells.get(sectionTitle(section));
        if (shell) {
          // 空壳在：有音频就补进去，没音频就什么都不做（再建一门同样的空壳只是重复）
          if (joined) {
            await attachAudio(shell.id, joined.file);
            await patchLesson(shell.id, (l) => ({
              ...l,
              source: {
                type: 'manual',
                audioFileName: audioFiles[0].name,
                ...(audioFiles.length > 1 ? { audioFiles: audioFiles.map((f) => f.name) } : {}),
              },
            }));
            enqueueAlign(shell.id);
          }
          setProgress({ done: i + 1, total: selected.length });
          continue;
        }
        const id = await createLesson({
          title: sectionTitle(section),
          plainText: section.body,
          audioFile: joined?.file,
          audioFiles: audioFiles.length > 1 ? audioFiles.map((f) => f.name) : undefined,
          collection: collection.trim(),
          speakers,
        });
        if (joined) enqueueAlign(id); // 对齐是串行排队的，一次导十课不会同时跑十个
        setProgress({ done: i + 1, total: selected.length });
      }
      navigate({ name: 'lessons' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress(null);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-title font-semibold">导入整本教材</h1>

      <Section title="分组">
        <label className="block space-y-1">
          <span className="text-ui text-muted">教材名（必填，课程列表按它分组）</span>
          <input
            className={`${field} w-full px-3 py-2`}
            value={collection}
            list="book-collections"
            onChange={(e) => setCollection(e.target.value)}
            placeholder="Aspekte neu C1"
          />
          <datalist id="book-collections">
            {collections.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
      </Section>

      <Section
        title="文稿"
        aside={
          parsed ? (
            <span className="tnum text-ui text-muted">
              {chapters.length} 章 · {parsed.sections.length} 题
            </span>
          ) : null
        }
      >
        <textarea
          className={`${field} h-56 w-full p-3 font-mono leading-relaxed`}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onBlur={() => parse()}
          placeholder="把整份 Transkript 粘贴到这里…"
        />
        <div className="flex flex-wrap items-center gap-2">
          <FilePicker accept="application/pdf,.pdf" onPick={(f) => void pickPdf(f)}>
            {pdfState.reading ? '正在读 PDF…' : '直接选 PDF 文件…'}
          </FilePicker>
          <span className="text-note text-muted">推荐：音轨号从页边读出来，音频按轨号自动配对</span>
        </div>
        {pdfState.error && (
          <Banner tone="warn" title="PDF 读不出来">
            <p>{pdfState.error}。可以在 PDF 阅读器里全选复制，粘贴到上面。</p>
          </Banner>
        )}
        <Hint>
          也可以从 PDF 里全选复制粘贴：断行、页码、页边的音轨号会自动整理掉，按「Modul 4 Aufgabe 2c」这类标题切成一题一课
          —— 只是这样音轨号的位置就丢了，每题几轨要自己对。
        </Hint>
        {parsed && parsed.sections.length === 0 && (
          <Banner tone="warn" title="没认出题目标题">
            <p>这一页按「Kapitel 1 …」「Modul 2 Aufgabe 3a」「Track 1.05」这类单独一行的标题切分。没有这种标题的文稿请用单课导入。</p>
          </Banner>
        )}
        {parsed && <SpeakerPicker candidates={candidates} selected={speakers} onChange={setSpeakers} />}
      </Section>

      {parsed && parsed.sections.length > 0 && (
        <Section
          title="选题与音频"
          aside={
            <span className="flex flex-wrap gap-2">
              <FilePicker accept="audio/*" onPickMany={pickAudio}>
                {files.length > 0 ? `换音频（已选 ${files.length} 个）` : '选音频文件…'}
              </FilePicker>
              <FilePicker accept="audio/*" directory onPickMany={pickAudio}>
                选整个文件夹…
              </FilePicker>
            </span>
          }
        >
          {byTrack ? (
            <Hint>
              直接选音频（两个音频包的 mp3 可以一起全选，或者选整个文件夹）：按文件名里的轨号配给各题，
              还没勾题的话，音频齐全、这一组里还没有的题会自动勾上，缺轨的留着不勾。练习册的音轨用不上会自动剩下。
              每题下面是它的轨号，点一下关掉 / 打开那一轨。
            </Hint>
          ) : (
            <Hint>勾上要导的题，再一次选好它们的全部音轨：按文件名顺序依次分给勾上的题。一题跨几轨就把「轨」调成几。</Hint>
          )}

          {autoChecked !== null && (
            <Note>
              按选的音频勾上了 {autoChecked} 题（要用的轨都在、这一组里还没有）
              {autoChecked < allIds.length ? `，另外 ${allIds.length - autoChecked} 题没勾：缺轨或已经导过` : ''}。
            </Note>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex min-h-11 items-center gap-2 font-medium">
              <input type="checkbox" checked={allChecked} onChange={(e) => toggle(allIds, e.target.checked)} />
              全部 {allIds.length} 题
            </label>
            {byTrack && files.length > 0 && (
              <Button
                variant="ghost"
                onClick={() => {
                  const ids = fullAudioIds(files);
                  setChecked(new Set(ids));
                  setAutoChecked(ids.length);
                }}
              >
                只勾音频齐全的
              </Button>
            )}
          </div>

          {chapters.map(([chapter, sections]) => {
            const ids = sections.map((s) => s.id);
            const all = ids.every((id) => checked.has(id));
            return (
              <div key={chapter || '—'} className="space-y-1">
                <label className="flex min-h-11 items-center gap-2 font-medium">
                  <input type="checkbox" checked={all} onChange={(e) => toggle(ids, e.target.checked)} />
                  {chapter || '（章节之前）'}
                </label>
                <ul className="divide-y divide-line rounded-box border border-line">
                  {sections.map((section) => {
                    const on = checked.has(section.id);
                    const got = assigned.get(section.id) ?? [];
                    const n = tracks.get(section.id) ?? 1;
                    return (
                      <li key={section.id} className="space-y-1 px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 sm:min-h-0">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={(e) => toggle([section.id], e.target.checked)}
                            />
                            <span className="truncate">{section.heading}</span>
                            <span className="tnum shrink-0 text-note text-faint">{sentenceCounts.get(section.id)} 句</span>
                          </label>
                          {on && !byTrack && (
                            <span className="flex items-center gap-1">
                              <Button variant="ghost" aria-label="少一轨" onClick={() => setTrackCount(section.id, n - 1)}>
                                −
                              </Button>
                              <span className="tnum w-12 text-center text-ui">{n} 轨</span>
                              <Button variant="ghost" aria-label="多一轨" onClick={() => setTrackCount(section.id, n + 1)}>
                                +
                              </Button>
                            </span>
                          )}
                        </div>
                        {existing.has(sectionTitle(section)) && <Note tone="warn">这一组里已经有这一课了，再导一遍会是两门课。</Note>}
                        {shells.has(sectionTitle(section)) && <Note>这一组里有这一课但还没有音频：导入会把音频补进那一课，不另起一门。</Note>}
                        {on && byTrack && section.tracks.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {section.tracks.map((t) => {
                              const off = skipped.get(section.id)?.has(t) ?? false;
                              return (
                                <button
                                  key={t}
                                  type="button"
                                  aria-pressed={!off}
                                  aria-label={`音轨 ${t}`}
                                  onClick={() => toggleTrack(section.id, t)}
                                  className={`tnum rounded-ctl border px-2 py-0.5 text-note ${
                                    off ? 'border-line text-faint line-through' : 'border-accent text-accent'
                                  }`}
                                >
                                  {t}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {on && byTrack && section.replayTracks.length > 0 && (
                          <Note>
                            {section.replayTracks.join('、')} 是把后面几轨连起来先放一遍（文稿只印了一次），默认不用，免得同一段话拼进去两次。
                          </Note>
                        )}
                        {section.references.length > 0 && <Note>{section.references.join(' ')}</Note>}
                        {on && byTrack && files.length > 0 && (
                          <p className="text-note break-all text-muted">
                            {got.map((f) => f.name).join('、')}
                            {(missing.get(section.id)?.length ?? 0) > 0 && (
                              <span className="text-warn">
                                {got.length > 0 ? '；' : ''}选的文件里没有 {missing.get(section.id)!.join('、')}
                              </span>
                            )}
                            {got.length === 0 && (missing.get(section.id)?.length ?? 0) === 0 && '没有要用的轨，可以之后再补音频'}
                          </p>
                        )}
                        {on && !byTrack && files.length > 0 && (
                          <p className="text-note break-all text-muted">
                            {got.length === 0 ? '分不到音频（文件不够），可以之后再补' : got.map((f) => f.name).join('、')}
                            {got.length > 0 && got.length < n ? `（还差 ${n - got.length} 轨）` : ''}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}

          {byTrack && selected.length > 0 && files.length > 0 && (missingCount > 0 || leftover.length > 0) && (
            <Note tone={missingCount > 0 ? 'warn' : 'neutral'}>
              {missingCount > 0 ? `有 ${missingCount} 轨在选的文件里找不到，那几题可以先导、之后再补音频。` : ''}
              {leftover.length > 0 ? `${leftover.length} 个文件没配上任何一题（练习册的音轨、没勾的题），不会用到。` : ''}
            </Note>
          )}
          {!byTrack && selected.length > 0 && files.length > 0 && tracksWanted !== files.length && (
            <Note tone="warn">
              勾上的题一共要 {tracksWanted} 轨，选了 {files.length} 个文件
              {leftover.length > 0 ? `，多出来的 ${leftover.length} 个不会用到` : ''}。对一下每题的轨数。
            </Note>
          )}
        </Section>
      )}

      {error && (
        <Banner tone="danger" title="导入中断了">
          <p>{error}。已经导进去的几课留着，没导的可以再勾一次。</p>
        </Banner>
      )}

      <div className="flex gap-2">
        <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
          {progress ? `正在导入 ${progress.done}/${progress.total}…` : `导入 ${selected.length} 课`}
        </Button>
        <Button onClick={() => navigate({ name: 'lessons' })}>取消</Button>
      </div>
    </div>
  );
}
