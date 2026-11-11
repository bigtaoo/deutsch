import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileDiagSink } from './diag.ts';

// 收件箱本身很小，但它有三条必须成立的性质：能存能读、**存不会把盘撑爆**、
// id 不能拿来往上跳目录。前两条是它存在的条件，第三条是它不作恶的条件。

describe('createFileDiagSink', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'diag-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('存进去能原样读回来，列表按时间倒序', () => {
    // 把两次写入钉在不同的毫秒上：原来靠真实时钟，两次落在同一毫秒时顺序就由随机后缀决定，
    // CI 上真红过一次（期望 b,a、拿到 a,b）。
    const now = vi.spyOn(Date, 'now');
    const sink = createFileDiagSink(root);
    now.mockReturnValue(1_790_000_000_000);
    const a = sink.save('u1', { schema: 1, hello: 'a' });
    now.mockReturnValue(1_790_000_000_001);
    const b = sink.save('u1', { schema: 1, hello: 'b' });
    now.mockRestore();
    const list = sink.list('u1');
    expect(list.map((e) => e.id)).toEqual([b.id, a.id]);
    expect(JSON.parse(sink.get('u1', a.id)!)).toEqual({ schema: 1, hello: 'a' });
    expect(a.bytes).toBeGreaterThan(0);
  });

  it('同一毫秒进来的两份，顺序也是确定的（按 id），不取决于 readdir', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000);
    const sink = createFileDiagSink(root);
    const ids = [sink.save('u1', { n: 1 }).id, sink.save('u1', { n: 2 }).id];
    now.mockRestore();
    expect(sink.list('u1').map((e) => e.id)).toEqual([...ids].sort().reverse());
  });

  it('每个用户各存各的 —— 别人的报告读不到', () => {
    const sink = createFileDiagSink(root);
    const mine = sink.save('u1', { x: 1 });
    expect(sink.get('u2', mine.id)).toBeNull();
    expect(sink.list('u2')).toEqual([]);
  });

  it('还没人发过时列表是空的，不是抛错', () => {
    expect(createFileDiagSink(root).list('nobody')).toEqual([]);
  });

  // 上限是防「点上瘾了」把盘塞满：这台机器上还跑着别人的东西，
  // 而一份报告可以有几百 KB。
  it('超过保留上限就删最旧的', () => {
    const sink = createFileDiagSink(root);
    for (let i = 0; i < 65; i += 1) sink.save('u1', { i });
    expect(sink.list('u1')).toHaveLength(60);
    expect(readdirSync(join(root, 'u1'))).toHaveLength(60);
  });

  // 变更 88：触发源进文件名，是为了 `ls -lt` **不用打开文件**就知道哪份是试听、
  // 哪份是查更新。一目录同样的时间戳跟没有一样。
  it('触发源拼进文件名，存、列、读三条路都认它', () => {
    const sink = createFileDiagSink(root);
    const saved = sink.save('u1', { x: 1 }, 'check-update');
    expect(saved.id.endsWith('-check-update')).toBe(true);
    expect(saved.trigger).toBe('check-update');
    expect(sink.list('u1')[0]?.trigger).toBe('check-update');
    expect(JSON.parse(sink.get('u1', saved.id)!)).toEqual({ x: 1 });
  });

  it('没触发源的（旧报告、或者客户端没带）照样能存能读', () => {
    const sink = createFileDiagSink(root);
    const saved = sink.save('u1', { x: 1 });
    expect(saved.trigger).toBeUndefined();
    expect(sink.list('u1')[0]?.trigger).toBeUndefined();
    expect(sink.get('u1', saved.id)).not.toBeNull();
  });

  // 触发源来自客户端的 JSON，而它要进文件名 —— 和 id 同等危险。
  it('不合格的触发源当没有，不让它往上跳一层', () => {
    const sink = createFileDiagSink(root);
    for (const bad of ['../../etc', 'Check Update', '中文', 'x'.repeat(40), '-lead']) {
      const saved = sink.save('u1', { x: 1 }, bad);
      expect(saved.trigger).toBeUndefined();
      expect(saved.id).toMatch(/^[0-9]{13}-[a-z0-9]{6}$/);
    }
    expect(readdirSync(join(root, 'u1'))).toHaveLength(5);
  });

  it('id 不合格式一律回 null —— 它直接进文件路径', () => {
    const sink = createFileDiagSink(root);
    sink.save('u1', { x: 1 });
    expect(sink.get('u1', '../../etc/passwd')).toBeNull();
    expect(sink.get('u1', 'nope')).toBeNull();
  });

  it('用户 id 里的路径字符会被洗掉，不会写到目录外面去', () => {
    const sink = createFileDiagSink(root);
    sink.save('../../evil', { x: 1 });
    // 落在 root 底下，名字被洗成下划线。
    expect(readdirSync(root)).toEqual(['______evil']);
  });
});
