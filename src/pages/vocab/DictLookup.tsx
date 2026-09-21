// FR-9.5 查词。生词本页顶部的一块。
//
// ── 为什么在生词本里，而不是一个新页面 ──
// 「课上碰到一个词」到「这个词进了我的复习队列」是一条动线，中间只差一次查词。
// 单开一页会让这条动线跨页面，而 §12.1 的判据（「这是不是我今天要做的事」）
// 也不支持第四个活动 —— 查词是生词本这件事的入口，不是另一件事。
//
// ── 两个来源，一个答案 ──
// 内置词典离线、快、带中译；de.wiktionary 有例句、同义词、词源。用户要的是一个答案，
// 所以两边合并（规则在 src/dict/view.ts），但**来源如实标出来** ——
// 离线时看到的那份少东西，不说清会让人以为这个词就只有这么点解释。
//
// ── 内置词典先出，在线后补 ──
// 分两段渲染而不是等两边都回来：内置那份是本地的几十毫秒，在线那份要一个来回。
// 一起等的话，「查一个词典里本来就有的词」会白等半秒 —— 而这是最常走的一条路。

import { useEffect, useRef, useState } from 'react';
import { href } from '@/app/router';
import { lookupDict } from '@/dict/lookup';
import { lookupOnlineEntry, toDictEntry, type OnlineEntry } from '@/dict/online';
import { buildLookupResult, type LookupResult, type LookupSense } from '@/dict/view';
import { ensureWordAudio, speak, type WordAudioSource } from '@/dict/audio';
import { audioPlayer } from '@/audio/player';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useVocabStore } from '@/state/useVocabStore';
import { useLessonStore } from '@/state/useLessonStore';
import { syncVocabNow } from '@/sync/trigger';
import { Button, Card, Chip, Hint, Note, Section, field } from '@/components/ui';
import type { DictLookup, DictPos } from '@/dict/types';
import type { VocabEntry } from '@/types/models';

/** 德语键盘不在手边时的四个字母。查词不区分大小写（`normalizeKey` 会小写），所以不给大写。 */
const UMLAUTS = ['ä', 'ö', 'ü', 'ß'];

const POS_LABELS: Partial<Record<DictPos, string>> = {
  noun: '名词',
  verb: '动词',
  adj: '形容词',
  adv: '副词',
  ptcp: '分词',
  propn: '专有名词',
  abbr: '缩写',
  intj: '感叹词',
  num: '数词',
  prep: '介词',
  conj: '连词',
  ptcl: '小品词',
  art: '冠词',
  pron: '代词',
  letter: '字母',
  affix: '词缀',
};

const ARTICLES = { m: 'der', f: 'die', n: 'das' } as const;

type Pending<T> = T | 'loading';

export function DictLookup() {
  const { settings } = useSettingsStore();
  const { entries, findDuplicates, createFromLookup } = useVocabStore();
  const lessons = useLessonStore((s) => s.lessons);

  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [local, setLocal] = useState<Pending<DictLookup | null>>(null);
  const [online, setOnline] = useState<Pending<OnlineEntry | null> | 'off'>(null);
  const [sound, setSound] = useState<Pending<WordAudioSource> | null>(null);
  const [dupes, setDupes] = useState<VocabEntry[]>([]);
  const [added, setAdded] = useState<VocabEntry | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 只认最后一次提交的结果：连着查两个词时，先回来的那个不该覆盖后查的。 */
  const token = useRef(0);

  const submit = (raw: string) => {
    const word = raw.trim();
    if (!word) return;
    const mine = ++token.current;
    setQuery(word);
    setLocal('loading');
    setOnline(settings.onlineDictFallback ? 'loading' : 'off');
    setSound(null);
    setDupes([]);
    setAdded(null);

    void (async () => {
      const hit = await lookupDict(word).catch(() => null);
      if (token.current !== mine) return;
      setLocal(hit);
      if (!settings.onlineDictFallback) return;
      // 拿**词头**去问在线那一份，而不是用户输入的那个词形：`abgewogen` 自己那一页
      // 只有一个 Partizip 小节，例句、同义词、变形全在 `abwägen` 那一页上。
      // 代价是在线那一趟晚开始几十毫秒（要等本地查完）—— 换来的是查变形词时
      // 「详细」这件事不会凭空少掉一半，而这正是这个功能存在的理由。
      const detail = await lookupOnlineEntry(hit?.entry.w ?? word).catch(() => null);
      if (token.current === mine) setOnline(detail);
    })();
  };

  const localHit = local === 'loading' ? null : local;
  const onlineHit = online === 'loading' || online === 'off' ? null : online;
  const busy = local === 'loading';
  const result = query ? buildLookupResult(query, localHit, onlineHit) : null;

  // 去重（FR-9.3 的那一套键）：查到的词可能早就在生词本里了 ——
  // 而「加进去发现多了一张重复卡」要到复习时才会被发现。
  useEffect(() => {
    const word = result?.head;
    if (!word) {
      setDupes([]);
      return;
    }
    let cancelled = false;
    void findDuplicates(word)
      .then((list) => {
        if (!cancelled) setDupes(list);
      })
      .catch(() => {
        if (!cancelled) setDupes([]);
      });
    return () => {
      cancelled = true;
    };
    // entries 变了也要重算：刚加进去的那一条应该立刻算重复。
  }, [result?.head, findDuplicates, entries]);

  /**
   * 念一遍。走全局单例 `<audio>`（键前缀 `word:`）而不是 new Audio()：
   * §3.2 记着 iOS 只让「用户手势链」上的元素开始播放。
   */
  const play = async (word: string) => {
    setSound('loading');
    const blob = await ensureWordAudio(word).catch(() => undefined);
    if (blob) {
      setSound('human');
      await audioPlayer.load(`word:${word}`, blob);
      await audioPlayer.play(0).catch(() => {});
      return;
    }
    setSound(speak(word) ? 'tts' : 'none');
  };

  const add = async () => {
    if (!result) return;
    const dict = localHit?.entry ?? (onlineHit ? toDictEntry(onlineHit) : null);
    // FR-21.6：例句一并收下 —— 在线那一趟已经拿到了，开读卡时它多半不在了
    const entry = await createFromLookup({ surface: result.head, dict, examples: result.examples });
    setAdded(entry);
    // 不可重建的数据不过夜（FR-11.6）。失败也不用管：进队列，由状态芯片报出来。
    void syncVocabNow();
  };

  return (
    <Section title="查词">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <input
          ref={inputRef}
          className={`${field} min-w-0 flex-1 px-3 py-2`}
          placeholder="课上碰到的词，原样输入（Plattformen 也行）"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        <Button type="submit" variant="primary" disabled={!draft.trim()}>
          查
        </Button>
        {/* 变音字母：手机上的中英键盘打不出 ä ö ü ß，而这是德语查词的主路径之一。
            追加在末尾而不是插在光标处：这是个短查询框，从左到右打完就完了。 */}
        <div className="flex gap-1">
          {UMLAUTS.map((ch) => (
            <Button
              key={ch}
              type="button"
              className="px-2"
              onClick={() => {
                setDraft((d) => d + ch);
                inputRef.current?.focus();
              }}
            >
              {ch}
            </Button>
          ))}
        </div>
      </form>

      {!query && (
        <Hint>
          先查内置词典（离线也能查），再向 de.wiktionary 补例句、同义词和词源。
          查到的词可以直接加进生词本。
        </Hint>
      )}

      {busy && <Note tone="accent">查询中…</Note>}

      {!busy && query && !result && (
        <NotFound
          query={query}
          onlineState={online}
          onAdd={() => void add()}
          added={added}
          dupes={dupes}
          lessons={lessons}
        />
      )}

      {!busy && result && (
        <ResultCard
          result={result}
          online={online}
          sound={sound}
          onPlay={() => void play(result.head)}
          onAdd={() => void add()}
          added={added}
          dupes={dupes}
          lessons={lessons}
        />
      )}
    </Section>
  );
}

function ResultCard({
  result,
  online,
  sound,
  onPlay,
  onAdd,
  added,
  dupes,
  lessons,
}: {
  result: LookupResult;
  online: Pending<OnlineEntry | null> | 'off';
  sound: Pending<WordAudioSource> | null;
  onPlay: () => void;
  onAdd: () => void;
  added: VocabEntry | null;
  dupes: VocabEntry[];
  lessons: Array<{ id: string; title: string }>;
}) {
  const first = result.senses[0];
  const article = first?.gender ? ARTICLES[first.gender] : undefined;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-word font-semibold">
          {article && <span className="mr-1 text-muted">{article}</span>}
          {result.head}
        </p>
        {first?.ipa && <span className="text-ui text-faint">[{first.ipa}]</span>}
        <Button className="ml-auto" onClick={onPlay}>
          🔊 念一遍
        </Button>
      </div>

      {sound && (
        <Hint tone={sound === 'none' ? 'warn' : 'neutral'}>
          {sound === 'loading'
            ? '取发音中…'
            : sound === 'human'
              ? '真人录音（Wiktionary，CC BY-SA）· 孤立词发音，练不到连读'
              : sound === 'tts'
                ? '系统合成音（Wiktionary 上没有这个词的录音）'
                : 'Wiktionary 上没有录音，系统里也没有德语嗓音 —— 这个词现在没有声音。'}
        </Hint>
      )}

      {result.viaForm && (
        <Note>
          你查的是 <b>{result.query}</b>，词头是 <b>{result.head}</b>。
        </Note>
      )}

      <ul className="space-y-3">
        {result.senses.map((sense, i) => (
          <SenseBlock key={i} sense={sense} head={result.head} />
        ))}
      </ul>

      {result.examples.length > 0 && (
        <div className="space-y-1 border-t border-line pt-3">
          <p className="text-note text-faint">例句</p>
          {result.examples.map((ex) => (
            <p key={ex} className="text-de">
              {ex}
            </p>
          ))}
        </div>
      )}

      {(result.synonyms.length > 0 || result.antonyms.length > 0) && (
        <div className="space-y-1 border-t border-line pt-3">
          {result.synonyms.length > 0 && (
            <p className="text-ui">
              <span className="mr-2 text-note text-faint">近义</span>
              {result.synonyms.join('、')}
            </p>
          )}
          {result.antonyms.length > 0 && (
            <p className="text-ui">
              <span className="mr-2 text-note text-faint">反义</span>
              {result.antonyms.join('、')}
            </p>
          )}
        </div>
      )}

      {result.origin && (
        <div className="space-y-1 border-t border-line pt-3">
          <p className="text-note text-faint">词源</p>
          <p className="text-ui text-muted">{result.origin}</p>
        </div>
      )}

      {/* 来源如实写出来：在线那一份没回来的时候，缺的正是例句/同义词/词源那几段，
          不说清会让人以为这个词就只有这么点解释。 */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-note text-faint">
        <span>
          {result.from.builtin ? '内置词典' : 'de.wiktionary'}
          {result.from.builtin && result.from.online && ' + de.wiktionary'}
        </span>
        {online === 'loading' && <span>· 正在向 de.wiktionary 补例句…</span>}
        {online === 'off' && <span>· 联网查已在设置里关掉</span>}
        {online === null && result.from.builtin && <span>· de.wiktionary 没回应（离线？）</span>}
        <a className="underline" href={result.url} target="_blank" rel="noreferrer noopener">
          在维基词典打开
        </a>
      </div>

      <AddRow onAdd={onAdd} added={added} dupes={dupes} lessons={lessons} word={result.head} />
    </Card>
  );
}

function SenseBlock({ sense, head }: { sense: LookupSense; head: string }) {
  const meta = [
    sense.posLabel ?? (sense.pos ? POS_LABELS[sense.pos] : undefined),
    sense.gender ? ARTICLES[sense.gender] : undefined,
    sense.plural ? `复数 ${[sense.plural, ...(sense.plural2 ?? [])].join(' / ')}` : undefined,
  ].filter(Boolean) as string[];

  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {/* 义项自己的词头只在与记录级不同时才有（`Laufen` 名词 / `laufen` 动词）——
            不显示出来的话，查 `läuft` 看到的词头会像是查错了词。 */}
        {sense.head && sense.head !== head && <span className="text-ui font-medium">{sense.head}</span>}
        {meta.map((m) => (
          <Chip key={m}>{m}</Chip>
        ))}
      </div>
      {/* 动词的 Partizip II / 形容词的比较级。单独一行而不是挤进上面那排 Chip：
          它可能有三段（`Präteritum: … , Partizip II: … , …`）。 */}
      {sense.forms && <p className="text-note text-muted">{sense.forms}</p>}
      {/* 德语释义在前、中英跟后：FR-14 与 FR-16.3 是同一个结论 ——
          德德释义对 C1 比中文有用，而中文一个都不给才是真的不方便。 */}
      {sense.de.map((d) => (
        <p key={d} className="text-ui">
          {d}
        </p>
      ))}
      {sense.zh.length > 0 && <p className="text-ui text-muted">{sense.zh.join('、')}</p>}
      {sense.en.length > 0 && <p className="text-note text-muted">{sense.en.join(', ')}</p>}
      {sense.de.length === 0 && sense.zh.length === 0 && sense.en.length === 0 && (
        <p className="text-ui text-faint">（这一条只有读音和词形，没有释义）</p>
      )}
    </li>
  );
}

function NotFound({
  query,
  onlineState,
  onAdd,
  added,
  dupes,
  lessons,
}: {
  query: string;
  onlineState: Pending<OnlineEntry | null> | 'off';
  onAdd: () => void;
  added: VocabEntry | null;
  dupes: VocabEntry[];
  lessons: Array<{ id: string; title: string }>;
}) {
  // navigator.onLine 只用来选一句话怎么说：它会误报（连着 WiFi 但没有出口），
  // 但「查不到」和「没网」这两件事对用户的下一步完全不同，说错一次也比不说好。
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return (
    <Card className="space-y-2 p-4">
      <p className="text-ui">
        没查到 <b>{query}</b>。
      </p>
      <Hint>
        {onlineState === 'off'
          ? '只查了内置词典 —— 联网查 de.wiktionary 在设置里关掉了。'
          : onlineState === 'loading'
            ? '内置词典里没有，正在问 de.wiktionary…'
            : offline
              ? '内置词典里没有，而现在看起来没有网络 —— 联网之后再试一次。'
              : '内置词典和 de.wiktionary 都没有。多词搭配和很生僻的复合词常常是这样。'}
      </Hint>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <a
          className="text-ui underline"
          href={`https://de.wiktionary.org/w/index.php?search=${encodeURIComponent(query)}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          在维基词典里搜
        </a>
      </div>
      <AddRow onAdd={onAdd} added={added} dupes={dupes} lessons={lessons} word={query} noDict />
    </Card>
  );
}

/** 「加入生词本」那一行：去重提示、加、加完之后的出口。 */
function AddRow({
  onAdd,
  added,
  dupes,
  lessons,
  word,
  noDict = false,
}: {
  onAdd: () => void;
  added: VocabEntry | null;
  dupes: VocabEntry[];
  lessons: Array<{ id: string; title: string }>;
  word: string;
  noDict?: boolean;
}) {
  if (added) {
    return (
      <Note tone="ok">
        <b>{added.surface}</b> 已加进生词本，作为新卡进入复习队列（声音是孤立词发音）。
        {noDict && ' 没有释义 —— 在下面的列表里编辑补上。'}
      </Note>
    );
  }

  // FR-9.3：命中已有词条时**不新建**。这里没有句子可挖空，所以「合并」无事可做，
  // 而「仍然新建」只会多出一张同一个词的卡 —— 两张卡的 FSRS 状态各自漂移。
  if (dupes.length > 0) {
    const e = dupes[0];
    const from = e.preset
      ? `预置词库第 ${e.preset.band} 档`
      : e.lookup
        ? '查词加进来的'
        : lessons.find((l) => l.id === e.lessonId)?.title
          ? `《${lessons.find((l) => l.id === e.lessonId)!.title}》`
          : '一课已删除的课程';
    return (
      <Note tone="accent" action={<a className="underline" href={href({ name: 'review' })}>去复习</a>}>
        生词本里已经有 <b>{e.surface}</b> 了（{from}）。
      </Note>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" onClick={onAdd}>
        加入生词本
      </Button>
      <Hint>
        {noDict
          ? `照原样收下「${word}」，释义自己填。`
          : '作为新卡进入复习。它不来自任何一课，所以声音是孤立词发音，练不到连读。'}
      </Hint>
    </div>
  );
}
