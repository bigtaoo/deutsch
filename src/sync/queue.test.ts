import { afterEach, describe, expect, it } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME } from '@/db/schema';
import { enqueuePush, getQueue, drainQueue } from './queue';

afterEach(async () => {
  const db = await getDB();
  db.close();
  _resetDBForTests();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

describe('enqueuePush / getQueue', () => {
  it('adds an item to the persisted queue', async () => {
    await enqueuePush('vocab');
    const queue = await getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].kind).toBe('vocab');
  });

  it('replaces a stale queued item for the same lesson instead of stacking duplicates', async () => {
    await enqueuePush('lesson', 'l1');
    await enqueuePush('lesson', 'l1');
    const queue = await getQueue();
    expect(queue).toHaveLength(1);
  });

  it('删除意图会作废同一课的推送意图，反之亦然（否则一次 drain 会把删掉的课复活）', async () => {
    await enqueuePush('lesson', 'l1');
    await enqueuePush('lesson-delete', 'l1');
    expect(await getQueue()).toEqual([expect.objectContaining({ kind: 'lesson-delete' })]);

    await enqueuePush('lesson', 'l1');
    expect(await getQueue()).toEqual([expect.objectContaining({ kind: 'lesson' })]);
  });

  it('keeps separate lessons as separate queue entries', async () => {
    await enqueuePush('lesson', 'l1');
    await enqueuePush('lesson', 'l2');
    const queue = await getQueue();
    expect(queue.map((q) => q.lessonId).sort()).toEqual(['l1', 'l2']);
  });
});

describe('drainQueue (FR-11.10: 离线排队、恢复网络后自动重试)', () => {
  it('removes succeeded items and keeps failed ones for the next retry', async () => {
    await enqueuePush('vocab');
    await enqueuePush('lesson', 'l1');

    const result = await drainQueue(async (item) => {
      if (item.kind === 'lesson') throw new Error('still offline');
    });

    expect(result.succeeded).toHaveLength(1);
    expect(result.failed).toHaveLength(1);

    const remaining = await getQueue();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].kind).toBe('lesson');
  });
});
