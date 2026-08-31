// FR-13.11：每个来源配一份 __APOLLO_STATE__ 快照回归测试。
// DW 改版时**测试先红**，而不是某天用的时候才发现。

import { describe, it, expect } from 'vitest';
import { extractApolloState, ApolloParseError, findKeys } from './apolloState';
import { manuscriptToText, htmlToPlainText } from './htmlToText';
import { parseGlossaryTitle } from './glossary';
import { parseFeed, sortAndDedupe } from './rss';
import { mapSpansToSentences, parseLessonPage, parseLessonId, lessonUrl } from './adapter';
import { segmentSentences } from '@/lesson/segment';
import { createSentences } from '@/lesson/sentences';
import { FIXTURE_FEED_XML, FIXTURE_LESSON_ID, FIXTURE_PAGE_HTML } from './__fixtures__/lessonPage';

describe('extractApolloState', () => {
  it('从内联 JS 里截出对象并解析', () => {
    const state = extractApolloState(FIXTURE_PAGE_HTML);
    expect(Object.keys(state)).toContain(`Lesson:${FIXTURE_LESSON_ID}`);
    expect(findKeys(state, 'Audio')).toEqual(['Audio:90200001']);
    expect(findKeys(state, 'Knowledge')).toHaveLength(2);
  });

  it('字符串里的大括号和转义引号不会骗到配平扫描', () => {
    const state = extractApolloState(FIXTURE_PAGE_HTML);
    const root = state.ROOT_QUERY as { hinweis: string };
    expect(root.hinweis).toContain('{ Klammern }');
    expect(root.hinweis).toContain('"Anführungszeichen"');
  });

  it('找不到 marker 时抛出说明改版的错误，而不是返回空对象', () => {
    expect(() => extractApolloState('<html></html>')).toThrow(ApolloParseError);
  });

  it('大括号没配平时抛错', () => {
    expect(() => extractApolloState('<script>window.__APOLLO_STATE__={"a":1</script>')).toThrow(ApolloParseError);
  });
});

describe('manuscriptToText', () => {
  const lesson = parseLessonPage(FIXTURE_PAGE_HTML, FIXTURE_LESSON_ID, 'https://example.invalid/x');

  it('<br /> → 换行，</p> → 空行', () => {
    expect(lesson.plainText).toContain('Der erfundene Wald\nEin erfundener');
    expect(lesson.plainText).toContain('\n\n');
  });

  it('GLOSSARY span 的 offset 精确指回纯文本（§7.8 的关键约束）', () => {
    expect(lesson.spans).toHaveLength(2);
    for (const span of lesson.spans) {
      expect(lesson.plainText.slice(span.start, span.end)).toBe(span.surface);
    }
    expect(lesson.spans.map((s) => s.surface)).toEqual(['Plattformen', 'surft']);
  });

  it('实体被解码成真正的字符', () => {
    const converted = manuscriptToText('<p>Er sagte: &bdquo;Ja&ldquo; &ndash; und ging.</p>');
    expect(converted.text).toBe('Er sagte: „Ja“ – und ging.');
  });

  it('htmlToPlainText 去掉标签并折叠空白', () => {
    expect(htmlToPlainText('<p>eine   Erklärung</p>')).toBe('eine Erklärung');
  });
});

describe('parseLessonPage', () => {
  const lesson = parseLessonPage(FIXTURE_PAGE_HTML, FIXTURE_LESSON_ID, 'https://example.invalid/x');

  it('取到标题、真实首发日期、音频直链与时长', () => {
    expect(lesson.title).toBe('Testfolge: Der erfundene Wald');
    // 附录 A.2：firstPublicationDate 与 pubDate 是两回事，排序必须用前者
    expect(new Date(lesson.firstPublicationDate!).getUTCFullYear()).toBe(2019);
    expect(lesson.audio).toEqual({ mp3Src: 'https://example.invalid/testfolge.mp3', duration: 376 });
  });

  it('sourceUrl 用 namedUrl 拼，不用带 ?maca= 的 RSS link', () => {
    expect(lesson.sourceUrl).toBe('https://learngerman.dw.com/de/testfolge-der-erfundene-wald/l-90000001');
  });

  it('knowledges 顺着 __ref 取到释义纯文本', () => {
    expect(lesson.knowledges.map((k) => k.name)).toEqual(['Plattform, -en (f.)', 'surfen']);
    expect(lesson.knowledges[0].text).toBe('eine erfundene Erklärung für den Test');
  });

  it('FR-13.7：首个 <strong> 块含 teaser → 判定为非朗读块', () => {
    expect(lesson.teaserBlock?.matchesTeaser).toBe(true);
    expect(lesson.plainText.slice(lesson.teaserBlock!.start, lesson.teaserBlock!.end)).toContain('erfundener Anreißer');
  });

  it('teaser 对不上时不猜：matchesTeaser=false，留给人工确认', () => {
    const altered = FIXTURE_PAGE_HTML.replace(
      '"teaser":"Ein erfundener Anreißer über einen Wald, der nur im Test existiert."',
      '"teaser":"Ein völlig anderer Anreißer."',
    );
    const parsed = parseLessonPage(altered, FIXTURE_LESSON_ID, 'https://example.invalid/x');
    expect(parsed.teaserBlock?.matchesTeaser).toBe(false);
  });

  it('lesson id 对不上时报错而不是静默返回空课程', () => {
    expect(() => parseLessonPage(FIXTURE_PAGE_HTML, '123', 'x')).toThrow(/没有 Lesson:123/);
  });
});

describe('切句 + 候选词落位（端到端）', () => {
  const lesson = parseLessonPage(FIXTURE_PAGE_HTML, FIXTURE_LESSON_ID, 'https://example.invalid/x');
  const sentences = createSentences(segmentSentences(lesson.plainText));

  it('FR-13.6：自动导入只是替 FR-1.2/1.3 填数据，切句规则照常生效', () => {
    const texts = sentences.map((s) => s.text);
    expect(texts.some((t) => t.includes('Am 3. Oktober war es dort still.'))).toBe(true);
    expect(texts.some((t) => t.includes('z. B. Dr. Meier'))).toBe(true);
  });

  it('候选词落到正确的句子，句内 offset 切出来正是那个词', () => {
    const candidates = mapSpansToSentences(lesson.spans, sentences, lesson.knowledges);
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      const sentence = sentences[candidate.sentenceIndex];
      const range = candidate.ranges[0];
      expect(sentence.text.slice(range.start, range.end)).toBe(candidate.surface);
    }
  });

  it('FR-14.3：性、复数、释义一并填好', () => {
    const [plattform] = mapSpansToSentences(lesson.spans, sentences, lesson.knowledges);
    expect(plattform.lemma).toBe('Plattform');
    expect(plattform.gender).toBe('f');
    expect(plattform.plural).toBe('-en');
    expect(plattform.meaning).toBe('eine erfundene Erklärung für den Test');
  });

  it('落不进任何句子的 span 被丢弃，不会标到错误位置', () => {
    const bogus = [{ dwKnowledgeId: 'x', title: '', surface: 'weg', start: 99999, end: 100003 }];
    expect(mapSpansToSentences(bogus, sentences, [])).toEqual([]);
  });
});

describe('parseGlossaryTitle（FR-14.4 降级）', () => {
  it('标准名词', () => {
    expect(parseGlossaryTitle('Plattform, -en (f.)')).toEqual({ lemma: 'Plattform', gender: 'f', plural: '-en' });
    expect(parseGlossaryTitle('Gelegenheitsjob, -s (m.)')).toEqual({ lemma: 'Gelegenheitsjob', gender: 'm', plural: '-s' });
  });

  it('动词：无性无复数', () => {
    expect(parseGlossaryTitle('surfen')).toEqual({ lemma: 'surfen', gender: undefined });
  });

  it('括号里是来源说明而非性', () => {
    expect(parseGlossaryTitle('Down Under (aus dem Englischen)')).toEqual({
      lemma: 'Down Under',
      gender: undefined,
    });
  });

  it('性混在一串说明里也能认出来', () => {
    expect(parseGlossaryTitle('Great Ocean Road (f., nur Singular, aus dem Englischen)')).toEqual({
      lemma: 'Great Ocean Road',
      gender: 'f',
    });
  });

  it('完全认不出时返回空对象，调用方只填 surface', () => {
    expect(parseGlossaryTitle('')).toEqual({});
  });
});

describe('RSS', () => {
  const items = parseFeed(FIXTURE_FEED_XML);

  it('guid = lesson id，取到 enclosure 与 itunes:duration', () => {
    expect(items).toHaveLength(2);
    expect(items[0].lessonId).toBe('90000001');
    expect(items[0].durationText).toBe('06:16');
    expect(items[0].enclosureUrl).toBe('https://example.invalid/testfolge.mp3');
    expect(items[0].enclosureBytes).toBe(7117421);
  });

  it('FR-13.3：有 firstPublicationDate 就按它排，pubDate 只是兜底', () => {
    const withReal = [
      { ...items[0], firstPublicationDate: Date.parse('2019-04-02T13:00:00Z') },
      { ...items[1], firstPublicationDate: Date.parse('2026-01-01T00:00:00Z') },
    ];
    // 按 pubDate 排，第一条更新；按真实首发日期排，第二条才是新的
    expect(sortAndDedupe(items)[0].lessonId).toBe('90000001');
    expect(sortAndDedupe(withReal)[0].lessonId).toBe('90000002');
  });

  it('同一 lessonId 只留一条（DW 重推旧期）', () => {
    expect(sortAndDedupe([...items, items[0]])).toHaveLength(2);
  });
});

describe('parseLessonId（L2 半自动入口）', () => {
  it('接受完整 URL、带跟踪参数的 URL 和裸 id', () => {
    expect(parseLessonId('https://learngerman.dw.com/de/x/l-45334084?maca=de-x')).toBe('45334084');
    expect(parseLessonId('45334084')).toBe('45334084');
    expect(parseLessonId(' 45334084 ')).toBe('45334084');
  });

  it('认不出时返回 null', () => {
    expect(parseLessonId('https://example.com/keine-lektion')).toBeNull();
  });

  it('只知道 id 也能拼出页面地址', () => {
    expect(lessonUrl('45334084')).toBe('https://learngerman.dw.com/de/lektion/l-45334084');
  });
});
