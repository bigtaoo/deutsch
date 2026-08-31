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
  /** FR-13.7：首个 <strong> 块在纯文本里的范围，以及它是否真的与 teaser 重合 */
  teaserBlock: { start: number; end: number; matchesTeaser: boolean } | null;
}

export const DW_PAGE_BASE = 'https://learngerman.dw.com';

/** 只知道 lesson id 时也能拼出页面地址：DW 接受任意 slug，靠 `l-<id>` 定位。 */
export function lessonUrl(lessonId: string, slug = 'lektion'): string {
  return `${DW_PAGE_BASE}/de/${slug}/l-${lessonId}`;
}

/** FR-13 L2：从粘贴的 URL 或裸 id 里抠出 lesson id。 */
export function parseLessonId(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  return /\/l-(\d+)/.exec(trimmed)?.[1] ?? null;
}

export async function fetchFeed(url: string): Promise<FeedItem[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RSS 请求失败：${res.status}`);
  return sortAndDedupe(parseFeed(await res.text()));
}

export async function fetchLesson(lessonId: string, url = lessonUrl(lessonId)): Promise<DwLesson> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`页面请求失败：${res.status}`);
  return parseLessonPage(await res.text(), lessonId, url);
}

/** 抽出来是为了让快照回归测试（FR-13.11）能直接喂 HTML，不碰网络。 */
export function parseLessonPage(html: string, lessonId: string, url: string): DwLesson {
  const state = extractApolloState(html);
  const lesson = state[`Lesson:${lessonId}`] as Record<string, unknown> | undefined;
  if (!lesson) throw new Error(`__APOLLO_STATE__ 里没有 Lesson:${lessonId}`);

  const manuscriptHtml = String(lesson.manuscript ?? '');
  const teaser = htmlToPlainText(String(lesson.teaser ?? ''));
  const conversion = manuscriptToText(manuscriptHtml);

  const knowledges = collectKnowledges(state, lesson.knowledges);
  const audio = findAudio(state);

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
    teaserBlock: conversion.firstStrongRange
      ? {
          ...conversion.firstStrongRange,
          // FR-13.7：判定方式不用启发式 —— 该块文本必须**包含** teaser 才算 teaser 块。
          // 不匹配就保留并提示人工确认，绝不猜。
          matchesTeaser: blockMatchesTeaser(
            conversion.text.slice(conversion.firstStrongRange.start, conversion.firstStrongRange.end),
            teaser,
          ),
        }
      : null,
  };
}

function blockMatchesTeaser(blockText: string, teaser: string): boolean {
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const block = normalize(blockText);
  const want = normalize(teaser);
  return want.length > 0 && block.includes(want);
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

function findAudio(state: ApolloState): { mp3Src: string; duration: number } | undefined {
  for (const key of findKeys(state, 'Audio')) {
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
