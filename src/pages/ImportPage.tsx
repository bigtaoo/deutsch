// FR-1：课程导入（L3 手动路径）。
//
// 这是 FR-13 三层降级里的**地板**：DW 改版会打掉 L1/L2，教材音频根本没有 feed。
// 所以这个页面永远不能依赖 sources/ 里的任何代码 —— 粘贴文本 + 选本地文件，
// 全程只用浏览器自带能力。

import { useMemo, useState } from 'react';
import { useLessonStore } from '@/state/useLessonStore';
import { readAudioDuration } from '@/audio/player';
import { concatAudioFiles } from '@/audio/concat';
import { segmentSentences } from '@/lesson/segment';
import { unwrapPdfText } from '@/lesson/pdfText';
import { detectSpeakers, type SpeakerCandidate } from '@/lesson/speakers';
import { sortByName } from '@/lesson/bookImport';
import { href, navigate } from '@/app/router';
import { useAlignStore } from '@/state/useAlignStore';
import { SpeakerPicker, defaultSpeakers } from '@/components/SpeakerPicker';
import { Banner, Button, FilePicker, Hint, Section, field, formatBytes, formatTime } from '@/components/ui';

/** 已有的分组名，给输入框当候选（FR-1.9）。 */
export function useCollections(): string[] {
  const lessons = useLessonStore((s) => s.lessons);
  return useMemo(
    () => [...new Set(lessons.map((l) => l.collection).filter((c): c is string => Boolean(c)))].sort(),
    [lessons],
  );
}

export function ImportPage() {
  const createLesson = useLessonStore((s) => s.createLesson);
  const enqueueAlign = useAlignStore((s) => s.enqueue);
  const collections = useCollections();
  const [title, setTitle] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [collection, setCollection] = useState('');
  const [text, setText] = useState('');
  // FR-1.8：可以一次选好几轨，按文件名顺序拼成一个音频。
  const [audio, setAudio] = useState<{ files: File[]; duration: number } | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 保存失败单独一条：拼接和落库出错都和「这个音频文件读不出来」不是一回事
  const [saveError, setSaveError] = useState<string | null>(null);

  // 20000 字符以上不能卡（FR-1.2）：切句预览只在失焦后算一次，不跟着每次按键跑。
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  // FR-1.7：说话人候选同样只在失焦（或整理完断行）时算一次。
  const [candidates, setCandidates] = useState<SpeakerCandidate[]>([]);
  const [speakers, setSpeakers] = useState<string[]>([]);

  const analyse = (value: string, keepSelection = false) => {
    if (!value.trim()) {
      setPreviewCount(null);
      setCandidates([]);
      return;
    }
    const found = detectSpeakers(value);
    setCandidates(found);
    const chosen = keepSelection ? speakers : defaultSpeakers(found);
    if (!keepSelection) setSpeakers(chosen);
    setPreviewCount(segmentSentences(value, { speakers: chosen }).length);
  };

  const pickAudio = async (picked: File[]) => {
    setAudioError(null);
    if (picked.length === 0) return setAudio(null);
    const files = sortByName(picked);
    try {
      let duration = 0;
      for (const f of files) duration += await readAudioDuration(f);
      setAudio({ files, duration });
    } catch (err) {
      setAudio(null);
      setAudioError(err instanceof Error ? err.message : String(err));
    }
  };

  const canSave = title.trim().length > 0 && text.trim().length > 0 && !busy;

  const save = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      const joined = audio ? await concatAudioFiles(audio.files) : undefined;
      const id = await createLesson({
        title: title.trim(),
        sourceUrl: sourceUrl.trim() || undefined,
        plainText: text,
        audioFile: joined?.file,
        audioFiles: audio && audio.files.length > 1 ? audio.files.map((f) => f.name) : undefined,
        collection: collection.trim() || undefined,
        speakers,
      });
      // 手动导入和 DW 导入一视同仁：选了音频就立刻自动对齐（FR-15）。
      if (joined) enqueueAlign(id);
      navigate({ name: 'lesson', lessonId: id, tab: 'sentences' });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-title font-semibold">导入课程</h1>
      <p className="text-note text-muted">
        手上是一整份教材文稿？<a className="text-accent underline" href={href({ name: 'import-book' })}>按题目一次导入多课</a>
      </p>

      <Section title="基本信息">
        <label className="block space-y-1">
          <span className="text-ui text-muted">标题（必填）</span>
          <input
            className={`${field} w-full px-3 py-2`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Alltagsdeutsch: Der deutsche Wald"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-ui text-muted">来源 URL（选填）</span>
          <input
            className={`${field} w-full px-3 py-2`}
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://learngerman.dw.com/de/..."
          />
        </label>
        <label className="block space-y-1">
          <span className="text-ui text-muted">归到哪一组（选填）</span>
          <input
            className={`${field} w-full px-3 py-2`}
            value={collection}
            list="import-collections"
            onChange={(e) => setCollection(e.target.value)}
            placeholder="Aspekte neu C1"
          />
          <datalist id="import-collections">
            {collections.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
      </Section>

      <Section
        title="Manuskript"
        aside={
          previewCount !== null ? (
            <span className="text-ui text-muted">自动切分约 {previewCount} 句</span>
          ) : null
        }
      >
        <textarea
          className={`${field} h-72 w-full p-3 font-mono leading-relaxed`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => analyse(text)}
          placeholder="把 Manuskript 粘贴到这里…"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!text.trim()}
            onClick={() => {
              const next = unwrapPdfText(text);
              setText(next);
              analyse(next);
            }}
          >
            整理 PDF 断行
          </Button>
          <Hint>从 PDF 复制来的文字每行都断开了，点一下合回段落、去掉页码。</Hint>
        </div>
        <SpeakerPicker
          candidates={candidates}
          selected={speakers}
          onChange={(next) => {
            setSpeakers(next);
            setPreviewCount(segmentSentences(text, { speakers: next }).length);
          }}
        />
        <Hint>{text.length} 字符。切句结果保存后还能逐句合并、拆分，不必现在就完美。</Hint>
      </Section>

      <Section title="音频（选填）">
        <FilePicker accept="audio/*" onPickMany={(files) => void pickAudio(files)}>
          选音频文件…
        </FilePicker>
        {audio && (
          <Hint tone="ok">
            {audio.files.length === 1
              ? `${audio.files[0].name} · ${formatBytes(audio.files[0].size)}`
              : `${audio.files.length} 轨按这个顺序拼起来：${audio.files.map((f) => f.name).join('、')}`}
            {' · '}时长 {formatTime(audio.duration, 0)}
          </Hint>
        )}
        {audioError && (
          <Banner tone="danger" title="这个音频文件读不出来">
            <p>{audioError}</p>
          </Banner>
        )}
        {!audio && !audioError && <Hint>没有音频也能先保存课程，之后回来补上。一题跨好几轨就一起选上。</Hint>}
      </Section>

      {saveError && (
        <Banner tone="danger" title="没保存上">
          <p>{saveError}</p>
        </Banner>
      )}

      <div className="flex gap-2">
        <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
          {busy ? '保存中…' : '保存并去切句'}
        </Button>
        <Button onClick={() => navigate({ name: 'lessons' })}>取消</Button>
      </div>
    </div>
  );
}
