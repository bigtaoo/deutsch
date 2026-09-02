// 预置卡的发音（FR-17.6）。两条来源，按顺序退：
//   ① Wiktionary / Wikimedia Commons 上的**真人录音**（自由许可，可缓存可随包）
//   ② 系统 TTS（`speechSynthesis`，离线、100% 覆盖、机器音）
//
// ── 为什么预置卡非要有声音 ──
// FR-10.2 定的卡正面就是「音频 + 挖空原句」，FR-10.5 明说无音频卡不能静默降级。
// 而这个应用的存在理由是训练听觉识别 —— 一张纯文本的预置卡是「看图识字」，
// 放进同一个复习队列会把队列的性质稀释掉。所以宁可用机器音，也不留无声卡。
//
// **但要如实告诉用户这不是真语料**：两条来源都是**孤立词**发音，
// 练得到词形↔读音的对应，练不到连读 —— 而连读才是真正的难点。
// 卡面上标出来是哪一种来源（真人 / 合成），这是 FR-17.7。
//
// ── §3.1.1 R-1 ──
// 请求从用户设备直连 Wikimedia，没有任何我们运营的中转。与 DW 那条通路同形。
// 而且这些录音是自由许可的，**与 DW 音频的法律地位不同** —— 它们可以被缓存、
// 甚至随包分发，不受 §3.1 BYOC 那条约束。

import { normalizeKey } from './bucket';
import { getWordAudio, putWordAudio } from '@/db/wordAudio';

const API = 'https://de.wiktionary.org/w/api.php';

/** 一次批量问多少个词。MediaWiki 的 titles 上限是 50。 */
export const AUDIO_BATCH = 50;

/**
 * 挑发音文件的优先级。**必须挑，不能拿第一个** ——
 * 实测 `einhergehen` 的第一个音频是 `Bar-einhergehen.ogg`，那是**巴伐利亚方言**。
 * 拿它当标准德语发音去练听觉识别，比没有声音更糟。
 *
 *   `De-<词>.ogg`            德语维基词典的标准录音，约 15–22KB，覆盖率最高
 *   `LL-Q188 (deu)-<人>-<词>` Lingua Libre 的德语录音，wav，约 120–160KB
 *
 * 其余前缀（`Bar-` 巴伐利亚、`Gsw-` 瑞士德语、`Nds-` 低地德语…）一律不要。
 *
 * **但这个偏好序不是最终顺序** —— 见 pickPlayable：覆盖率最高的 `De-*` 是 Ogg Vorbis，
 * 而 WKWebView 放不了 Ogg。所以真正的选法是「在能放的里面挑最好的」。
 */
function scoreFile(title: string): number {
  const name = title.replace(/^Datei:/, '');
  if (/^De-/i.test(name)) return 0;
  if (/^LL-Q188 \(deu\)-/i.test(name)) return 1;
  return Number.POSITIVE_INFINITY;
}

/**
 * 在候选里挑第一个**本设备放得动**的。
 *
 * 这一步不能省成「挑最优的、放不了就算了」：`De-*.ogg` 覆盖率最高但是 Ogg Vorbis，
 * 而 Safari / WKWebView 对它的支持一直是缺的。按偏好序硬挑的话，
 * iPhone 上几乎每个词都会判成「没有真人音」而退到合成音 ——
 * 明明 Lingua Libre 的 wav 就在旁边、放得动。
 */
export function pickPlayable(refs: PronunciationRef[]): PronunciationRef | undefined {
  return refs
    // 方言在这里再滤一次。findPronunciations 已经滤过，但那层滤的是「从 API 收哪些」，
    // 而这个函数是导出的、可以被别处调用 —— 只排序不排除的话，
    // 一份 `Bar-*.ogg`（巴伐利亚）只要能放就会被选中，而那比没有声音更糟：
    // 声音是对的那个词，发音却不是标准德语，练歪了还不知道。
    .filter((r) => Number.isFinite(scoreFile(r.file)))
    .sort((a, b) => scoreFile(a.file) - scoreFile(b.file))
    .find((r) => canPlay(r.mime));
}

export interface PronunciationRef {
  lemma: string;
  file: string;
  url: string;
  mime: string;
  size: number;
}

/**
 * 批量问一批词的发音文件。一次请求最多 {@link AUDIO_BATCH} 个词。
 *
 * 用 `generator=images` + `prop=imageinfo` 而不是 `prop=extracts`：
 * extracts 的 `exlimit` 对纯文本模式实际只允许 **1 页**（实测传 20 个词只回来 1 个），
 * 而 generator 这条路真的支持 50 个词一批 —— 四万个词的差别是 800 次请求还是 11 小时。
 */
export async function findPronunciations(lemmas: string[]): Promise<Map<string, PronunciationRef[]>> {
  const out = new Map<string, PronunciationRef[]>();
  if (lemmas.length === 0) return out;

  const u = new URL(API);
  u.searchParams.set('action', 'query');
  u.searchParams.set('format', 'json');
  u.searchParams.set('formatversion', '2');
  u.searchParams.set('origin', '*'); // 实测 CORS 开放（access-control-allow-origin: *）
  u.searchParams.set('generator', 'images');
  u.searchParams.set('gimlimit', '500');
  u.searchParams.set('prop', 'imageinfo');
  u.searchParams.set('iiprop', 'url|size|mime');
  u.searchParams.set('titles', lemmas.slice(0, AUDIO_BATCH).join('|'));

  let pages: Array<{ title: string; imageinfo?: Array<{ url: string; size: number; mime: string }> }>;
  try {
    const res = await fetch(u);
    if (!res.ok) return out;
    const json = (await res.json()) as { query?: { pages?: typeof pages } };
    pages = json.query?.pages ?? [];
  } catch {
    // 断网、被墙、API 改形状 —— 一律当作「没有真人音」，由调用方退到 TTS。
    return out;
  }

  // generator=images 把所有词的图片混在一个平铺列表里返回，不带「属于哪个词」。
  // 所以只能从文件名把词认回来 —— 这也是必须按 `De-<词>` 这种命名约定匹配的原因。
  const wanted = new Map(lemmas.map((l) => [normalizeKey(l), l]));
  for (const page of pages) {
    if (!/\.(ogg|oga|wav|mp3|opus)$/i.test(page.title)) continue;
    const score = scoreFile(page.title);
    if (!Number.isFinite(score)) continue;
    const info = page.imageinfo?.[0];
    if (!info) continue;

    const stem = page.title
      .replace(/^Datei:/, '')
      .replace(/\.[^.]+$/, '')
      .replace(/^De-/i, '')
      .replace(/^LL-Q188 \(deu\)-[^-]+-/i, '');
    const lemma = wanted.get(normalizeKey(stem));
    if (!lemma) continue;

    // 全部留下，由 pickPlayable 在**本设备放得动**的里面挑 —— 不在这里就定死。
    const list = out.get(lemma) ?? [];
    list.push({
      lemma,
      file: page.title.replace(/^Datei:/, ''),
      // url 带着 utm_* 查询串，去掉 —— 它只是 API 给的来路标记，不影响内容。
      url: info.url.split('?')[0],
      mime: info.mime,
      size: info.size,
    });
    out.set(lemma, list);
  }
  return out;
}

/**
 * WKWebView 到底能不能放这个格式。
 *
 * 这个探测不是多余的谨慎：**Safari / WKWebView 对 Ogg Vorbis 的支持一直是缺的**，
 * 而 `De-*.ogg` 恰好是覆盖率最高的那一档。探不出来就退 TTS，而不是给一个
 * 点了没声音的播放键 —— 那是 §3.2 记过的那种「症状是『点了没反应』」的坏法。
 */
export function canPlay(mime: string): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.createElement('audio');
  if (typeof el.canPlayType !== 'function') return false;
  const verdict = el.canPlayType(mime);
  return verdict === 'probably' || verdict === 'maybe';
}

/** 取一个词的发音并落缓存。返回 undefined 表示没有可播的真人音。 */
export async function ensureWordAudio(lemma: string): Promise<Blob | undefined> {
  const key = normalizeKey(lemma);
  const cached = await getWordAudio(key);
  if (cached) return cached.blob; // 命中；blob 为空是「查过、没有」的否定结果

  const refs = await findPronunciations([lemma]);
  const ref = pickPlayable(refs.get(lemma) ?? []);
  if (!ref) {
    // 记下否定结果，免得每次复习到这张卡都再问一遍。
    await putWordAudio(key, { lemma, fetchedAt: Date.now() });
    return undefined;
  }

  try {
    const res = await fetch(ref.url);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    await putWordAudio(key, { lemma, blob, file: ref.file, mime: ref.mime, fetchedAt: Date.now() });
    return blob;
  } catch {
    // 取文件失败**不写否定结果**：这多半是网络问题，下次该再试。
    return undefined;
  }
}

/**
 * 批量预取一批词的发音（FR-17.6）。
 *
 * **加预置词的时候就取，不要等复习时再取。** 加词是一次主动的、必然在线的操作；
 * 而复习按 §2.1 的设备角色分工是在碎片时间、手机上、很可能没网的时候做的。
 * 到那时才发现没有声音，这张卡就只剩 TTS 了 —— 而 TTS 本来是兜底，不该是常态。
 *
 * 按 50 个一批问文件名（generator=images 的 titles 上限），再逐个取文件。
 * 请求之间不额外限速：这是用户点了一次按钮引起的几十个请求，
 * 与 §3.1.1 R-3 想防的「一键批量抓取内容」不是一回事 —— 何况这些是自由许可的公开录音。
 */
export async function prefetchWordAudio(
  lemmas: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ human: number; missing: number }> {
  const { knownWordAudioKeys } = await import('@/db/wordAudio');
  const known = await knownWordAudioKeys();
  const todo = lemmas.filter((l) => !known.has(normalizeKey(l)));

  let human = 0;
  let missing = 0;
  let done = 0;

  for (let i = 0; i < todo.length; i += AUDIO_BATCH) {
    const chunk = todo.slice(i, i + AUDIO_BATCH);
    const refs = await findPronunciations(chunk);
    for (const lemma of chunk) {
      const ref = pickPlayable(refs.get(lemma) ?? []);
      const key = normalizeKey(lemma);
      if (!ref) {
        await putWordAudio(key, { lemma, fetchedAt: Date.now() });
        missing++;
      } else {
        try {
          const res = await fetch(ref.url);
          if (!res.ok) throw new Error(String(res.status));
          await putWordAudio(key, {
            lemma,
            blob: await res.blob(),
            file: ref.file,
            mime: ref.mime,
            fetchedAt: Date.now(),
          });
          human++;
        } catch {
          missing++; // 不写否定结果：多半是网络问题，下次该再试
        }
      }
      onProgress?.(++done, todo.length);
    }
  }
  return { human, missing };
}

// ══════ TTS 兜底 ══════

/** 系统里有没有德语嗓音。没有的话连 TTS 都给不了，卡面必须说明（FR-17.7）。 */
export function germanVoice(): SpeechSynthesisVoice | null {
  if (typeof speechSynthesis === 'undefined') return null;
  const voices = speechSynthesis.getVoices();
  // de-DE 优先；退到任何 de-*（de-AT / de-CH 的口音对听觉识别训练也可用）。
  return voices.find((v) => v.lang === 'de-DE') ?? voices.find((v) => v.lang?.startsWith('de')) ?? null;
}

export function speak(text: string, rate = 1): boolean {
  const voice = germanVoice();
  if (!voice || typeof speechSynthesis === 'undefined') return false;
  // 不排队：连点两次应该是「重新念」，而不是念两遍。
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.voice = voice;
  utter.lang = voice.lang;
  utter.rate = rate;
  speechSynthesis.speak(utter);
  return true;
}

/** 卡面要显示的音源种类（FR-17.7）。 */
export type WordAudioSource = 'human' | 'tts' | 'none';
