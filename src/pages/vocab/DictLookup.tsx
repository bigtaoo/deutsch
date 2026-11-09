// FR-9.5 查词。单词页（§12.21）的一块。
//
// 变更 84：生词本列表与复习撤掉，「加入生词本」随之去掉 —— 查到的词只有一个去处：
// 「加入速背」（FR-22.10，进每天 200 个的新词前排）。AI 解释原样保留。
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
import { lookupDict } from '@/dict/lookup';
import { lookupOnlineEntry, type OnlineEntry } from '@/dict/online';
import { buildLookupResult, type LookupResult, type LookupSense } from '@/dict/view';
import { ensureWordAudio, speak, type WordAudioSource } from '@/dict/audio';
import { audioPlayer } from '@/audio/player';
import { aiAvailable, explainWithAi, getCachedAiNote } from '@/ai/explain';
import { useSettingsStore } from '@/state/useSettingsStore';
import { Button, Card, Chip, Hint, Note, Section, field } from '@/components/ui';
import type { DictLookup, DictPos } from '@/dict/types';
import { AddToDrill } from '../drill/AddToDrill';

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

/**
 * FR-9.11/9.12 的 AI 状态：查不到词时自动问一次，查到的词是按钮入口，两条路共用同一个状态。
 * **不能用 `string | 'unavailable'`** —— `'unavailable'` 本身就是一个字符串，
 * `typeof x === 'string'` 分不出它是哨兵值还是 AI 真的给的解释，一次 `add()` 就会把
 * 字面量 `"unavailable"` 当成解释存进 `note`（2026-09-22 修，e2e 抓到的）。
 * 成功的那一支包一层对象，就没有这个歧义了。
 */
type AiState = 'loading' | 'unavailable' | { note: string };

export function DictLookup() {
  const { settings } = useSettingsStore();

  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [local, setLocal] = useState<Pending<DictLookup | null>>(null);
  const [online, setOnline] = useState<Pending<OnlineEntry | null> | 'off'>(null);
  const [sound, setSound] = useState<Pending<WordAudioSource> | null>(null);
  /**
   * FR-9.11/9.12：查不到词时自动问一次 AI；查到的词也给一个「问 AI」入口（变更 49，
   * 之前只有查不到那一支有）。`null` = 还没有答案（查到的词等按钮点，查不到的词等自动问
   * 或缓存命中）；'unavailable' 盖住「没登录」「服务器没配 key」「上游失败」这几种原因 ——
   * 用户能做的事一样，都是过会儿再试。
   */
  const [aiState, setAiState] = useState<AiState | null>(null);
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
    setAiState(null);

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
  const resultHead = result?.head;

  /**
   * 问一次 AI（按钮点击、或下面那个 effect 判定「查不到」之后自动调用）。
   * 用 `token` 而不是自己的 `cancelled` 变量把控失效 —— 这是一次可能由用户手动
   * 触发的请求，生命周期跟“这次提交”绑在一起，而不是跟某个 effect 的一轮执行绑在一起。
   */
  const runAskAi = (word: string) => {
    const mine = token.current;
    setAiState('loading');
    void (async () => {
      if (!(await aiAvailable())) {
        if (token.current === mine) setAiState('unavailable');
        return;
      }
      try {
        const note = await explainWithAi({ word });
        if (token.current === mine) setAiState({ note });
      } catch {
        if (token.current === mine) setAiState('unavailable');
      }
    })();
  };

  /**
   * 变更 49：先看有没有缓存过的答案 —— 不管这个词查没查到，缓存命中就直接显示，
   * 不用再问一遍模型。没有缓存时，查不到词的那一支照旧自动问一次 AI（FR-9.11）；
   * 查到词的那一支不自动问，等用户点「问 AI」——查到的词已经有内容了，自动问一次
   * 会让每次查一个查到过的词都白花一次调用。
   *
   * 依赖用 `resultHead` 而不是 `result` 本身：`buildLookupResult` 每次渲染都会
   * 返回一个新对象，用 `result` 当依赖会让 setAiState 触发的重渲染又把这个 effect
   * 跑一遍，形成死循环（`result?.head` 才是真正变了没变的信号，去重那个 effect
   * 已经是这么写的）。
   */
  useEffect(() => {
    if (busy || !query) return;
    let cancelled = false;
    void (async () => {
      const cached = await getCachedAiNote(query);
      if (cancelled) return;
      if (cached !== undefined) {
        setAiState({ note: cached });
        return;
      }
      // 「尘埃落定」= 本地已经查完且在线不再是 'loading' —— 在线还没回来的时候
      // 不能提前判「查不到」，那时 resultHead 是 undefined 只是因为还没等到在线那一份。
      if (resultHead || online === 'loading') return;
      runAskAi(query);
    })();
    return () => {
      cancelled = true;
    };
    // runAskAi 没放进依赖数组：它每次渲染都是新的函数引用，但内部只读 query（闭包变量）
    // 且靠 token 自己控制失效，放进依赖只会让这个 effect 在无关的重渲染上多跑几次。
  }, [busy, query, resultHead, online]);

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
          查到的词可以直接加进速背。
        </Hint>
      )}

      {busy && <Note tone="accent">查询中…</Note>}

      {!busy && query && !result && (
        <NotFound
          query={query}
          onlineState={online}
          aiState={aiState}
          onAskAi={() => runAskAi(query)}
        />
      )}

      {!busy && result && (
        <ResultCard
          result={result}
          online={online}
          sound={sound}
          aiState={aiState}
          onAskAi={() => runAskAi(result.head)}
          onPlay={() => void play(result.head)}
        />
      )}
    </Section>
  );
}

function ResultCard({
  result,
  online,
  sound,
  aiState,
  onAskAi,
  onPlay,
}: {
  result: LookupResult;
  online: Pending<OnlineEntry | null> | 'off';
  sound: Pending<WordAudioSource> | null;
  aiState: AiState | null;
  onAskAi: () => void;
  onPlay: () => void;
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

      {/* 变更 49：查到的词以前完全没有 AI 入口——词典给的释义再详细，也不是每个词都够，
          尤其是搭配和语用层面的细节。缓存命中时不用点就直接显示（见上面那个 effect）。 */}
      <AiBlock aiState={aiState} onAsk={onAskAi} />

      {/* FR-22.10：查到的词唯一的去处（变更 84 撤掉了「加入生词本」） */}
      <AddToDrill word={result.head} pos={first?.pos} gender={first?.gender} zh={first?.zh[0]} />
    </Card>
  );
}

/** AI 补充解释那一块：查到的词是按钮入口，查不到的词（NotFound）也用它，只是外层文案不同。 */
function AiBlock({ aiState, onAsk }: { aiState: AiState | null; onAsk: () => void }) {
  return (
    <div className="space-y-1 border-t border-line pt-3">
      <div className="flex items-center gap-2">
        <p className="text-note text-faint">AI 补充</p>
        {aiState !== 'loading' && (
          <Button className="ml-auto" onClick={onAsk}>
            {aiState && typeof aiState === 'object' ? '重新问 AI' : '问 AI'}
          </Button>
        )}
      </div>
      {aiState === 'loading' && <Note tone="accent">正在问 AI…</Note>}
      {aiState === 'unavailable' && <Hint tone="warn">AI 服务暂时不可用，过会儿再试。</Hint>}
      {aiState && typeof aiState === 'object' && (
        <div className="whitespace-pre-line text-ui text-muted">{aiState.note}</div>
      )}
    </div>
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
  aiState,
  onAskAi,
}: {
  query: string;
  onlineState: Pending<OnlineEntry | null> | 'off';
  aiState: AiState | null;
  onAskAi: () => void;
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

      {/* FR-9.11：两个词典都没有的时候，就地问一次 AI，不用等用户去点。
          失败了也不用先把词收下再去生词本页重试——AiBlock 自带的按钮当场就能重问。 */}
      <AiBlock aiState={aiState} onAsk={onAskAi} />

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
      <AddToDrill word={query} />
    </Card>
  );
}
