import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleLines, installConsoleTap, nativeConsoleLines, resetConsoleTapForTests } from './consoleTap';

// 这一层的全部价值在于「Capgo 插件的原生日志是 evaluateJavaScript("console.info(…)")
// 打进来的」——抄下 console 等于把 Xcode 控制台搬进应用。所以两件事必须成立：
// 抄得到，并且**抄这件事本身永远不能吃掉一条日志**。

describe('consoleTap', () => {
  const original = { ...console };

  beforeEach(() => {
    resetConsoleTapForTests();
  });

  afterEach(() => {
    // 钩子是直接改 console 上的方法的，跑完必须还回去 —— 否则后面的用例
    // （以及 vitest 自己的输出）都还挂着上一个用例的钩子。
    Object.assign(console, original);
    resetConsoleTapForTests();
  });

  it('抄下每一行，带级别和时间', () => {
    installConsoleTap();
    console.info('🟢 Capacitor-updater : init for device abc');
    console.error('boom');
    const lines = consoleLines();
    expect(lines).toHaveLength(2);
    expect(lines[0].level).toBe('info');
    expect(lines[0].text).toContain('init for device abc');
    expect(lines[1].level).toBe('error');
    expect(lines[0].at).toBeGreaterThan(0);
  });

  it('原来的 console 照常被调用 —— 抄一份不等于截胡', () => {
    const spy = vi.fn();
    console.log = spy;
    installConsoleTap();
    console.log('hello', 1);
    expect(spy).toHaveBeenCalledWith('hello', 1);
    expect(consoleLines()[0].text).toBe('hello 1');
  });

  it('参数序列化不了也不抛 —— 它跑在每一次 console 调用里', () => {
    installConsoleTap();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => console.log(cyclic, new Error('x'))).not.toThrow();
    expect(consoleLines()).toHaveLength(1);
    expect(consoleLines()[0].text).toContain('Error: x');
  });

  it('装两遍不会记两份 —— 模块级副作用在 StrictMode 下可能跑两次', () => {
    installConsoleTap();
    installConsoleTap();
    console.log('once');
    expect(consoleLines()).toHaveLength(1);
  });

  it('单行过长会截断，整个缓冲有上限', () => {
    installConsoleTap();
    console.log('x'.repeat(5000));
    expect(consoleLines()[0].text.length).toBeLessThan(700);

    for (let i = 0; i < 600; i += 1) console.log(`line ${i}`);
    const lines = consoleLines();
    expect(lines.length).toBeLessThanOrEqual(500);
    // 留的是**最近**的那些 —— 诊断要看的永远是刚刚发生了什么。
    expect(lines[lines.length - 1].text).toBe('line 599');
  });

  it('只挑跟原生桥有关的那些行', () => {
    installConsoleTap();
    console.log('React DevTools');
    console.info('🟢 Capacitor-updater : notifyAppReady was called');
    expect(nativeConsoleLines()).toHaveLength(1);
    expect(nativeConsoleLines()[0].text).toContain('notifyAppReady');
  });
});
