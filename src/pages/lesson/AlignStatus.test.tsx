// §12.26（变更 93）：对齐是**准备工作**，不是练习时要看的东西。
//
// 这个文件守的就是那条分界：课程页头部只在「这一课现在练不了」时说话，
// 其余一切（覆盖率、重对、送服务器、低置信句怎么核）都在「⋯ → 对齐」那一页。
//
// 起因是一张截图：一课早就对齐好了，头部仍然顶着「已对齐 37/37 句」
// 「重新对齐」「送到服务器算」和一段三行的黄字 —— 每次打开这一课都读一遍，
// 而这些东西一整课只用得上零次。

import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AlignPanel, AlignStatus } from './AlignStatus';
import { useAlignStore } from '@/state/useAlignStore';
import type { Lesson, Sentence } from '@/types/models';

function sentence(index: number, timed: boolean, confidence?: number): Sentence {
  return {
    index,
    text: `Satz ${index}`,
    charStart: 0,
    charEnd: 6,
    startTime: timed ? index * 5 : undefined,
    endTime: timed ? index * 5 + 5 : undefined,
    endTimeExplicit: timed,
    timingSource: timed ? 'auto' : undefined,
    timingConfidence: confidence,
    blanks: [],
    markedDifficult: false,
    excluded: false,
  };
}

function lessonWith(sentences: Sentence[]): Lesson {
  return {
    id: 'l1',
    title: 'Auch Polizisten brauchen mal Hilfe',
    source: { type: 'manual' },
    audioDuration: 30,
    sentences,
    createdAt: 0,
    updatedAt: 0,
  };
}

const ALIGNED = lessonWith([0, 1, 2].map((i) => sentence(i, true, -0.02)));
const UNTIMED = lessonWith([0, 1, 2].map((i) => sentence(i, false)));

beforeEach(() => {
  useAlignStore.setState({ current: null, queue: [], blocked: false, phone: false, remote: false });
});

describe('AlignStatus —— 课程页头部', () => {
  it('对齐好了、没在跑：一个节点都不画（连容器都没有）', () => {
    const { container } = render(<AlignStatus lesson={ALIGNED} />);
    expect(container.firstChild).toBeNull();
  });

  it('低置信句也不足以让头部说话 —— 那一档在通听的「N 句待核对」上', () => {
    const lesson = lessonWith([
      sentence(0, true, -0.02),
      sentence(1, true, -0.03),
      sentence(2, true, -1.4),
    ]);
    const { container } = render(<AlignStatus lesson={lesson} />);
    expect(container.firstChild).toBeNull();
  });

  it('真的没有时间戳时才说话，并且当场给按钮', () => {
    render(<AlignStatus lesson={UNTIMED} />);
    expect(screen.getByText('这一课还没有时间戳')).toBeTruthy();
    expect(screen.getByText('自动对齐')).toBeTruthy();
  });

  it('正在对齐时说一行，并把人指向底部的进度条', () => {
    useAlignStore.setState({
      current: {
        lessonId: 'l1',
        title: ALIGNED.title,
        progress: { stage: 'infer' },
        startedAt: 0,
      },
    });
    render(<AlignStatus lesson={ALIGNED} />);
    expect(screen.getByText(/正在对齐/)).toBeTruthy();
  });

  it('这台设备跑不动模型是拦路那一档，照旧留在头部', () => {
    useAlignStore.setState({ blocked: true });
    render(<AlignStatus lesson={ALIGNED} />);
    expect(screen.getByText('这台设备跑不动对齐模型')).toBeTruthy();
  });

  it('对齐好了也不摆「重新对齐」「送到服务器算」—— 它们搬进了「⋯ → 对齐」', () => {
    useAlignStore.setState({ remote: true });
    render(<AlignStatus lesson={ALIGNED} />);
    expect(screen.queryByText('重新对齐')).toBeNull();
    expect(screen.queryByText('送到服务器算')).toBeNull();
    expect(screen.queryByText(/已对齐 /)).toBeNull();
  });
});

describe('AlignPanel —— 「⋯ → 对齐」那一页', () => {
  it('覆盖率、重对、送服务器全在这里', () => {
    useAlignStore.setState({ remote: true });
    render(<AlignPanel lesson={ALIGNED} />);
    expect(screen.getByText(/已对齐 3 \/ 3 句/)).toBeTruthy();
    expect(screen.getByText('重新对齐')).toBeTruthy();
    expect(screen.getByText('送到服务器算')).toBeTruthy();
  });

  it('低置信句的说明在这里，而且把人指回通听的那个按钮', () => {
    const lesson = lessonWith([
      sentence(0, true, -0.02),
      sentence(1, true, -0.03),
      sentence(2, true, -1.4),
    ]);
    render(<AlignPanel lesson={lesson} />);
    expect(screen.getByText(/已对齐 3 \/ 3 句 · 1 句置信度偏低/)).toBeTruthy();
    expect(screen.getByText(/1 句待核对/)).toBeTruthy();
  });

  it('全对齐且没有低置信句时，这一页不多说一个字', () => {
    render(<AlignPanel lesson={ALIGNED} />);
    expect(screen.queryByText(/置信度明显低于本课水平/)).toBeNull();
  });
});
