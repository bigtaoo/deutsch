// FR-17.3/17.4：报名预置词库。生词本页顶部的一块。
//
// ── 为什么是「报名一整档」而不是「加 N 个词」 ──
// 原来这里是三个按钮：加 10 / 25 / 50 个词。那个形状把两件事压成了一个动作：
// 「我要学哪些词」是一次性的选择，「今天学几个」是每天的配额。
// 混在一个按钮上的结果是每学完十几个词就要回来点一次。
// 现在报名只写一条设置（`enrolledBands`），卡片由复习页按 `newPerDay` 每天惰性激活。
//
// ── 为什么不在这里就把整档建成卡 ──
// 第 4 档是 3000 个词。建卡要查 3000 次词典、按 50 个一批打 60 次 MediaWiki
// 取发音、往 IndexedDB 写 100MB 以上的录音。那条路走不通，所以报名是「记一个意向」。
//
// ── 界面上必须写清的三件事（它们会直接影响学习判断）──
//   ① 档位是**口语词频名次，不是 CEFR 等级**。官方 CEFR 词表只有 A1/A2/B1
//      且有版权，B2/C1/C2 压根没有官方表 —— 详见 scripts/build-dict.mjs 头部。
//   ② 语料是 OpenSubtitles（影视对白），偏口语，也会带进人名和粗话。
//   ③ 声音是**孤立词**发音，练不到连读 —— 而连读才是精听真正的难点。

import { useEffect, useState } from 'react';
import { dictMeta } from '@/dict/lookup';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useVocabStore } from '@/state/useVocabStore';
import { Banner, Button, Hint, Section } from '@/components/ui';
import type { DictMeta } from '@/dict/types';

export function PresetPanel() {
  const { settings, update } = useSettingsStore();
  const { entries, topUpNewCards } = useVocabStore();
  const [meta, setMeta] = useState<DictMeta | null | 'loading'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void dictMeta().then(setMeta);
  }, []);

  const enrolled = settings.enrolledBands ?? [];
  const activated = entries.filter((e) => e.preset).length;

  /**
   * 报名之后立刻发一批 —— 不然点完按钮界面上什么都不会变，
   * 而「什么都没发生」在这个动作上尤其容易被当成没生效（它本来就只写一条设置）。
   */
  const enroll = async (band: number) => {
    setResult(null);
    await update({ enrolledBands: [...enrolled, band].sort((a, b) => a - b) });
    setBusy('准备今天的新卡…');
    try {
      const { added, skipped, human } = await topUpNewCards((phase, done, total) =>
        setBusy(phase === 'picking' ? `查词典 ${done}/${total}` : `取发音 ${done}/${total}`),
      );
      if (added.length === 0) {
        setResult(
          skipped > 0
            ? `报名了，但今天这批词在内置词典里查不到（${skipped} 个）。词典可能没跟着构建走（npm run build:dict）。`
            : '报名了。今天的新卡配额已经满了 —— 明天会接着发。',
        );
      } else {
        // 如实报出「多少张是真人音」：剩下的是合成音，而两者的训练价值不一样。
        setResult(
          `报名了，今天先发 ${added.length} 个词：${human} 个有真人录音、${added.length - human} 个用系统合成音。` +
            '往后每天按「每天新卡数」自动发，不必再回来点。',
        );
      }
    } catch (err) {
      setResult(`报名了，但取词失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const leave = async (band: number) => {
    setResult(null);
    await update({ enrolledBands: enrolled.filter((b) => b !== band) });
    setResult(`退出了第 ${band} 档。**已经发出来的卡不会被删** —— 要删得去下面的列表里删。`);
  };

  if (meta === 'loading') return null;

  // 词典没部署时不装作能用。web 版首次访问、或者忘了跑 build:dict 都会走到这里。
  if (meta === null) {
    return (
      <Banner tone="warn">
        <p>内置词典没有就位，预置词库用不了。</p>
        <p className="mt-1 text-xs">
          打包版应该随包带 <code>public/dict/</code>；本机开发跑一次 <code>npm run build:dict</code>。
        </p>
      </Banner>
    );
  }

  return (
    <Section
      title={`预置词库${activated > 0 ? `（已激活 ${activated} 个）` : ''}`}
      aside={<Button onClick={() => setOpen(!open)}>{open ? '收起' : '展开'}</Button>}
    >
      {!open ? (
        <p className="text-sm text-neutral-500">
          {enrolled.length > 0
            ? `已报名第 ${enrolled.join(' / ')} 档，每天自动发 ${settings.newPerDay} 个新词。`
            : '笔记还不多的时候，从这里报名一整档，之后每天自动发新词。'}
        </p>
      ) : (
        <div className="space-y-3">
          <Hint tone="warn">
            这些档位是<b>口语词频名次，不是 CEFR 等级</b>。官方 CEFR 词表只有 A1/A2/B1
            且有版权，B2/C1/C2 没有官方表，所以这里不用那套标签 —— 免得按 A1/B2 去理解一个别的东西。
            语料是影视字幕，偏口语，偶尔会混进人名。
          </Hint>

          <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200">
            {meta.decks.map((deck) => {
              const inBand = entries.filter((e) => e.preset?.band === deck.id).length;
              const isEnrolled = enrolled.includes(deck.id);
              return (
                <li key={deck.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      第 {deck.id} 档 · {deck.label} · {deck.count} 词
                      {deck.id === settings.presetBand && (
                        <span className="ml-2 rounded bg-sky-100 px-1.5 text-xs text-sky-800">推荐起点</span>
                      )}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {isEnrolled
                        ? `已报名 · 已激活 ${inBand} / 剩余 ${Math.max(0, deck.count - inBand)}`
                        : inBand > 0
                          ? `没报名，但已经有 ${inBand} 张这一档的卡`
                          : '未报名'}
                    </p>
                  </div>
                  {isEnrolled ? (
                    <Button disabled={busy !== null} onClick={() => void leave(deck.id)}>
                      退出这一档
                    </Button>
                  ) : (
                    <Button variant="primary" disabled={busy !== null} onClick={() => void enroll(deck.id)}>
                      报名（{deck.count} 词）
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {busy && <p className="text-sm text-neutral-500">{busy}</p>}

          <p className="text-xs text-neutral-500">
            推荐从第 4 档起：前三档合起来约三千词，C1 的人基本全认识 —— 从第 1 档开始等于要答几千道
            「这个我早就会了」才挖到有用的地方。报了几档就按档号从小到大发，一档发完接着下一档。
          </p>
          <p className="text-xs text-neutral-500">
            每天发多少由<b>设置里的「每天新卡数」</b>决定（现在 {settings.newPerDay} 个），
            而且课上标的生词也算在这个额度里 —— 标了 8 个词的那天，预置词库只会再补 2 个。
            发卡时会顺手把发音下下来（Wiktionary 上的真人录音，自由许可），因为复习多半发生在没网的时候；
            没有录音的词退到系统合成音。两者都是<b>孤立词</b>发音 —— 练得到词形和读音的对应，
            练不到连读，而连读要靠课程里的真语料。
          </p>

          {result && <Hint tone={result.includes('失败') ? 'error' : 'ok'}>{result}</Hint>}
        </div>
      )}
    </Section>
  );
}
