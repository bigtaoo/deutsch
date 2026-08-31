// FR-1：课程导入（L3 手动路径）。
//
// 这是 FR-13 三层降级里的**地板**：DW 改版会打掉 L1/L2，教材音频根本没有 feed。
// 所以这个页面永远不能依赖 sources/ 里的任何代码 —— 粘贴文本 + 选本地文件，
// 全程只用浏览器自带能力。

import { useState } from 'react';
import { useLessonStore } from '@/state/useLessonStore';
import { readAudioDuration } from '@/audio/player';
import { segmentSentences } from '@/lesson/segment';
import { navigate } from '@/app/router';
import { Banner, Button, Hint, Section, formatBytes, formatTime } from '@/components/ui';

export function ImportPage() {
  const createLesson = useLessonStore((s) => s.createLesson);
  const [title, setTitle] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [text, setText] = useState('');
  const [audio, setAudio] = useState<{ file: File; duration: number } | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 20000 字符以上不能卡（FR-1.2）：切句预览只在失焦后算一次，不跟着每次按键跑。
  const [previewCount, setPreviewCount] = useState<number | null>(null);

  const pickAudio = async (file: File | undefined) => {
    setAudioError(null);
    if (!file) return setAudio(null);
    try {
      setAudio({ file, duration: await readAudioDuration(file) });
    } catch (err) {
      setAudio(null);
      setAudioError(err instanceof Error ? err.message : String(err));
    }
  };

  const canSave = title.trim().length > 0 && text.trim().length > 0 && !busy;

  const save = async () => {
    setBusy(true);
    try {
      const id = await createLesson({
        title: title.trim(),
        sourceUrl: sourceUrl.trim() || undefined,
        plainText: text,
        audioFile: audio?.file,
      });
      navigate({ name: 'lesson', lessonId: id, tab: 'sentences' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">导入课程</h1>

      <Section title="基本信息">
        <label className="block space-y-1">
          <span className="text-sm text-neutral-600">标题（必填）</span>
          <input
            className="w-full rounded border border-neutral-300 px-3 py-2"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Alltagsdeutsch: Der deutsche Wald"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-neutral-600">来源 URL（选填）</span>
          <input
            className="w-full rounded border border-neutral-300 px-3 py-2"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://learngerman.dw.com/de/..."
          />
        </label>
      </Section>

      <Section
        title="Manuskript"
        aside={
          previewCount !== null ? (
            <span className="text-sm text-neutral-500">自动切分约 {previewCount} 句</span>
          ) : null
        }
      >
        <textarea
          className="h-72 w-full rounded border border-neutral-300 p-3 font-mono text-sm leading-relaxed"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => setPreviewCount(text.trim() ? segmentSentences(text).length : null)}
          placeholder="把 Manuskript 粘贴到这里…"
        />
        <Hint>{text.length} 字符。切句结果保存后还能逐句合并/拆分（FR-2.3），不必现在就完美。</Hint>
      </Section>

      <Section title="音频（选填，可后补）">
        <input
          type="file"
          accept="audio/*"
          className="text-sm"
          onChange={(e) => void pickAudio(e.target.files?.[0])}
        />
        {audio && (
          <Hint tone="ok">
            {audio.file.name} · {formatBytes(audio.file.size)} · 时长 {formatTime(audio.duration, 0)}
          </Hint>
        )}
        {audioError && <Banner tone="error">{audioError}</Banner>}
        {!audio && !audioError && <Hint>没有音频也能先保存课程，之后在「素材」里补上。</Hint>}
      </Section>

      <div className="flex gap-2">
        <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
          {busy ? '保存中…' : '保存并去切句'}
        </Button>
        <Button onClick={() => navigate({ name: 'lessons' })}>取消</Button>
      </div>
    </div>
  );
}
