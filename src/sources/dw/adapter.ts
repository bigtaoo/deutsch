// FR-13.4 ~ FR-13.9：DW adapter。整条链路就是浏览器里的三次 fetch（§7.8）——
// RSS、页面 HTML、mp3，三者全部 `Access-Control-Allow-Origin: *`（附录 A.1），
// 所以没有后端、没有代理、没有本地进程。
//
// §8 记了一条风险：DW 若收紧 CORS，这整层就失效。**因此 adapter 必须与 UI 解耦** ——
// 这个文件只负责「给我 lesson id，还你一份结构化数据」，换成别的取数方式时，
// 导入流程（FR-1/FR-2 那一套）一行都不用改。

import { extractApolloState, derefKey, findKeys, type ApolloState } from './apolloState';
import { manuscriptToText, htmlToPlainText, type RawGlossarySpan } from './htmlToText';
import { parseGlossaryTitle } from './glossary';
import { parseFeed, sortAndDedupe, type FeedItem } from './rss';

export type { FeedItem };

export interface DwKnowledge {
  id: string;
  name: string;
  text: string;
}

export interface DwLesson {
  lessonId: string;
  title: string;
  sourceUrl: string;
  teaser: string;
  firstPublicationDate?: number;
  /** 纯文本，Sentence.charStart/charEnd 的基准 */
  plainText: string;
  manuscriptHtml: string;
  spans: RawGlossarySpan[];
  knowledges: DwKnowledge[];
  audio?: { mp3Src: string; duration: number };
}

export const DW_PAGE_BASE = 'https://learngerman.dw.com';

/** 只知道 lesson id 时也能拼出页面地址：DW 接受任意 slug，靠 `l-<id>` 定位。 */
export function lessonUrl(lessonId: string, slug = 'lektion'): string {
  return `${DW_PAGE_BASE}/de/${slug}/l-${lessonId}`;
}

/**
 * Langsam gesprochene Nachrichten 这一类不是 Lesson 而是 Article（2026-09-26 实测）：
 * 地址是 `a-<id>`，拿 `l-<id>` 去请求，DW 回的页面里压根没有这个实体。
 */
export function articleUrl(id: string, slug = 'artikel'): string {
  return `${DW_PAGE_BASE}/de/${slug}/a-${id}`;
}

/** FR-13 L2：从粘贴的 URL 或裸 id 里抠出 lesson id（`l-<id>` 与 `a-<id>` 都认）。 */
export function parseLessonId(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  return /\/[la]-(\d+)/.exec(trimmed)?.[1] ?? null;
}

export async function fetchFeed(url: string): Promise<FeedItem[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RSS 请求失败：${res.status}`);
  return sortAndDedupe(parseFeed(await res.text()));
}

/**
 * 给了地址就只认那个地址；只给了裸 id 时先按 Lesson 拉，页面里没有这一课再按 Article 拉一次 ——
 * 光凭一个数字分不出它是哪一类。
 */
export async function fetchLesson(lessonId: string, url?: string): Promise<DwLesson> {
  if (url) return fetchPage(lessonId, url);
  try {
    return await fetchPage(lessonId, lessonUrl(lessonId));
  } catch (err) {
    if (!(err instanceof LessonNotFoundError)) throw err;
    return fetchPage(lessonId, articleUrl(lessonId));
  }
}

async function fetchPage(lessonId: string, url: string): Promise<DwLesson> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`页面请求失败：${res.status}`);
  return parseLessonPage(await res.text(), lessonId, url);
}

export class LessonNotFoundError extends Error {}

/** 抽出来是为了让快照回归测试（FR-13.11）能直接喂 HTML，不碰网络。 */
export function parseLessonPage(html: string, lessonId: string, url: string): DwLesson {
  const state = extractApolloState(html);
  // Lesson 的文稿在 `manuscript`；Article 的在 `text`（<h2> 标题 + <p> 段落），其余字段同名。
  const asLesson = state[`Lesson:${lessonId}`] as Record<string, unknown> | undefined;
  const lesson = asLesson ?? (state[`Article:${lessonId}`] as Record<string, unknown> | undefined);
  if (!lesson) throw new LessonNotFoundError(`页面里既没有 Lesson:${lessonId} 也没有 Article:${lessonId}`);

  const manuscriptHtml = String((asLesson ? lesson.manuscript : lesson.text) ?? '');
  const teaser = htmlToPlainText(String(lesson.teaser ?? ''));
  const conversion = manuscriptToText(manuscriptHtml);

  const knowledges = collectKnowledges(state, lesson.knowledges);
  const audio = findAudio(state, lesson.audios);

  const firstPublication = Date.parse(String(lesson.firstPublicationDate ?? ''));

  return {
    lessonId,
    title: String(lesson.name ?? '(无标题)'),
    sourceUrl: lesson.namedUrl ? `${DW_PAGE_BASE}${lesson.namedUrl}` : url,
    teaser,
    firstPublicationDate: Number.isNaN(firstPublication) ? undefined : firstPublication,
    plainText: conversion.text,
    manuscriptHtml,
    spans: conversion.spans,
    knowledges,
    audio,
  };
}

function collectKnowledges(state: ApolloState, refs: unknown): DwKnowledge[] {
  const keys = Array.isArray(refs)
    ? refs.map(derefKey).filter((k): k is string => k !== null)
    : findKeys(state, 'Knowledge');

  const out: DwKnowledge[] = [];
  for (const key of keys) {
    const node = state[key] as Record<string, unknown> | undefined;
    if (!node) continue;
    out.push({
      id: key.slice(key.indexOf(':') + 1),
      name: String(node.name ?? ''),
      text: htmlToPlainText(String(node.text ?? '')),
    });
  }
  return out;
}

/**
 * 优先按实体自己的 `audios` 引用顺序找：Langsam gesprochene Nachrichten 一页挂两条音频，
 * 第一条是慢速朗读（与 RSS enclosure 同一份、与文稿对应），第二条是正常语速的直播版。
 */
function findAudio(state: ApolloState, refs?: unknown): { mp3Src: string; duration: number } | undefined {
  const own = Array.isArray(refs) ? refs.map(derefKey).filter((k): k is string => k !== null) : [];
  for (const key of [...own, ...findKeys(state, 'Audio')]) {
    const node = state[key] as Record<string, unknown> | undefined;
    const src = node?.mp3Src;
    if (typeof src === 'string' && src) {
      return { mp3Src: src, duration: Number(node?.duration) || 0 };
    }
  }
  return undefined;
}

/**
 * 把 span 的**纯文本 offset** 落到具体句子上，转成 GlossaryCandidate 的句内 offset。
 * 这一步做错就是 §8 里那条「GLOSSARY span 的 offset 映射静默错位」。
 */
export interface SentenceBounds {
  index: number;
  charStart: number;
  charEnd: number;
}

export interface MappedCandidate {
  dwKnowledgeId: string;
  sentenceIndex: number;
  ranges: Array<{ start: number; end: number }>;
  surface: string;
  title: string;
  lemma?: string;
  gender?: 'm' | 'f' | 'n';
  plural?: string;
  meaning?: string;
}

export function mapSpansToSentences(
  spans: RawGlossarySpan[],
  sentences: SentenceBounds[],
  knowledges: DwKnowledge[],
): MappedCandidate[] {
  const meaningById = new Map(knowledges.map((k) => [k.id, k.text]));
  const out: MappedCandidate[] = [];

  for (const span of spans) {
    const sentence = sentences.find((s) => span.start >= s.charStart && span.end <= s.charEnd);
    // 跨句的 span（切句把它劈开了）没法安放，宁可丢掉一条候选，也不要标到错误位置上。
    if (!sentence) continue;

    const parsed = parseGlossaryTitle(span.title);
    out.push({
      dwKnowledgeId: span.dwKnowledgeId,
      sentenceIndex: sentence.index,
      ranges: [{ start: span.start - sentence.charStart, end: span.end - sentence.charStart }],
      surface: span.surface,
      title: span.title,
      ...parsed,
      meaning: meaningById.get(span.dwKnowledgeId),
    });
  }

  return out;
}

/** FR-13.5：下载 mp3，带进度。CDN 给了 Content-Length（附录 A.1）。 */
export async function downloadAudio(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`音频下载失败：${res.status}`);

  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body || !onProgress) return res.blob();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  return new Blob(chunks as BlobPart[], { type: res.headers.get('Content-Type') ?? 'audio/mpeg' });
}
