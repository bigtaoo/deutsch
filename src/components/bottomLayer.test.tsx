// §12.2 的底部单浮层契约。它修的是「对齐进度条压住播放键」那个真 bug，
// 而判据全在两个 CSS 变量上 —— 变量算错了，症状是内容被浮层挡住，
// 而那种事在测试里看不见、在浏览器里也要盯着才发现。所以直接验变量。
//
// jsdom 里 offsetHeight 恒为 0，所以每一层的高度在这里显式定义出来 ——
// 这正是模块注释里「按在不在场判断、不按高度判断」那条的由来。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useRef } from 'react';
import { render, screen } from '@testing-library/react';
import { useBottomLayer, useHasAudioBar } from './bottomLayer';

function Layer({ layer, height }: { layer: 'tabbar' | 'audio' | 'align'; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  if (ref.current && ref.current.offsetHeight !== height) {
    Object.defineProperty(ref.current, 'offsetHeight', { value: height, configurable: true });
  }
  useBottomLayer(layer, ref.current);
  return (
    <div
      ref={(el) => {
        if (el) Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
        ref.current = el;
      }}
      data-testid={layer}
    />
  );
}

function Probe() {
  return <span data-testid="has-audio">{String(useHasAudioBar())}</span>;
}

const cssVar = (name: string) => document.documentElement.style.getPropertyValue(name);

beforeEach(() => {
  document.documentElement.style.removeProperty('--base-bar-h');
  document.documentElement.style.removeProperty('--bottom-inset');
});

afterEach(() => {
  // 模块级的 heights Map 跨测试存活，必须靠卸载清掉。
  document.body.innerHTML = '';
});

describe('两个 CSS 变量', () => {
  it('只有标签栏时：基座 = 标签栏，内容留白 = 基座', () => {
    const view = render(<Layer layer="tabbar" height={56} />);
    view.rerender(<Layer layer="tabbar" height={56} />);
    expect(cssVar('--base-bar-h')).toBe('56px');
    expect(cssVar('--bottom-inset')).toBe('56px');
    view.unmount();
  });

  it('基座 + 对齐条：留白是两层之和，基座仍只算基座', () => {
    const view = render(
      <>
        <Layer layer="audio" height={72} />
        <Layer layer="align" height={40} />
      </>,
    );
    view.rerender(
      <>
        <Layer layer="audio" height={72} />
        <Layer layer="align" height={40} />
      </>,
    );
    expect(cssVar('--base-bar-h')).toBe('72px');
    expect(cssVar('--bottom-inset')).toBe('112px');
    view.unmount();
  });

  it('切路由那一帧标签栏与音频条同时在场时，基座取 max 不取和 —— 取和会让底部抖一下', () => {
    const view = render(
      <>
        <Layer layer="tabbar" height={56} />
        <Layer layer="audio" height={72} />
      </>,
    );
    view.rerender(
      <>
        <Layer layer="tabbar" height={56} />
        <Layer layer="audio" height={72} />
      </>,
    );
    expect(cssVar('--base-bar-h')).toBe('72px');
    expect(cssVar('--bottom-inset')).toBe('72px');
    view.unmount();
  });

  it('一层卸载之后它的高度不再算进去', () => {
    const view = render(
      <>
        <Layer layer="tabbar" height={56} />
        <Layer layer="align" height={40} />
      </>,
    );
    view.rerender(
      <>
        <Layer layer="tabbar" height={56} />
        <Layer layer="align" height={40} />
      </>,
    );
    expect(cssVar('--bottom-inset')).toBe('96px');

    view.rerender(<Layer layer="tabbar" height={56} />);
    expect(cssVar('--bottom-inset')).toBe('56px');
    view.unmount();
    expect(cssVar('--bottom-inset')).toBe('0px');
  });

  it('对齐条自己折叠↔展开时留白跟着变（高度是实测的，不是常量）', () => {
    const view = render(<Layer layer="align" height={8} />);
    view.rerender(<Layer layer="align" height={8} />);
    expect(cssVar('--bottom-inset')).toBe('8px');
    view.rerender(<Layer layer="align" height={64} />);
    expect(cssVar('--bottom-inset')).toBe('64px');
    view.unmount();
  });
});

describe('useHasAudioBar', () => {
  it('没有音频条时是 false', () => {
    const view = render(<Probe />);
    expect(screen.getByTestId('has-audio')).toHaveTextContent('false');
    view.unmount();
  });

  it('音频条挂上就是 true，卸载又回 false —— 对齐条据此决定折不折叠', () => {
    const view = render(
      <>
        <Probe />
        <Layer layer="audio" height={72} />
      </>,
    );
    view.rerender(
      <>
        <Probe />
        <Layer layer="audio" height={72} />
      </>,
    );
    expect(screen.getByTestId('has-audio')).toHaveTextContent('true');

    view.rerender(<Probe />);
    expect(screen.getByTestId('has-audio')).toHaveTextContent('false');
    view.unmount();
  });

  it('高度为 0 的音频条也算在场 —— jsdom 里 offsetHeight 恒为 0，按高度判会永远看不见它', () => {
    const view = render(
      <>
        <Probe />
        <Layer layer="audio" height={0} />
      </>,
    );
    view.rerender(
      <>
        <Probe />
        <Layer layer="audio" height={0} />
      </>,
    );
    expect(screen.getByTestId('has-audio')).toHaveTextContent('true');
    view.unmount();
  });
});
