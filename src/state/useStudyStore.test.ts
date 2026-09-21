// FR-18 的一条硬规矩：**这个 store 自己不写库**。写库的只有计时器（study/tracker），
// 这个 store 只在计时器落完库之后重读。
//
// 为什么值得用测试钉住：一旦界面上哪个地方能写这份数据，「学了多久」就不再是一个
// 观测值而是一个可以被改的数字，而 FR-18 的整个价值建立在它没被改过上。
// 顺带钉住落库与推同步的**顺序** —— 反了就会把还没落库的那几十秒漏掉。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDB, _resetDBForTests } from '@/db';
import { DB_NAME } from '@/db/schema';
import { putStudyLog, type StudyLog } from '@/study/log';

const scheduleStudySync = vi.fn();
vi.mock('@/sync/trigger', () => ({ scheduleStudySync: () => scheduleStudySync() }));

const { useStudyStore, connectStudyClock } = await import('./useStudyStore');
const { studyClock } = await import('@/study/tracker');

function log(days: StudyLog['days'], updatedAt = 1): StudyLog {
  return { days, updatedAt };
}

beforeEach(() => {
  useStudyStore.setState({ loaded: false });
});

afterEach(async () => {
  vi.clearAllMocks();
  studyClock.setActive(false);
  studyClock.setHooks({});
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

describe('load', () => {
  it('空库时给一份空记录，而不是 undefined —— 记录页首次打开不该白屏', async () => {
    await useStudyStore.getState().load();
    expect(useStudyStore.getState().log.days).toEqual({});
    expect(useStudyStore.getState().loaded).toBe(true);
    expect(useStudyStore.getState().stats).toBeDefined();
  });

  it('读回库里那份，并顺手把统计算好', async () => {
    await putStudyLog(log({ '2026-09-20': { 'dev-a': 600, 'dev-b': 300 } }));
    await useStudyStore.getState().load();

    expect(useStudyStore.getState().log.days['2026-09-20']).toEqual({
      'dev-a': 600,
      'dev-b': 300,
    });
    // 统计是从 log 现算的，不是另存一份。
    expect(useStudyStore.getState().stats.totalSeconds).toBe(900);
  });

  it('再 load 一次拿到的是库里的新值（同步拉回来之后靠这条刷新界面）', async () => {
    await putStudyLog(log({ '2026-09-20': { 'dev-a': 60 } }));
    await useStudyStore.getState().load();
    await putStudyLog(log({ '2026-09-20': { 'dev-a': 60 }, '2026-09-21': { 'dev-a': 120 } }, 2));
    await useStudyStore.getState().load();
    expect(Object.keys(useStudyStore.getState().log.days).sort()).toEqual([
      '2026-09-20',
      '2026-09-21',
    ]);
  });
});

describe('这个 store 不写库', () => {
  it('它只有 load 一个动作 —— 界面上没有任何地方能改学习时长', () => {
    const actions = Object.entries(useStudyStore.getState())
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k);
    expect(actions).toEqual(['load']);
  });
});

describe('connectStudyClock', () => {
  /** 攒出一点秒数再落库 —— flush 对空计时是空操作。 */
  async function practiceAndFlush(): Promise<void> {
    studyClock.setActive(true);
    studyClock.tick();
    await studyClock.flush();
    studyClock.setActive(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('计时器落完库之后重读 store，并排一次同步', async () => {
    connectStudyClock();
    await practiceAndFlush();

    expect(useStudyStore.getState().loaded).toBe(true);
    // 落库的是计时器，store 只是重读 —— 读到的秒数必须是真的写进去的那份。
    expect(useStudyStore.getState().stats.totalSeconds).toBeGreaterThan(0);
    expect(scheduleStudySync).toHaveBeenCalled();
  });

  it('推同步排在重读之后 —— 顺序反了会把还没落库的秒数漏掉', async () => {
    const order: string[] = [];
    scheduleStudySync.mockImplementation(() => order.push('sync'));
    const load = useStudyStore.getState().load;
    useStudyStore.setState({
      load: async () => {
        order.push('load');
        await load();
      },
    });

    connectStudyClock();
    await practiceAndFlush();

    useStudyStore.setState({ load });
    expect(order[0]).toBe('load');
    expect(order).toContain('sync');
  });
});
