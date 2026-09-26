// FR-1.6 ~ FR-1.9：单课导入页这次多出来的几样 —— 整理断行按钮、说话人勾选、分组名、多选音频按名拼。
// 老路径（一课一个 mp3）另有 e2e/lesson.spec.ts 守着，这里只补新分支。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLessonStore } from '@/state/useLessonStore';
import { useAlignStore } from '@/state/useAlignStore';

const navigate = vi.fn();
vi.mock('@/app/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/router')>()),
  navigate: (route: unknown) => navigate(route),
}));
const readAudioDuration = vi.fn(async (_f: File) => 60);
vi.mock('@/audio/player', () => ({ readAudioDuration: (f: File) => readAudioDuration(f) }));
const concatAudioFiles = vi.fn(async (files: File[]) => ({ file: new File([], 'joined.mp3'), method: 'bytes' as const, n: files.length }));
vi.mock('@/audio/concat', () => ({ concatAudioFiles: (files: File[]) => concatAudioFiles(files) }));

const { ImportPage } = await import('./ImportPage');

const createLesson = vi.fn(async (_input: unknown) => 'new-id');
const enqueue = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useLessonStore.setState({ lessons: [], caches: {}, createLesson } as never);
  useAlignStore.setState({ enqueue } as never);
});

const box = () => screen.getByPlaceholderText('把 Manuskript 粘贴到这里…') as HTMLTextAreaElement;

function fill(title: string, text: string) {
  fireEvent.change(screen.getByPlaceholderText('Alltagsdeutsch: Der deutsche Wald'), { target: { value: title } });
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.blur(box());
}

async function pickFiles(names: string[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: names.map((n) => new File([], n)), configurable: true });
  fireEvent.change(input);
  await waitFor(() => expect(readAudioDuration).toHaveBeenCalledTimes(names.length));
}

describe('ImportPage', () => {
  it('「整理 PDF 断行」没有文字时是灰的；点了之后文本框里就是整理过的样子', () => {
    render(<ImportPage />);
    const button = screen.getByRole('button', { name: '整理 PDF 断行' });
    expect(button).toBeDisabled();

    fireEvent.change(box(), { target: { value: 'Das Gemeinschafts-\nleben\n3\nist schön.' } });
    fireEvent.click(button);
    expect(box().value).toBe('Das Gemeinschaftsleben ist schön.');
  });

  it('有说话人标记才出现勾选；预览句数按勾选算', () => {
    render(<ImportPage />);
    fill('Dialog', 'Ein Satz.');
    expect(screen.queryByRole('checkbox')).toBeNull();

    fill('Dialog', '● Hallo. Wie geht’s?\n○ Gut.');
    expect(screen.getByRole('checkbox', { name: /●/ })).toBeChecked();
    expect(screen.getByText('自动切分约 3 句')).toBeInTheDocument();
  });

  it('多选几轨：按文件名排、时长加起来、保存时拼接并记下文件清单与分组', async () => {
    render(<ImportPage />);
    fill('Kapitel 1 · Modul 2 Aufgabe 2a', '● Hallo.');
    fireEvent.change(screen.getByPlaceholderText('Aspekte neu C1'), { target: { value: ' Aspekte neu C1 ' } });
    await pickFiles(['Track 10.mp3', 'Track 9.mp3']);

    expect(screen.getByText(/2 轨按这个顺序拼起来：Track 9\.mp3、Track 10\.mp3/)).toBeInTheDocument();
    expect(screen.getByText(/时长 2:00/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存并去切句' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ name: 'lesson', lessonId: 'new-id', tab: 'sentences' }));
    expect(concatAudioFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['Track 9.mp3', 'Track 10.mp3']);
    expect(createLesson.mock.calls[0][0]).toMatchObject({
      audioFiles: ['Track 9.mp3', 'Track 10.mp3'],
      collection: 'Aspekte neu C1',
      speakers: ['●'],
    });
    expect(enqueue).toHaveBeenCalledWith('new-id');
  });

  it('只选一个文件：不记 audioFiles，分组留空就不带分组', async () => {
    render(<ImportPage />);
    fill('Lektion', 'Ein Satz.');
    await pickFiles(['wald.mp3']);
    expect(screen.getByText(/^wald\.mp3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存并去切句' }));
    await waitFor(() => expect(createLesson).toHaveBeenCalled());
    expect(createLesson.mock.calls[0][0]).toMatchObject({ audioFiles: undefined, collection: undefined, speakers: [] });
  });

  it('没选音频：不拼、不排对齐', async () => {
    render(<ImportPage />);
    fill('Lektion', 'Ein Satz.');
    fireEvent.click(screen.getByRole('button', { name: '保存并去切句' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(concatAudioFiles).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('音频读不出来：音频那一块报错，不假装选上了', async () => {
    readAudioDuration.mockRejectedValueOnce(new Error('解码失败'));
    render(<ImportPage />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File([], 'kaputt.mp3')], configurable: true });
    fireEvent.change(input);
    expect(await screen.findByText('这个音频文件读不出来')).toBeInTheDocument();
    expect(screen.queryByText(/kaputt\.mp3 ·/)).toBeNull();
  });

  it('保存失败单独报「没保存上」，不冒充成音频读不出来；不跳走', async () => {
    createLesson.mockRejectedValueOnce(new Error('IndexedDB 满了'));
    render(<ImportPage />);
    fill('Lektion', 'Ein Satz.');
    fireEvent.click(screen.getByRole('button', { name: '保存并去切句' }));
    expect(await screen.findByText('没保存上')).toBeInTheDocument();
    expect(screen.getByText('IndexedDB 满了')).toBeInTheDocument();
    expect(screen.queryByText('这个音频文件读不出来')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('分组输入框拿已有组名做候选', () => {
    useLessonStore.setState({
      lessons: [
        { id: 'a', title: 'A', collection: 'Menschen B1', source: { type: 'manual' }, sentences: [], createdAt: 0, updatedAt: 0 },
        { id: 'b', title: 'B', collection: 'Aspekte neu C1', source: { type: 'manual' }, sentences: [], createdAt: 0, updatedAt: 0 },
        { id: 'c', title: 'C', source: { type: 'manual' }, sentences: [], createdAt: 0, updatedAt: 0 },
      ],
    });
    render(<ImportPage />);
    const options = [...document.querySelectorAll('#import-collections option')].map((o) => o.getAttribute('value'));
    expect(options).toEqual(['Aspekte neu C1', 'Menschen B1']);
  });
});
