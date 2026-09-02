// 把 WikDict 的 SQLite + 一份口语词频表，编译成 public/dict/ 下的分桶 JSON（FR-16 / FR-17）。
//
// 用法：npm run build:dict
//
// **产物入库，源文件不入库。** 这跟 public/models/ 的处理相反，理由是体积：
// 权重 418MB 排除掉是因为大，词典产物只有几 MB，入库换来的是「CI 不必下那 1GB 的 de.sqlite3」。
// 源文件缓存在 .cache/dict/（.gitignore 排除），跑第二遍时跳过下载。
//
// 为什么是 WikDict 而不是 §7.7 原计划的 Kaikki.org dump：Kaikki 的 de-extract 是
// 未裁剪的 Wiktionary 解析结果（GB 级、一条词条几十个字段），而 WikDict 已经把
// DBnary 归一化成「词条 / 词形 / 翻译」三张表，我们要的六样东西（性、IPA、复数、
// 德德释义、英译、中译）直接是列。少写一层解析器，也少一层解析出错的地方。
//
// 数据来源与许可（**必须随应用署名**，见 public/dict/meta.json + 设置页 FR-16.7）：
//   · de.sqlite3 / de-en.sqlite3 / de-zh.sqlite3
//     WikDict（wikdict.com），数据源自 Wiktionary 经 DBnary，**CC BY-SA**
//   · de_50k.txt
//     hermitdave/FrequencyWords，OpenSubtitles 语料的词频统计，**MIT**
//
// 刻意没用 Goethe-Zertifikat 的 A1/A2/B1 Wortliste：那三份是 © Goethe-Institut，
// 塞进上架的 App 属于再发布，且 EU 数据库权（§ 87a/b UrhG）保护的正是「选哪些词」
// 这个投入 —— 与 §3.1 R-5「内容零份」的立场不一致。而且官方只有 A1/A2/B1，
// B2/C1/C2 压根没有官方词表，所以「A1–C2 六档」这个形状无论如何也拼不出来。
// 代价是这里的档位是**词频档，不是 CEFR 等级**，界面上不能标成 A1/B2（FR-17.2）。
//
// ── 四个把结果整片弄错的坑（都是实测出来的，别改回去）──
//  1. `entry` 表有 102.8 万行，但其中只有 24.9 万是**德语维基词典自己**的条目。
//     其余是英、法、瑞典、库尔德等维基词典里关于德语词的条目（`eng/_deu__Zuversicht__Noun__1`），
//     它们的 `gender` 基本是 null。不按 `lexentry LIKE 'deu/%'` 过滤，
//     性会被这些空值覆盖掉 —— 而 FR-7.4 说名词不带性等于没记。
//  2. `form.number` 的取值是 **'Singular' / 'Plural'（首字母大写）**。
//     按小写比会一个复数都找不到，且不报错。
//  3. `form.other_written` 有约 300 万行**带冠词**（`den Zuversichten`）。
//     词形索引的键必须是单个词，否则查 `Zuversichten` 查不到、
//     而索引里塞满了永远匹配不上的 `den zuversichten`。
//  4. `pronun_list` 是 ` | ` 分隔的多个读音，且各自可能被 `/…/`、`[…]` 包着，
//     还可能带 `<q:less common>` 这种限定语。原样存进去卡片上就会显示出来。

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'dict');
const OUT = join(ROOT, 'public', 'dict');

// 分桶数。查一个词只解析一个桶，而不是把整本词典读进内存
// —— §7.10 说内存是手机上比速度和体积都硬的一道约束，
// 一次 JSON.parse 二十多 MB 正是那种会被 iOS 系统杀掉的形状。
const BUCKETS = 256;

const SOURCES = [
  { name: 'de.sqlite3', url: 'https://download.wikdict.com/dictionaries/sqlite/2/de.sqlite3' },
  { name: 'de-en.sqlite3', url: 'https://download.wikdict.com/dictionaries/sqlite/2/de-en.sqlite3' },
  { name: 'de-zh.sqlite3', url: 'https://download.wikdict.com/dictionaries/sqlite/2/de-zh.sqlite3' },
  {
    name: 'de_50k.txt',
    url: 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/de/de_50k.txt',
  },
];

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const kib = (bytes) => `${(bytes / 1024).toFixed(0)} KiB`;

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function ensureSource({ name, url }) {
  const dest = join(CACHE, name);
  const existing = await sizeOf(dest);
  if (existing) {
    console.log(`  · ${name} 已缓存，跳过（${mib(existing)}）`);
    return dest;
  }
  await mkdir(dirname(dest), { recursive: true });
  console.log(`  ↓ ${name} …`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} ← ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log(`  ✓ ${name} ${mib((await stat(dest)).size)}`);
  return dest;
}

// ══════ 归一化与分桶：这两个函数必须与 src/dict/bucket.ts 逐字一致 ══════
// 不一致的症状是「查得到的词随机变成查不到」—— 构建期写进 3f 号桶，运行期去 a1 号桶找。
// src/dict/bucket.test.ts 里钉了一批固定词的桶号，两边改了任一处都会红。

function normalizeKey(s) {
  return s.normalize('NFC').toLowerCase();
}

function bucketOf(key) {
  let h = 0x811c9dc5;
  const norm = normalizeKey(key);
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % BUCKETS;
}

const hex = (n) => n.toString(16).padStart(2, '0');

// ══════ 字段清洗 ══════

// entry.part_of_speech 已经是英文归一值（noun/verb/adjective/…），不必从 lexentry 反解。
// 取值是实测全集（`select distinct part_of_speech ... where lexentry like 'deu/%'`），
// 注意源数据里 adverb 有大小写两种写法（adverb 1544 行 / Adverb 70 行），少一条就漏 70 个词。
const POS_MAP = new Map([
  ['noun', 'noun'],
  ['verb', 'verb'],
  ['adjective', 'adj'],
  ['adverb', 'adv'],
  ['Adverb', 'adv'],
  ['participle', 'ptcp'],
  ['properNoun', 'propn'],
  ['abbreviation', 'abbr'],
  ['interjection', 'intj'],
  ['numeral', 'num'],
  ['preposition', 'prep'],
  ['postposition', 'prep'],
  ['conjunction', 'conj'],
  ['particle', 'ptcl'],
  ['article', 'art'],
  ['indefinitePronoun', 'pron'],
  ['demonstrativePronoun', 'pron'],
  ['pronominalAdverb', 'pron'],
  ['letter', 'letter'],
  ['suffix', 'affix'],
  ['prefix', 'affix'],
  ['affix', 'affix'],
]);

/** 进牌组的实词词性。 */
const DECK_POS = new Set(['noun', 'verb', 'adj', 'adv']);

// ── lexentry 中段的德语词性名 ──
// `deu/ich__Personalpronomen__1` 里那个 `Personalpronomen`。**必须用它而不是
// `part_of_speech` 列来判功能词**：代词、连词、冠词这些的 `part_of_speech` 全是 **null**
// （实测 `ich` = `Substantiv/noun` + `Personalpronomen/null`），
// 所以只看那一列的话，`das Ich`（自我，确实是个合法名词）会把代词 `ich` 的词频整份继承过来
// —— band-1 里出现 `Ich Sie Du Sein Haben Gehen Gut` 就是这么来的。
const kindOf = (lexentry) => /__([^_]+(?:_[^_]+)*)__/.exec(lexentry ?? '')?.[1] ?? null;

/**
 * 这些 kind 是**词形条目**，不是词头：`gelaufen` 是 `laufen` 的分词，
 * `nachhaltigere` 是 `nachhaltig` 的比较级。实测有 6.6 万条这种条目。
 * 它们不进 w/ —— 查 `gelaufen` 应该得到 `laufen` 那一条（走 f/ 索引），
 * 而不是一条自成一格、往往连释义都没有的 `gelaufen`。
 */
const FORM_KINDS = new Set([
  'Partizip_I',
  'Partizip_II',
  'Komparativ',
  'Superlativ',
  'Dekliniertes_Gerundivum',
  'Erweiterter_Infinitiv',
]);

/**
 * 功能词的 kind，一票否决牌组。
 * 惯用语（Redewendung）与固定搭配（Wortverbindung）**不在此列** ——
 * FR-9.4 明说 `sich einer Sache bewusst sein` 比 `bewusst` 有用得多，
 * 那些该留在词典里；它们是多词的，本来也拿不到词频、不会进牌组。
 */
const FUNCTION_KINDS = new Set([
  'Personalpronomen',
  'Reflexivpronomen',
  'Possessivpronomen',
  'Demonstrativpronomen',
  'Indefinitpronomen',
  'Relativpronomen',
  'Interrogativpronomen',
  'Pronomen',
  'Pronominaladverb',
  'Artikel',
  'Präposition',
  'Postposition',
  'Subjunktion',
  'Konjunktion',
  'Konjunktionaladverb',
  'Partikel',
  'Antwortpartikel',
  'Gradpartikel',
  'Fokuspartikel',
  'Modalpartikel',
  'Negationspartikel',
  'Interjektion',
  'Grußformel',
  'Numerale',
  'Zahlzeichen',
  'Abkürzung',
  'Kontraktion',
  'Suffix',
  'Präfix',
  'Suffixoid',
  'Präfixoid',
  'Gebundenes_Lexem',
  'Eigenname',
  'Toponym',
  'Straßenname',
  'Ortsnamengrundwort',
]);

/**
 * 一票否决牌组的词性。带这些义项的词一律不进牌组 ——
 * 实测不滤的话 band-1 长这样：`Ich Sie Du nicht einen Die Es Der`，
 * 因为功能词占了口语词频表最前面几百位，而它们不是「要记的生词」。
 * 分词（ptcp）也排除：`gelaufen` 是 `laufen` 的一个形，不该单独成卡。
 */
const DECK_POS_VETO = new Set(['art', 'pron', 'prep', 'conj', 'ptcl', 'num', 'intj', 'letter', 'affix', 'abbr', 'propn', 'ptcp']);

/**
 * 剩下的高频功能词靠词性滤不掉 —— `nicht` / `so` / `doch` 在 Wiktionary 里就是副词。
 * 这张表刻意只收**功能词与话语小品词**，不收实词：
 * `sein` / `gehen` / `sagen` 这些虽然对 C1 也是「早就会了」，但它们是真词，
 * 把它们从按词频排的牌组里剔掉，等于让档位说谎 —— 该由用户跳过前几档，
 * 而不是由这个脚本偷偷改写词频的含义。默认从哪一档开始练是 FR-17.4 的事。
 */
/**
 * 「这条释义是在说一个名字」。用来把人名地名品牌名挡在牌组之外 ——
 * 它们在 Wiktionary 里的词性就是 Substantiv，只能从释义文本认。
 */
// 地名的第二个义项常常是「某条河的支流」，而排除判据是「**每一条**释义都像名字」，
// 所以少了 Nebenfluss 这类词，Tennessee / Wisconsin 就会因为第二个义项不匹配而留下来。
// 同理 Hauptstadt 要能单独匹配：`Athen` 的释义是「Hauptstadt Griechenlands」，
// 属格没有介词，靠 `Hauptstadt\s+(in|von)` 那一支匹配不上。
const NAME_GLOSS =
  /\b(Vorname|Familienname|Nachname|Kurzform|Kosename|Beiname|Künstlername|Ortsname|Stadtteil|Bundesstaat|Landkreis|Markenname|Warenzeichen|Automarke|Nebenfluss|Zufluss|Hauptstadt|Landeshauptstadt|Kreisstadt|Verwaltungsbezirk)\b|\b(Stadt|Ort|Dorf|Gemeinde|Fluss|Berg|Insel|See|Provinz|Region|Staat)\s+(in|im|an|auf|von)\b/i;

const DECK_STOPWORDS = new Set(
  (
    'nicht so hier da doch schon noch nur auch mal wieder immer sehr ganz eben halt wohl etwa zwar sogar bloß' +
    ' ja nein okay ok na ach oh hey hallo tschüss bitte danke'
  ).split(/\s+/),
);

const GENDER_MAP = new Map([
  ['masculine', 'm'],
  ['feminine', 'f'],
  ['neuter', 'n'],
]);

/** 取第一个读音并剥掉 `/…/`、`[…]` 与 `<q:…>` 限定语。 */
function cleanIpa(raw) {
  const first = String(raw ?? '').split(' | ')[0];
  if (!first) return null;
  const v = first
    .replace(/<[^>]*>/g, '')
    .trim()
    .replace(/^[/[]+|[/\]]+$/g, '')
    .trim();
  return v || null;
}

/** 后缀/前缀条目（`-ig`、`-ung`）不是词，别进词典也别进牌组。 */
const isAffix = (w) => w.startsWith('-') || w.endsWith('-');

console.log('编译词典 → public/dict/');
console.log('\n[1/6] 取源文件（首次要下约 1GB 的 de.sqlite3，之后走缓存）');
const paths = {};
for (const src of SOURCES) paths[src.name] = await ensureSource(src);

// ══════ 词条骨架 ══════
console.log('\n[2/6] 读 entry：只要 deu/ 的条目');
const de = new DatabaseSync(paths['de.sqlite3'], { readOnly: true });

/** lexentry → 词条 */
const entries = new Map();
/** 归一化表层形式 → lexentry[]（一个词可能既是名词又是动词） */
const byWritten = new Map();

for (const r of de
  .prepare(
    `select lexentry, written_rep, part_of_speech, gender, pronun_list
       from entry where lexentry like 'deu/%' and written_rep is not null and written_rep != ''`,
  )
  .iterate()) {
  if (isAffix(r.written_rep)) continue;
  const rec = {
    w: r.written_rep,
    kind: kindOf(r.lexentry),
    pos: POS_MAP.get(String(r.part_of_speech ?? '')) ?? null,
    g: GENDER_MAP.get(String(r.gender ?? '')) ?? null,
    ipa: cleanIpa(r.pronun_list),
    pl: null,
    de: [],
    en: [],
    zh: [],
  };
  entries.set(r.lexentry, rec);
  const k = normalizeKey(r.written_rep);
  if (!byWritten.has(k)) byWritten.set(k, []);
  byWritten.get(k).push(r.lexentry);
}
console.log(`  词条 ${entries.size} 条，表层形式 ${byWritten.size} 个`);

// ══════ 复数 + 词形→词元 ══════
// form 表是这 1GB 的大头（580 万行），也是唯一能修掉 FR-9.3 那条已知局限的东西：
// V1 只能按 surface 去重，`gelaufen` 与 `laufen` 匹配不上。有了词形→词元索引，
// 两者都归到 laufen，去重才真的成立（FR-9.3 修订）。
//
// 必须用 iterate() 而不是 all()：580 万行一次读进内存直接把 node 撑爆。
console.log('\n[3/6] 读 form：主格复数 + 词形→词元（580 万行，走 iterate）');
/**
 * 归一化词形 → **归一化词元键** Set。
 *
 * 存归一化键而不是显示形式，是一个改了三次才对的地方。存显示形式时
 * `gelaufen` / `dachte` / `gesagt` 这类最常用的动词变形**全部丢失**：
 * `Laufen`（名词）与 `laufen`（动词）归一化后同键，合并成一条词条时
 * 显示形式只能留一个（取到的是名词那个 `Laufen`），而词形索引里存的是动词的 `laufen`，
 * 于是输出阶段那句「词元得确实在 w/ 里」的检查判假，整条被静默丢掉。
 * 运行期查词本来就走归一化键，存键既对又更省。
 */
const formToLemma = new Map();
let pluralHits = 0;
let formKeys = 0;
for (const r of de
  .prepare(
    `select lexentry, other_written, number, "case" as kase
       from form
      where other_written is not null and other_written != ''
        and other_written not like '% %'`,
  )
  .iterate()) {
  const rec = entries.get(r.lexentry);
  if (!rec) continue;

  // 复数**只对名词取**。不限词性的话 `nachhaltig` 会得到 `nachhaltigere`
  // —— 那是比较级，形容词压根没有「复数」这一栏。
  //
  // 取 Nominative 而不是随便一个 Plural：与格复数常带冠词、属格复数又是另一形。
  // 收成数组是因为源数据里同一个词可能有两个并列的主格复数（`Mädchen` 同时有
  // `Mädchen` 和口语的 `Mädchens`，两行 rank 都是 2，没有任何字段能分出主次）。
  // 显示时取**最短的那个**：Wiktionary 列出的 -s 变体一般是口语附加形，
  // 主形通常更短。这是启发式，不是数据里的事实。
  if (rec.pos === 'noun' && r.number === 'Plural' && r.kase === 'Nominative') {
    if (!rec.pl) rec.pl = [];
    if (!rec.pl.includes(r.other_written)) {
      rec.pl.push(r.other_written);
      pluralHits++;
    }
  }

  const fk = normalizeKey(r.other_written);
  const lemmaKey = normalizeKey(rec.w);
  if (fk === lemmaKey) continue; // 词形等于词元，不必存
  if (!formToLemma.has(fk)) {
    formToLemma.set(fk, new Set());
    formKeys++;
  }
  formToLemma.get(fk).add(lemmaKey);
}
de.close();
console.log(`  复数填上 ${pluralHits} 条，词形索引 ${formKeys} 个键`);

// ══════ 释义：德德（sense）+ 英译 + 中译 ══════
console.log('\n[4/6] 读翻译：德德释义 / 英译 / 中译');

function loadTranslations(file, field) {
  const db = new DatabaseSync(file, { readOnly: true });
  let hit = 0;
  for (const r of db
    .prepare(
      `select lexentry, sense, trans_list from translation
        where written_rep is not null order by score desc`,
    )
    .iterate()) {
    const rec = entries.get(r.lexentry);
    if (!rec) continue;
    hit++;
    // sense 是**德语**释义（"der feste Glaube daran, dass etwas Positives geschehen wird"）。
    // 对 C1 比中文释义有用 —— FR-14 已经在 DW 的 Glossar 上得出过同样的结论。
    // 只在读 de-en 时收：两个库的 sense 是同一份数据，读两遍会重复。
    if (field === 'en' && r.sense && rec.de.length < 3 && !rec.de.includes(r.sense)) rec.de.push(r.sense);
    for (const t of String(r.trans_list ?? '').split(' | ')) {
      const v = t.trim();
      if (v && rec[field].length < 4 && !rec[field].includes(v)) rec[field].push(v);
    }
  }
  db.close();
  return hit;
}

console.log(`  de-en 命中 ${loadTranslations(paths['de-en.sqlite3'], 'en')} 行`);
console.log(`  de-zh 命中 ${loadTranslations(paths['de-zh.sqlite3'], 'zh')} 行`);

// ══════ 词频：口语语料，按词形累加到词元 ══════
// de_50k.txt 是全小写的**词形**表（"mitwirkung 62"），而牌组要的是词元。
// 靠上一步的 formToLemma 把词形的计数加到词元头上 —— "laufe/läuft/lief/gelaufen"
// 的频次汇总到 laufen，这比拿词元自己的表层频次准得多。
console.log('\n[5/6] 读词频并归并到词元');
const freqText = await readFile(paths['de_50k.txt'], 'utf8');
/** 归一化词元键 → 累计频次 */
const lemmaFreq = new Map();
let freqLines = 0;
let matchedLines = 0;
let ambiguousLines = 0;
for (const line of freqText.split('\n')) {
  const [form, countRaw] = line.trim().split(/\s+/);
  if (!form || !countRaw) continue;
  freqLines++;
  const count = Number(countRaw);
  if (!Number.isFinite(count)) continue;
  const fk = normalizeKey(form);
  // 词形可能就是词元（"haus"→"Haus"），也可能是变形（"häuser"→"Haus"）。两条都算。
  const targets = new Set([...(byWritten.has(fk) ? [fk] : []), ...(formToLemma.get(fk) ?? [])]);
  if (targets.size === 0) continue;
  // **有歧义的词形一律不计频次。** 以前是把整份计数加到每一个候选词元头上，
  // 结果 `abgewogen` 的频次同时记给 `abwägen` 和 `abwiegen`，
  // 而这种记法会把生僻的同形异义词一路抬到词频表最前面 ——
  // band-1 里出现过 `Wa` 和古语 `fahen`，就是这么来的。
  // 少算一点频次质量远好于排名被污染。
  if (targets.size > 1) {
    ambiguousLines++;
    continue;
  }
  matchedLines++;
  for (const key of targets) lemmaFreq.set(key, (lemmaFreq.get(key) ?? 0) + count);
}
console.log(`  词频 ${freqLines} 行，命中 ${matchedLines} 行，因歧义丢弃 ${ambiguousLines} 行，覆盖 ${lemmaFreq.size} 个词元`);

// ══════ 输出 ══════
console.log('\n[6/6] 写 public/dict/');
await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'w'), { recursive: true });
await mkdir(join(OUT, 'f'), { recursive: true });
await mkdir(join(OUT, 'deck'), { recursive: true });

// 同一个表层形式的多个 lexentry 合成一条：运行期查的是 surface，
// 拿到的应该是「这个词的全部信息」，名词义和动词义都在。
const wordBuckets = new Map();
/** 真的进了 w/ 的**归一化**词元键 */
const lemmaKept = new Set();
/**
 * 不该进牌组的键。**要看这个键下的全部条目，不只是留进 w/ 的那些** ——
 * `ich` 的 `Personalpronomen` 条目既没有性也没有释义、根本进不了 `useful`，
 * 但它恰恰是「这个键是功能词」的唯一证据。只看 useful 就等于没滤。
 */
const deckVeto = new Set();
let kept = 0;
for (const [wk, lexentries] of byWritten) {
  const recs = lexentries.map((le) => entries.get(le)).filter(Boolean);
  if (recs.some((r) => FUNCTION_KINDS.has(r.kind ?? ''))) deckVeto.add(wk);
  // 留下的判据是「**能不能填上 FR-7.4 要的东西**」：有释义，或者有性（名词不带性等于没记）。
  //
  // 刻意**不**把「只有 IPA」算作有用。实测这样的词条有 82784 条、占 7.6 MiB，
  // 而它们在挖空面板上只能显示一串音标 —— 既不给意思也不给性，
  // 等于让人对着一个查不到的词以为查到了。这一档交给在线查（FR-16.5）。
  //
  // 词形条目（分词/比较级/……）也在这里剔掉：它们该由 f/ 索引指回词头。
  const useful = recs.filter(
    (r) => !FORM_KINDS.has(r.kind ?? '') && (r.de.length || r.en.length || r.zh.length || r.g),
  );
  if (useful.length === 0) continue;
  // 有释义的义项排前面，再按词性排 —— 记录级的 `w` 取第一个义项的显示形式，
  // 所以这个顺序决定了卡片和挖空面板上默认显示的是哪个词头。
  //
  // **名词化不定式要降级。** `das Haben` / `das Gehen` / `das Wissen` 都是合法名词，
  // 与动词 `haben` / `gehen` / `wissen` 共用一个归一化键；而词频表是全小写的，
  // 那份频次几乎一定属于动词。默认按「名词优先」排的话，band-1 会长成
  // `Haben Können Gehen Sehen Sagen Wissen` —— 全是大写，看着像另一批词。
  // 判据取数据里的事实而不是词表：**名词化不定式没有复数**。
  // 所以「无复数的名词」在同键有动词/形容词/副词义项时降级。
  // （`Leben` / `Essen` 有复数，照旧按名词显示 —— 那也确实是它们的主读法。）
  const POS_ORDER = ['noun', 'verb', 'adj', 'adv'];
  const hasLowercasePos = useful.some((r) => r.pos === 'verb' || r.pos === 'adj' || r.pos === 'adv');
  const nominalized = (r) => r.pos === 'noun' && !r.pl?.length && hasLowercasePos;
  useful.sort((a, b) => {
    const an = nominalized(a) ? 1 : 0;
    const bn = nominalized(b) ? 1 : 0;
    if (an !== bn) return an - bn;
    const ad = a.de.length || a.en.length || a.zh.length ? 0 : 1;
    const bd = b.de.length || b.en.length || b.zh.length ? 0 : 1;
    if (ad !== bd) return ad - bd;
    const ai = POS_ORDER.indexOf(a.pos ?? '');
    const bi = POS_ORDER.indexOf(b.pos ?? '');
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });

  const w = useful[0].w;
  const out = {
    w,
    s: useful.map((r) => {
      const sense = {};
      // 同一个归一化键下可以有两种大小写（名词 `Laufen` / 动词 `laufen`）。
      // 记录级的 w 只能留一个，所以**不一样的时候**在义项上单独写一份 ——
      // 否则用户标了 `läuft` 却看到词头 `Laufen`，看着像查错了词。
      if (r.w !== w) sense.w = r.w;
      if (r.pos) sense.p = r.pos;
      if (r.g) sense.g = r.g;
      if (r.pl?.length) {
        const sorted = [...r.pl].sort((a, b) => a.length - b.length || a.localeCompare(b, 'de'));
        sense.pl = sorted[0];
        if (sorted.length > 1) sense.pl2 = sorted.slice(1, 3);
      }
      if (r.ipa) sense.ipa = r.ipa;
      if (r.de.length) sense.de = r.de;
      if (r.en.length) sense.en = r.en;
      if (r.zh.length) sense.zh = r.zh;
      return sense;
    }),
  };
  const f = lemmaFreq.get(wk);
  if (f) out.f = f;
  const b = bucketOf(wk);
  if (!wordBuckets.has(b)) wordBuckets.set(b, {});
  wordBuckets.get(b)[wk] = out;
  lemmaKept.add(wk);
  kept++;
}

let wordBytes = 0;
for (let b = 0; b < BUCKETS; b++) {
  const body = JSON.stringify(wordBuckets.get(b) ?? {});
  await writeFile(join(OUT, 'w', `${hex(b)}.json`), body, 'utf8');
  wordBytes += Buffer.byteLength(body);
}
console.log(`  w/  ${kept} 条词，${BUCKETS} 桶，共 ${mib(wordBytes)}（均 ${kib(wordBytes / BUCKETS)}/桶）`);

// 词形→词元：只留词元确实进了 w/ 的那些，否则查到词元又查不到词条。
const formBuckets = new Map();
let formKept = 0;
for (const [fk, lemmas] of formToLemma) {
  const list = [...lemmas].filter((l) => lemmaKept.has(l));
  if (list.length === 0) continue;
  const b = bucketOf(fk);
  if (!formBuckets.has(b)) formBuckets.set(b, {});
  formBuckets.get(b)[fk] = list;
  formKept++;
}
let formBytes = 0;
for (let b = 0; b < BUCKETS; b++) {
  const body = JSON.stringify(formBuckets.get(b) ?? {});
  await writeFile(join(OUT, 'f', `${hex(b)}.json`), body, 'utf8');
  formBytes += Buffer.byteLength(body);
}
console.log(`  f/  ${formKept} 个词形，共 ${mib(formBytes)}（均 ${kib(formBytes / BUCKETS)}/桶）`);

// ══════ 预置词库：按口语词频分档 ══════
// **这些是词频档，不是 CEFR 等级**（FR-17.2）。命名刻意不用 A1/B2 —— 见文件头。
const ranked = [];
for (const [, obj] of wordBuckets) {
  for (const [wk, rec] of Object.entries(obj)) {
    if (!rec.f) continue;
    // 至少有一个实词义项，且这个键上**没有任何**功能词条目。用一票否决而不是
    // 「有实词就要」：`Ich` / `Sein` / `Gut` 在 Wiktionary 里都挂着合法的名词义项
    // （自我 / 存在 / 庄园），只按「有实词义项」筛照样全都漏进来。
    if (!rec.s.some((s) => DECK_POS.has(s.p))) continue;
    if (rec.s.some((s) => DECK_POS_VETO.has(s.p))) continue;
    if (deckVeto.has(wk)) continue;
    if (DECK_STOPWORDS.has(wk)) continue;
    // 卡背会是空的那些不进牌组。
    if (!rec.s.some((s) => s.de?.length || s.en?.length || s.zh?.length)) continue;
    // 人名地名品牌名不进牌组。OpenSubtitles 是影视对白语料，
    // `Melanie` `Oklahoma` `Toyota` `Niagarafälle` 都能排进前一万名。
    // 它们在 Wiktionary 里就是 Substantiv（`Eigenname` 那个 kind 只有 47 条，滤不掉），
    // 所以只能看释义文本。**要求「每一条德语释义都像名字」**才排除 ——
    // 只看第一条会误伤 `Bank`（银行/长椅）这种其中一个义项恰好是地名的词。
    const deSenses = rec.s.flatMap((s) => s.de ?? []);
    if (deSenses.length > 0 && deSenses.every((d) => NAME_GLOSS.test(d))) continue;
    ranked.push(rec);
  }
}
ranked.sort((a, b) => b.f - a.f || a.w.localeCompare(b.w, 'de'));

// 档位边界按词频**名次**切，不按频次值切：频次是齐夫分布，按值切第一档只会有几十个词。
const BANDS = [
  { id: 1, label: '最常见 1–500', to: 500 },
  { id: 2, label: '501–1500', to: 1500 },
  { id: 3, label: '1501–3000', to: 3000 },
  { id: 4, label: '3001–6000', to: 6000 },
  { id: 5, label: '6001–10000', to: 10000 },
  { id: 6, label: '10000 名以后', to: Infinity },
];
const bandMeta = [];
let from = 0;
for (const band of BANDS) {
  if (from >= ranked.length) break;
  const slice = ranked.slice(from, band.to === Infinity ? undefined : band.to);
  if (slice.length === 0) break;
  const body = JSON.stringify({
    id: band.id,
    label: band.label,
    words: slice.map((r, i) => ({ w: r.w, r: from + i + 1 })),
  });
  await writeFile(join(OUT, 'deck', `band-${band.id}.json`), body, 'utf8');
  bandMeta.push({ id: band.id, label: band.label, count: slice.length, bytes: Buffer.byteLength(body) });
  console.log(
    `  deck/band-${band.id}  ${String(slice.length).padStart(5)} 词  ${kib(Buffer.byteLength(body)).padStart(8)}  ${band.label}`,
  );
  from = band.to;
}

// meta.json 里带署名：CC BY-SA 要求署名，而这份数据会随 App 分发。
// 设置页把这段原样显示出来（FR-16.7）—— 写在这里不算履行署名义务。
const meta = {
  formatVersion: 1,
  buckets: BUCKETS,
  words: kept,
  forms: formKept,
  decks: bandMeta.map(({ id, label, count }) => ({ id, label, count })),
  attribution: [
    {
      what: '词条、性、IPA、复数、德语释义、英译、中译',
      source: 'WikDict (wikdict.com)，数据源自 Wiktionary 经 DBnary',
      license: 'CC BY-SA 4.0',
      url: 'https://www.wikdict.com/',
    },
    {
      what: '口语词频（用于分档）',
      source: 'hermitdave/FrequencyWords，OpenSubtitles 语料',
      license: 'MIT',
      url: 'https://github.com/hermitdave/FrequencyWords',
    },
  ],
  note: '档位是口语词频名次，不是 CEFR 等级。官方 CEFR 词表只有 A1/A2/B1 且有版权，理由见 scripts/build-dict.mjs 头部。',
};
await writeFile(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

const deckBytes = bandMeta.reduce((s, b) => s + b.bytes, 0);
console.log(
  `\n产物共 ${mib(wordBytes + formBytes + deckBytes)}：词条 ${mib(wordBytes)} / 词形 ${mib(formBytes)} / 牌组 ${kib(deckBytes)}`,
);
console.log('这些文件入库（体积够小，换来 CI 不必下那 1GB）。源文件在 .cache/dict/，已被 .gitignore 排除。');
