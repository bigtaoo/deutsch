// FR-1.8：整本导入页。E2E（e2e/book.spec.ts）走的是一条顺利的路；这里补那些分支：
// 章的全选、轨数下限、文件不够/多了、同名课提示、认不出标题、中途失败、按钮什么时候能点。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useLessonStore } from '@/state/useLessonStore';
import { useAlignStore } from '@/state/useAlignStore';
import type { Lesson } from '@/types/models';

const navigate = vi.fn();
vi.mock('@/app/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/router')>()),
  navigate: (route: unknown) => navigate(route),
}));
const concatAudioFiles = vi.fn(async (files: File[]) => ({
  file: new File([], files.length > 1 ? `${files[0].name} +${files.length - 1}` : files[0].name),
  method: 'bytes' as const,
}));
vi.mock('@/audio/concat', () => ({ concatAudioFiles: (files: File[]) => concatAudioFiles(files) }));

const { BookImportPage } = await import('./BookImportPage');

const TRANSCRIPT = [
  'Kapitel 1 Alltägliches',
  'Modul 2 Aufgabe 2a',
  ' ●  Hallo, seid herzlich',
  'willkommen.',
  ' ○  Ja, genau.',
  'Modul 4 Aufgabe 2c',
  ' ●  Gibt es Regeln?',
  'Kapitel 2 Hast du Worte?',
  'Auftakt Aufgabe 2a',
  ' ●  Kennt ihr den?',
].join('\n');

const createLesson = vi.fn(async (_input: unknown) => `id-${createLesson.mock.calls.length}`);
const enqueue = vi.fn();

function existingLesson(title: string, collection: string): Lesson {
  return { id: title, title, collection, source: { type: 'manual' }, sentences: [], createdAt: 0, updatedAt: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  useLessonStore.setState({ lessons: [], caches: {}, createLesson } as never);
  useAlignStore.setState({ enqueue } as never);
});

function paste(text = TRANSCRIPT) {
  const box = screen.getByPlaceholderText('把整份 Transkript 粘贴到这里…');
  fireEvent.change(box, { target: { value: text } });
  fireEvent.blur(box);
}

function setCollection(name: string) {
  fireEvent.change(screen.getByPlaceholderText('Aspekte neu C1'), { target: { value: name } });
}

function pickFiles(names: string[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const files = names.map((n) => new File([], n));
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

const checkbox = (name: string | RegExp) => screen.getByRole('checkbox', { name });
const row = (heading: string) => screen.getByText(heading).closest('li')!;

describe('BookImportPage', () => {
  it('失焦才解析；解析完报章数与题数，说话人符号默认勾上', () => {
    render(<BookImportPage />);
    expect(screen.queryByText(/章 ·/)).toBeNull();
    paste();
    expect(screen.getByText('2 章 · 3 题')).toBeInTheDocument();
    expect(checkbox(/●/)).toBeChecked();
    expect(checkbox(/○/)).toBeChecked();
  });

  it('取消说话人勾选会原样带进保存 —— 不勾的标记留在正文里', () => {
    render(<BookImportPage />);
    paste();
    expect(within(row('Modul 2 Aufgabe 2a')).getByText('2 句')).toBeInTheDocument();
    fireEvent.click(checkbox(/●/));
    fireEvent.click(checkbox(/○/));
    setCollection('Aspekte neu C1');
    fireEvent.click(checkbox('Kapitel 1 Alltägliches'));
    fireEvent.click(screen.getByRole('button', { name: '导入 2 课' }));
    return waitFor(() => expect(createLesson).toHaveBeenCalledWith(expect.objectContaining({ speakers: [] })));
  });

  it('勾章 = 勾上这一章所有的题；取消其中一题，章的勾也跟着掉', () => {
    render(<BookImportPage />);
    paste();
    fireEvent.click(checkbox('Kapitel 1 Alltägliches'));
    expect(within(row('Modul 2 Aufgabe 2a')).getByRole('checkbox')).toBeChecked();
    expect(within(row('Modul 4 Aufgabe 2c')).getByRole('checkbox')).toBeChecked();
    expect(within(row('Auftakt Aufgabe 2a')).getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: '导入 2 课' })).toBeInTheDocument();

    fireEvent.click(within(row('Modul 4 Aufgabe 2c')).getByRole('checkbox'));
    expect(checkbox('Kapitel 1 Alltägliches')).not.toBeChecked();
    expect(screen.getByRole('button', { name: '导入 1 课' })).toBeInTheDocument();
  });

  it('轨数只在勾上时出现，且最少 1 轨', () => {
    render(<BookImportPage />);
    paste();
    expect(within(row('Modul 2 Aufgabe 2a')).queryByText(/轨$/)).toBeNull();
    fireEvent.click(within(row('Modul 2 Aufgabe 2a')).getByRole('checkbox'));
    const r = row('Modul 2 Aufgabe 2a');
    fireEvent.click(within(r).getByRole('button', { name: '少一轨' }));
    expect(within(r).getByText('1 轨')).toBeInTheDocument();
    fireEvent.click(within(r).getByRole('button', { name: '多一轨' }));
    expect(within(r).getByText('2 轨')).toBeInTheDocument();
  });

  it('按文件名自然顺序分给勾上的题；不够时说还差几轨，多了说用不到几个', () => {
    render(<BookImportPage />);
    paste();
    fireEvent.click(checkbox('Kapitel 1 Alltägliches'));
    fireEvent.click(within(row('Modul 2 Aufgabe 2a')).getByRole('button', { name: '多一轨' })); // 2 + 1 = 3 轨

    pickFiles(['Track 10.mp3', 'Track 2.mp3']);
    expect(within(row('Modul 2 Aufgabe 2a')).getByText('Track 2.mp3、Track 10.mp3')).toBeInTheDocument();
    expect(within(row('Modul 4 Aufgabe 2c')).getByText(/分不到音频/)).toBeInTheDocument();
    expect(screen.getByText(/一共要 3 轨，选了 2 个文件/)).toBeInTheDocument();

    pickFiles(['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3']);
    expect(within(row('Modul 4 Aufgabe 2c')).getByText('c.mp3')).toBeInTheDocument();
    expect(screen.getByText(/多出来的 1 个不会用到/)).toBeInTheDocument();
  });

  it('只分到一部分时明说还差几轨', () => {
    render(<BookImportPage />);
    paste();
    fireEvent.click(within(row('Modul 2 Aufgabe 2a')).getByRole('checkbox'));
    fireEvent.click(within(row('Modul 2 Aufgabe 2a')).getByRole('button', { name: '多一轨' }));
    fireEvent.click(within(row('Modul 2 Aufgabe 2a')).getByRole('button', { name: '多一轨' }));
    pickFiles(['a.mp3']);
    expect(within(row('Modul 2 Aufgabe 2a')).getByText(/a\.mp3（还差 2 轨）/)).toBeInTheDocument();
  });

  it('同一组里已有同名课时在那一行提示；别的组里有同名课不算', () => {
    useLessonStore.setState({
      lessons: [
        existingLesson('Kapitel 1 · Modul 2 Aufgabe 2a', 'Aspekte neu C1'),
        existingLesson('Kapitel 1 · Modul 4 Aufgabe 2c', 'Menschen B1'),
      ],
    });
    render(<BookImportPage />);
    setCollection('Aspekte neu C1');
    paste();
    expect(within(row('Modul 2 Aufgabe 2a')).getByText(/已经有这一课了/)).toBeInTheDocument();
    expect(within(row('Modul 4 Aufgabe 2c')).queryByText(/已经有这一课了/)).toBeNull();
  });

  it('认不出任何题目标题：拦路横幅，没有选题区', () => {
    render(<BookImportPage />);
    paste('Ein Text ohne Überschriften.\nNoch ein Satz.');
    expect(screen.getByText('没认出题目标题')).toBeInTheDocument();
    expect(screen.queryByText('选题与音频')).toBeNull();
  });

  it('没填教材名、或一题都没勾时导入键是灰的', () => {
    render(<BookImportPage />);
    paste();
    fireEvent.click(checkbox('Kapitel 1 Alltägliches'));
    expect(screen.getByRole('button', { name: '导入 2 课' })).toBeDisabled();
    setCollection('Aspekte neu C1');
    expect(screen.getByRole('button', { name: '导入 2 课' })).toBeEnabled();
    fireEvent.click(checkbox('Kapitel 1 Alltägliches'));
    expect(screen.getByRole('button', { name: '导入 0 课' })).toBeDisabled();
  });

  it('导入：按顺序建课、多轨的记下文件清单、有音频的才排对齐，完了回课程列表', async () => {
    render(<BookImportPage />);
    setCollection('  Aspekte neu C1 ');
    paste();
    fireEvent.click(checkbox('Kapitel 1 Alltägliches'));
    fireEvent.click(within(row('Modul 2 Aufgabe 2a')).getByRole('button', { name: '多一轨' }));
    pickFiles(['1_02.mp3', '1_03.mp3']); // 刚好给第一题，第二题分不到
    fireEvent.click(screen.getByRole('button', { name: '导入 2 课' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ name: 'lessons' }));
    expect(createLesson).toHaveBeenCalledTimes(2);
    expect(createLesson.mock.calls[0][0]).toMatchObject({
      title: 'Kapitel 1 · Modul 2 Aufgabe 2a',
      collection: 'Aspekte neu C1',
      speakers: ['●', '○'],
      audioFiles: ['1_02.mp3', '1_03.mp3'],
      plainText: '● Hallo, seid herzlich willkommen.\n○ Ja, genau.',
    });
    expect(createLesson.mock.calls[1][0]).toMatchObject({ title: 'Kapitel 1 · Modul 4 Aufgabe 2c', audioFile: undefined });
    expect(concatAudioFiles).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('id-1');
  });

  it('单轨的题不记 audioFiles（与一课一个 mp3 的老课程同一形状）', async () => {
    render(<BookImportPage />);
    setCollection('X');
    paste();
    fireEvent.click(within(row('Modul 4 Aufgabe 2c')).getByRole('checkbox'));
    pickFiles(['solo.mp3']);
    fireEvent.click(screen.getByRole('button', { name: '导入 1 课' }));
    await waitFor(() => expect(createLesson).toHaveBeenCalled());
    expect(createLesson.mock.calls[0][0]).toMatchObject({ audioFiles: undefined });
  });

  it('中途失败：已导的留着，横幅说明，按钮恢复可点，不跳走', async () => {
    createLesson.mockImplementationOnce(async () => 'ok-1').mockImplementationOnce(async () => {
      throw new Error('IndexedDB 满了');
    });
    render(<BookImportPage />);
    setCollection('X');
    paste();
    fireEvent.click(checkbox('Kapitel 1 Alltägliches'));
    fireEvent.click(screen.getByRole('button', { name: '导入 2 课' }));

    expect(await screen.findByText('导入中断了')).toBeInTheDocument();
    expect(screen.getByText(/IndexedDB 满了/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入 2 课' })).toBeEnabled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
