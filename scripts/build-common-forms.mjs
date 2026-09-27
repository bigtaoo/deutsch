// FR-9.13「本课生词候选」用的**常见词形表**：口语词频表里排前一万的词形，产出 public/dict/common-forms.json。
//
// 为什么不直接用词元的 `f` / 牌组 1~3 档（build-dict.mjs）：那边的频次是把词形归并到词元上的，
// 而**有歧义的词形整份丢掉**（为了不让 `abgewogen` 同时抬高 abwägen 和 abwiegen）。
// 代价是最常见的一批名词恰好都有歧义 —— `tag`（Tag / tagen 的命令式）、`arbeit`、`schule`、
// `wasser`、`baum` —— 它们在词元那一侧没有频次，进不了前几档。牌组能接受「少算」，
// 候选列表不能：它会把 `Tag` 当成最生僻的词列在第一个。
// 试过「词形本身是词头就只记给词头」（2026-09-27）：`Tag` 好了，但 `habe` / `weiß` / `muss`
// 的频次被名词 `Habe` / `Weiß` / `Muss` 抢走，牌组第 1 档冒出这三个词 —— 撤回了。
//
// 词形表本身没有这个问题：它问的是「这个**写法**在口语里常不常见」，不需要知道是哪个词元。
// 一万这个界是看真词定的：`entscheidung` 977、`herbst` 5804、`umwelt` 9150 在里面（C1 都认识），
// `plattform` 12561、`erholung` 13626、`zuversicht` 16080 在外面。
//
// 源文件与 build-dict.mjs 同一份（.cache/dict/de_50k.txt，hermitdave/FrequencyWords，MIT）。

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.DICT_CACHE ?? join(ROOT, '.cache', 'dict');
const OUT = join(ROOT, 'public', 'dict', 'common-forms.json');
const TOP = 10000;

const text = await readFile(join(CACHE, 'de_50k.txt'), 'utf8');
const forms = [];
for (const line of text.split('\n')) {
  const [form] = line.trim().split(/\s+/);
  if (!form) continue;
  // 与 src/dict/bucket.ts 的 normalizeKey 同一个归一化：NFC + 小写
  forms.push(form.normalize('NFC').toLowerCase());
  if (forms.length >= TOP) break;
}
await writeFile(OUT, JSON.stringify(forms), 'utf8');
console.log(`common-forms.json：${forms.length} 个词形，${(Buffer.byteLength(JSON.stringify(forms)) / 1024).toFixed(0)} KiB`);
