// §7.8 的关键实现约束：manuscript → 纯文本**必须同步维护 offset 映射**。
//
// 正文里的 GLOSSARY span 携带 FR-14 需要的位置信息，而 FR-2 切句、Sentence.charStart、
// Blank.ranges 全都基于纯文本 offset。用 innerText 一把梭会把位置信息丢掉，
// 于是候选词标到错误的位置上 —— 而且是**静默错位**，肉眼很难发现。
//
// 转换规则：<br /> → \n；</p> → \n\n；HTML 实体交给 DOMParser 解码
// （德语引号 „…" 会进入 §7.1 的 R-quote 规则，解码错了切句跟着错）。

export interface RawGlossarySpan {
  dwKnowledgeId: string;
  /** data-title 原文，如 `Plattform, -en (f.)`；解析失败时降级保留（FR-14.4） */
  title: string;
  surface: string;
  /** 在纯文本中的 offset */
  start: number;
  end: number;
}

export interface ManuscriptConversion {
  text: string;
  spans: RawGlossarySpan[];
  /** 首个 <strong> 块在纯文本中的范围 —— FR-13.7 判定非朗读的 teaser 块用 */
  firstStrongRange: { start: number; end: number } | null;
}

export function manuscriptToText(html: string): ManuscriptConversion {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = doc.getElementById('root');

  let text = '';
  const spans: RawGlossarySpan[] = [];
  let firstStrongRange: { start: number; end: number } | null = null;

  const walk = (node: Node): void => {
    if (node.nodeType === 3 /* Text */) {
      text += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== 1 /* Element */) return;

    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (tag === 'br') {
      text += '\n';
      return;
    }

    const start = text.length;
    for (const child of Array.from(el.childNodes)) walk(child);
    const end = text.length;

    if (tag === 'p') text += '\n\n';

    if (tag === 'strong' && firstStrongRange === null && text.slice(start, end).trim().length > 0) {
      firstStrongRange = { start, end };
    }

    if (tag === 'span' && el.getAttribute('data-type') === 'GLOSSARY') {
      const id = el.getAttribute('data-id');
      if (id) {
        spans.push({
          dwKnowledgeId: id,
          title: el.getAttribute('data-title') ?? '',
          surface: text.slice(start, end),
          start,
          end,
        });
      }
    }
  };

  if (root) for (const child of Array.from(root.childNodes)) walk(child);

  // 只砍首尾空白，并把 offset 整体前移 —— 中间的多余空行留着不碍事（切句本来就跳过空行），
  // 而在中间做任何删减都要同步修正每一个已记录的 offset，那正是这里最容易出错的地方。
  const leading = text.length - text.trimStart().length;
  const trimmed = text.trim();

  return {
    text: trimmed,
    spans: spans.map((s) => ({ ...s, start: s.start - leading, end: s.end - leading })),
    firstStrongRange: firstStrongRange
      ? {
          start: (firstStrongRange as { start: number; end: number }).start - leading,
          end: (firstStrongRange as { start: number; end: number }).end - leading,
        }
      : null,
  };
}

/** 释义字段 `Knowledge.text` 也是 HTML，但它不需要 offset，转成纯文本即可。 */
export function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  return (doc.getElementById('root')?.textContent ?? '').replace(/\s+/g, ' ').trim();
}
