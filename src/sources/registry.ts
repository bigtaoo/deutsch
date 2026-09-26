// FR-13.1：内置来源常量表。
//
// 明确不做「用户自定义来源」UI —— 个人工具，加一个来源就是在这里加一行常量。
// 一个可视化的来源管理界面要处理增删改、校验、迁移，换来的是一年用一次的功能。

export interface SourceDefinition {
  id: string;
  name: string;
  feedUrl: string;
  /** adapter 标识。目前只有 dw 一种，留着是为了 §8 那条「换取数方式时只改数据来源」 */
  adapter: 'dw';
  level: string;
  note?: string;
}

export const SOURCES: SourceDefinition[] = [
  {
    id: 'dw-alltagsdeutsch',
    name: 'DW Alltagsdeutsch',
    feedUrl: 'https://rss.dw.com/xml/DKpodcast_alltagsdeutsch_de',
    adapter: 'dw',
    level: 'C1',
    note: '每周一篇，更新已放缓，靠吃存档',
  },
  {
    // 原来这里是 DW Sprachbar —— 那条 RSS 已经下线（2026-09-26 实测 `no feed by that name`），
    // 换成仍在周更、页面结构与 Alltagsdeutsch 同为 Lesson 的 Top-Thema。
    id: 'dw-topthema',
    name: 'DW Top-Thema',
    feedUrl: 'https://rss.dw.com/xml/DKpodcast_topthemamitvokabeln_de',
    adapter: 'dw',
    level: 'B1–B2',
    note: '每周两篇时事短文，带词汇表',
  },
  {
    id: 'dw-langsam',
    name: 'DW Langsam gesprochene Nachrichten',
    feedUrl: 'https://rss.dw.com/xml/DKpodcast_lgn_de',
    adapter: 'dw',
    level: 'B1–B2',
    // 页面是 Article 不是 Lesson（a-<id>），文稿在 `text`，没有词汇表；一页两条音频取慢速那条。
    note: '语速慢，适合做打点练习的热身；没有词汇表',
  },
];
