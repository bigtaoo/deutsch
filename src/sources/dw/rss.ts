// FR-13.2 / FR-13.3：拉取 RSS，解析期次列表。
//
// FR-13.3 是这里唯一容易搞错的地方：**排序与去重按 `firstPublicationDate`，不按 `pubDate`**。
// DW 在把 2019 年的旧期以当周日期重新推送（附录 A.2），拿 pubDate 排序会让「最新」全是老内容。
// 但 RSS 里**没有** firstPublicationDate —— 它只在页面的 __APOLLO_STATE__ 里。
// 所以列表阶段先用 pubDate 排，抓过页面之后用真实首发日期覆盖并重排（见 adapter.ts）。

export interface FeedItem {
  /** = lesson id = <guid> = URL 里的 l-<id>，FR-13.8 的主键 */
  lessonId: string;
  title: string;
  link: string;
  /** RSS 给的推送日期，**不是**首发日期 */
  pubDate: number;
  /** 抓过页面之后才知道的真实首发日期 */
  firstPublicationDate?: number;
  durationText?: string;
  enclosureUrl?: string;
  enclosureBytes?: number;
}

export function parseFeed(xml: string): FeedItem[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('RSS 不是合法 XML');

  const items: FeedItem[] = [];
  for (const node of Array.from(doc.querySelectorAll('item'))) {
    const guid = node.querySelector('guid')?.textContent?.trim();
    const link = node.querySelector('link')?.textContent?.trim() ?? '';
    // guid 缺失时退回从 link 里抠 l-<id>：主键不能没有。
    const lessonId = guid || /\/l-(\d+)/.exec(link)?.[1] || '';
    if (!lessonId) continue;

    const enclosure = node.querySelector('enclosure');
    const pubDateText = node.querySelector('pubDate')?.textContent ?? '';
    const parsedPubDate = Date.parse(pubDateText);

    items.push({
      lessonId,
      title: node.querySelector('title')?.textContent?.trim() ?? '(无标题)',
      link,
      pubDate: Number.isNaN(parsedPubDate) ? 0 : parsedPubDate,
      // itunes:duration 带命名空间，querySelector 在 XML 文档里要用 escape 过的写法，
      // 直接按 localName 找更稳。
      durationText: findByLocalName(node, 'duration'),
      enclosureUrl: enclosure?.getAttribute('url') ?? undefined,
      enclosureBytes: Number(enclosure?.getAttribute('length')) || undefined,
    });
  }
  return items;
}

function findByLocalName(item: Element, localName: string): string | undefined {
  for (const child of Array.from(item.children)) {
    if (child.localName === localName) return child.textContent?.trim() || undefined;
  }
  return undefined;
}

/** FR-13.3：知道真实首发日期就用它排，不知道的退回 pubDate。同一 lessonId 只留一条。 */
export function sortAndDedupe(items: FeedItem[]): FeedItem[] {
  const byId = new Map<string, FeedItem>();
  for (const item of items) {
    const existing = byId.get(item.lessonId);
    if (!existing || sortKey(item) > sortKey(existing)) byId.set(item.lessonId, item);
  }
  return [...byId.values()].sort((a, b) => sortKey(b) - sortKey(a));
}

function sortKey(item: FeedItem): number {
  return item.firstPublicationDate ?? item.pubDate;
}
