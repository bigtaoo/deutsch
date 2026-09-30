// FR-22.2：速背词库。**真身是同目录 `sources/*.tsv`**，一个主题一个文件，
// 文件名就是主题名。改词库 = 改 TSV、推上去，deploy-server 把整个 server/ 发到 VPS，
// 手机下一次打开速背就拿到新版 —— 前端不用发版，iOS 不用出包。
//
// TSV 五列：词形 · 词性 · 性 · 中文 · 备注（`-` 表示空）。启动时解析一次，
// 序列化成 JSON 存在内存里，版本号是这份 JSON 的 sha256 前 12 位。
//
// ── id 必须稳定 ──
// 客户端的进度挂在 id 上。id = 小写词形；同形不同词性（`Laufen` / `laufen`）第二个起
// 后缀 `#词性`。所以**别给已有的词改拼写** —— 改了就是一个新词，旧进度对不上它。

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const WORDBANK_POS = ['noun', 'verb', 'adj', 'adv', 'other'] as const;
export type WordbankPos = (typeof WORDBANK_POS)[number];

export interface WordbankItem {
  id: string;
  w: string;
  p: WordbankPos;
  g?: 'm' | 'f' | 'n' | 'pl';
  zh: string;
  n?: string;
  t: string;
}

export interface LoadedWordbank {
  version: string;
  count: number;
  /** 已经序列化好的 `{ version, items }`，每次请求原样发出去。 */
  json: string;
}

function blank(s: string | undefined): string | undefined {
  const v = (s ?? '').trim();
  return v === '' || v === '-' ? undefined : v;
}

/**
 * 解析一个主题的 TSV。坏行（列数不对、词性不认识、没有中文）跳过并记进 `skipped`，
 * 不让一行笔误把整个词库拖下水。
 */
export function parseWordbankTsv(topic: string, text: string): { items: Omit<WordbankItem, 'id'>[]; skipped: number } {
  const items: Omit<WordbankItem, 'id'>[] = [];
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith('#')) continue;
    const cols = raw.split('\t');
    let w = (cols[0] ?? '').trim();
    const p = (cols[1] ?? '').trim() as WordbankPos;
    const g = blank(cols[2]);
    const zh = blank(cols[3]);
    let n = blank(cols[4]);
    if (!w || !zh || !WORDBANK_POS.includes(p)) {
      skipped++;
      continue;
    }
    // 词形里写了 sich 的，挪到备注里 —— 词形要能直接拿去查词典、取发音。
    if (/^sich\s+/i.test(w)) {
      w = w.replace(/^sich\s+/i, '');
      n = n ? (n.includes('sich') ? n : `sich ~；${n}`) : 'sich ~';
    }
    const item: Omit<WordbankItem, 'id'> = { w, p, zh, t: topic };
    if (g === 'm' || g === 'f' || g === 'n' || g === 'pl') item.g = g;
    if (n) item.n = n;
    items.push(item);
  }
  return { items, skipped };
}

/** 跨主题去重（同词形同词性只留第一条），并发 id。 */
export function assignIds(items: Omit<WordbankItem, 'id'>[]): WordbankItem[] {
  const out: WordbankItem[] = [];
  const byKey = new Map<string, Set<WordbankPos>>();
  for (const item of items) {
    const key = item.w.normalize('NFC').toLowerCase();
    const seen = byKey.get(key);
    if (seen?.has(item.p)) continue;
    const id = seen ? `${key}#${item.p}` : key;
    if (seen) seen.add(item.p);
    else byKey.set(key, new Set([item.p]));
    out.push({ id, ...item });
  }
  return out;
}

export function buildWordbank(sources: { topic: string; text: string }[]): LoadedWordbank & { skipped: number } {
  let skipped = 0;
  const all: Omit<WordbankItem, 'id'>[] = [];
  for (const { topic, text } of [...sources].sort((a, b) => a.topic.localeCompare(b.topic))) {
    const parsed = parseWordbankTsv(topic, text);
    skipped += parsed.skipped;
    all.push(...parsed.items);
  }
  const items = assignIds(all);
  const payload = JSON.stringify(items);
  const version = createHash('sha256').update(payload).digest('hex').slice(0, 12);
  return { version, count: items.length, json: JSON.stringify({ version, items }), skipped };
}

/** 读 `dir` 下所有 `*.tsv`。文件名去掉前面的序号（`01-wohnen.tsv` → `wohnen`）就是主题名。 */
export function loadWordbankDir(dir: string): LoadedWordbank & { skipped: number } {
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsv'));
  return buildWordbank(
    files.map((f) => ({
      topic: basename(f, '.tsv').replace(/^\d+-/, ''),
      text: readFileSync(join(dir, f), 'utf8'),
    })),
  );
}

/** 默认的词库目录：这个文件旁边的 `sources/`（镜像里 `COPY src ./src` 带着它）。 */
export const DEFAULT_WORDBANK_DIR = join(import.meta.dirname, 'sources');
