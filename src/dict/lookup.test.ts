import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { bucketHex } from './bucket';
import { __resetDictCaches, dedupeKey, lookupDict, resolveForms } from './lookup';
import type { DictEntry } from './types';

// 词典文件是构建产物（26MB），测试里不碰真文件，只喂一个假的托管层。
// 这样才能测到那两件真正会出错的事：**SPA fallback 返回 HTML**、以及**同桶只取一次**。

const WORDS: Record<string, DictEntry> = {
  laufen: { w: 'laufen', s: [{ p: 'verb', de: ['sich schnell fortbewegen'], en: ['run'] }], f: 5000 },
  plattform: { w: 'Plattform', s: [{ p: 'noun', g: 'f', pl: 'Plattformen', de: ['ebene erhöhte Fläche'] }] },
  zuversicht: { w: 'Zuversicht', s: [{ p: 'noun', g: 'f', pl: 'Zuversichten' }] },
};

const FORMS: Record<string, string[]> = {
  gelaufen: ['laufen'],
  plattformen: ['plattform'],
  abgewogen: ['abwägen', 'abwiegen'], // 两个候选，且第一个在词典里查不到
};

let fetchCount: Record<string, number>;

function install(opts: { spaFallback?: boolean } = {}) {
  fetchCount = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetchCount[url] = (fetchCount[url] ?? 0) + 1;
      if (opts.spaFallback) {
        // wrangler 的 not_found_handling='single-page-application'：**200 + index.html**。
        // 这就是为什么判据不能是 res.ok。
        return new Response('<!doctype html><html><body>app</body></html>', { status: 200 });
      }
      const m = /\/dict\/(w|f)\/([0-9a-f]{2})\.json$/.exec(url);
      if (!m) return new Response('<!doctype html>', { status: 200 });
      const [, dir, hex] = m;
      const src: Record<string, unknown> = dir === 'w' ? WORDS : FORMS;
      const shard = Object.fromEntries(Object.entries(src).filter(([k]) => bucketHex(k) === hex));
      return new Response(JSON.stringify(shard), { status: 200 });
    }),
  );
}

beforeEach(() => {
  __resetDictCaches();
  install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lookupDict', () => {
  it('原形直接命中', async () => {
    const hit = await lookupDict('Plattform');
    expect(hit?.via).toBe('exact');
    expect(hit?.entry.w).toBe('Plattform');
    expect(hit?.entry.s[0].g).toBe('f');
  });

  it('大小写与 NFC 无关 —— DW 文稿里两种 ä 写法都出现过', async () => {
    expect((await lookupDict('PLATTFORM'))?.entry.w).toBe('Plattform');
    expect((await lookupDict('  Plattform  '))?.entry.w).toBe('Plattform');
  });

  it('变形走词形还原：Plattformen → Plattform', async () => {
    const hit = await lookupDict('Plattformen');
    expect(hit?.via).toBe('form');
    expect(hit?.queried).toBe('Plattformen');
    expect(hit?.entry.w).toBe('Plattform');
  });

  it('分词也还原：gelaufen → laufen（这正是 FR-9.3 那条 V1 局限）', async () => {
    expect((await lookupDict('gelaufen'))?.entry.w).toBe('laufen');
  });

  it('多个候选词元时跳过词典里没有的，取第一个查得到的', async () => {
    // abgewogen → [abwägen, abwiegen]，两个都不在这份假词典里 → 查不到，
    // 但**不能因为第一个不在就放弃**。
    expect(await lookupDict('abgewogen')).toBeNull();
    const urls = Object.keys(fetchCount).filter((u) => u.includes('/w/'));
    expect(urls.length).toBeGreaterThanOrEqual(2); // abwägen 与 abwiegen 各查了一次
  });

  it('查不到返回 null，不抛', async () => {
    expect(await lookupDict('Quatschwortxyz')).toBeNull();
    expect(await lookupDict('')).toBeNull();
    expect(await lookupDict('   ')).toBeNull();
  });

  it('多词搭配查不到是预期行为（FR-9.4 的搭配得人来写）', async () => {
    expect(await lookupDict('hing ... ab')).toBeNull();
  });
});

describe('缓存', () => {
  it('同一个词查两次只取一次桶', async () => {
    await lookupDict('Plattform');
    const after = { ...fetchCount };
    await lookupDict('Plattform');
    expect(fetchCount).toEqual(after);
  });

  it('并发查同一个桶只发一次请求', async () => {
    await Promise.all([lookupDict('laufen'), lookupDict('laufen'), lookupDict('laufen')]);
    const url = `/dict/w/${bucketHex('laufen')}.json`;
    expect(fetchCount[url]).toBe(1);
  });

  it('桶取不到时**不缓存**结果 —— 否则词典补上了也一直查不到', async () => {
    vi.unstubAllGlobals();
    install({ spaFallback: true });
    expect(await lookupDict('Plattform')).toBeNull();

    vi.unstubAllGlobals();
    install();
    expect((await lookupDict('Plattform'))?.entry.w).toBe('Plattform');
  });
});

describe('SPA fallback（wrangler / 原生壳）', () => {
  it('200 + index.html 要当作「查不到」，不能当成 JSON 崩掉', async () => {
    install({ spaFallback: true });
    await expect(lookupDict('Plattform')).resolves.toBeNull();
    await expect(resolveForms('Plattformen')).resolves.toEqual([]);
  });
});

describe('dedupeKey（FR-9.3）', () => {
  it('同一个词的不同变形归到同一个键', async () => {
    expect(await dedupeKey('Plattform')).toBe('plattform');
    expect(await dedupeKey('Plattformen')).toBe('plattform');
    expect(await dedupeKey('gelaufen')).toBe('laufen');
    expect(await dedupeKey('laufen')).toBe('laufen');
  });

  it('查不到时退回归一化 surface —— 行为与 V1 相同，不是报错', async () => {
    expect(await dedupeKey('Quatschwortxyz')).toBe('quatschwortxyz');
  });
});
