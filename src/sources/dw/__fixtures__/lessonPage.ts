// FR-13.11 的快照回归固件：DW 页面的**结构**快照。
//
// §3.1.1 R-5：仓库里不含任何一句真实 Manuskript。下面的德语句子全是为测试自造的，
// 只保留结构 —— `window.__APOLLO_STATE__=` 的内联形式、Lesson/Audio/Knowledge 三类实体、
// manuscript 里只用 <p> <strong> <br /> <span> 四种标签、GLOSSARY span 的属性组合。
//
// DW 改版时这份固件不会自己变红，但配套的测试会在结构假设被破坏时立刻失败 ——
// 前提是有人跑一次真实抓取并更新固件。这就是「测试先红」能给到的最大保障。

export const FIXTURE_LESSON_ID = '90000001';

/** 故意在字符串里塞进 `{`、`}` 和转义引号，用来验证大括号配平扫描器（§7.8）。 */
export const FIXTURE_PAGE_HTML = `<!DOCTYPE html><html><head><title>Testseite</title></head>
<body>
<div id="app"></div>
<script>window.__APOLLO_STATE__={"ROOT_QUERY":{"__typename":"Query","hinweis":"Ein Text mit { Klammern } und \\"Anführungszeichen\\"."},"Lesson:90000001":{"__typename":"Lesson","id":90000001,"name":"Testfolge: Der erfundene Wald","namedUrl":"/de/testfolge-der-erfundene-wald/l-90000001","firstPublicationDate":"2019-04-02T13:00:47.203Z","teaser":"Ein erfundener Anreißer über einen Wald, der nur im Test existiert.","manuscript":"<p><strong>Testfolge: Der erfundene Wald<br />Ein erfundener Anreißer über einen Wald, der nur im Test existiert.</strong></p><p>Der Wald im Test ist groß. Viele <span class=\\"editable placeholder\\" data-fromselection=\\"true\\" data-id=\\"90100001\\" data-title=\\"Plattform, -en (f.)\\" data-type=\\"GLOSSARY\\" title=\\"Glosar\\">Plattformen</span> versprechen Ruhe.<br />Am 3. Oktober war es dort still.</p><p>Wer dort <span class=\\"editable placeholder\\" data-id=\\"90100002\\" data-title=\\"surfen\\" data-type=\\"GLOSSARY\\" title=\\"Glosar\\">surft</span>, hört nur Wind. Es hing von der Jahreszeit ab, sagte z. B. Dr. Meier.</p>","knowledges":[{"__ref":"Knowledge:90100001"},{"__ref":"Knowledge:90100002"}],"mainContentAudio":{"__ref":"Audio:90200001"},"dkLearningLevel":32},"Audio:90200001":{"__typename":"Audio","id":90200001,"mp3Src":"https://example.invalid/testfolge.mp3","duration":376,"formattedDuration":"06:16"},"Knowledge:90100001":{"__typename":"Knowledge","id":90100001,"knowledgeType":"GLOSSARY","name":"Plattform, -en (f.)","text":"<p>eine erfundene Erklärung für den Test</p>"},"Knowledge:90100002":{"__typename":"Knowledge","id":90100002,"knowledgeType":"GLOSSARY","name":"surfen","text":"<p>eine zweite erfundene Erklärung</p>"}};</script>
</body></html>`;

/** RSS 固件。同样是自造标题与摘要，只保留字段结构（附录 A.2）。 */
export const FIXTURE_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>Testkanal</title>
  <item>
    <guid isPermaLink="false">90000001</guid>
    <pubDate>Tue, 25 Aug 2026 07:36:00 GMT</pubDate>
    <title>Testfolge: Der erfundene Wald</title>
    <link>https://learngerman.dw.com/de/testfolge-der-erfundene-wald/l-90000001?maca=de-DKpodcast-2283-xml-mrss</link>
    <description>Ein erfundener Anreißer.</description>
    <itunes:duration>06:16</itunes:duration>
    <enclosure url="https://example.invalid/testfolge.mp3" type="audio/mpeg" length="7117421"/>
  </item>
  <item>
    <guid isPermaLink="false">90000002</guid>
    <pubDate>Tue, 18 Aug 2026 07:36:00 GMT</pubDate>
    <title>Testfolge: Die zweite Erfindung</title>
    <link>https://learngerman.dw.com/de/testfolge-die-zweite-erfindung/l-90000002</link>
    <itunes:duration>05:00</itunes:duration>
    <enclosure url="https://example.invalid/zweite.mp3" type="audio/mpeg" length="5000000"/>
  </item>
</channel>
</rss>`;
