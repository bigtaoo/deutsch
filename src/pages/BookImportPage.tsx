// FR-1.8：整份教材文稿一次导入多课，一课 = 一个 Aufgabe。
//
// 形状（§12.18）：粘文稿 → 自动整理断行、按题目标题切段 → 按章勾要导的题 →
// 一次选这几题的全部音频，按文件名顺序依次分给勾上的题，每题「用几轨」可以调 →
// 导入。音轨号在文稿里已经丢了位置（印在页边，复制出来挤到页尾），
// 所以「哪几轨属于哪一题」只能由人在这一页上对一眼，这里不猜。
//
// 这一页和 ImportPage 一样是 FR-13 的地板：不碰 sources/ 里任何代码，只用浏览器自带能力。

import { useMemo, useState } from 'react';
import { useLessonStore } from '@/state/useLessonStore';
import { useAlignStore } from '@/state/useAlignStore';
import { concatAudioFiles } from '@/audio/concat';
import { unwrapPdfText } from '@/lesson/pdfText';
import { segmentSentences } from '@/lesson/segment';
import { detectSpeakers } from '@/lesson/speakers';
import { assignTracks, parseBookSections, sectionTitle, sortByName, type BookSection } from '@/lesson/bookImport';
import { navigate } from '@/app/router';
import { SpeakerPicker, defaultSpeakers } from '@/components/SpeakerPicker';
import { Banner, Button, FilePicker, Hint, Note, Section, field } from '@/components/ui';
import { useCollections } from './ImportPage';

interface Parsed {
  text: string;
  sections: BookSection[];
}

export function BookImportPage() {
  const createLesson = useLessonStore((s) => s.createLesson);
  const lessons = useLessonStore((s) => s.lessons);
  const enqueueAlign = useAlignStore((s) => s.enqueue);
  const collections = useCollections();

  const [collection, setCollection] = useState('');
  const [raw, setRaw] = useState('');
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [tracks, setTracks] = useState<Map<number, number>>(new Map());
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 20000 字符以上不能卡（FR-1.2）：只在失焦时解析一次。
  const parse = () => {
    if (!raw.trim()) return setParsed(null);
    const text = unwrapPdfText(raw);
    const sections = parseBookSections(text).filter((s) => s.body.length > 0);
    setParsed({ text, sections });
    setSpeakers(defaultSpeakers(detectSpeakers(text)));
    setTracks(new Map(sections.map((s) => [s.id, s.suggestedTracks])));
    setChecked(new Set());
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
    return new Set(lessons.filter((l) => l.collection === name).map((l) => l.title));
  }, [lessons, collection]);

  const selected = (parsed?.sections ?? []).filter((s) => checked.has(s.id));
  const { assigned, leftover } = assignTracks(
    selected.map((s) => ({ id: s.id, tracks: tracks.get(s.id) ?? 1 })),
    files,
  );
  const tracksWanted = selected.reduce((n, s) => n + (tracks.get(s.id) ?? 1), 0);

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
          onBlur={parse}
          placeholder="把整份 Transkript 粘贴到这里…"
        />
        <Hint>从 PDF 里全选复制即可：断行、页码、页边的音轨号会自动整理掉，按「Modul 4 Aufgabe 2c」这类标题切成一题一课。</Hint>
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
            <FilePicker accept="audio/*" onPickMany={(picked) => setFiles(sortByName(picked))}>
              {files.length > 0 ? `换音频（已选 ${files.length} 个）` : '选这几题的音频…'}
            </FilePicker>
          }
        >
          <Hint>勾上要导的题，再一次选好它们的全部音轨：按文件名顺序依次分给勾上的题。一题跨几轨就把「轨」调成几。</Hint>

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
                          {on && (
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
                        {section.references.length > 0 && <Note>{section.references.join(' ')}</Note>}
                        {on && files.length > 0 && (
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

          {selected.length > 0 && files.length > 0 && tracksWanted !== files.length && (
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
