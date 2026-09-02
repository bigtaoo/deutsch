// FR-17：从预置词库加一批词。生词本页顶部的一块。
//
// ── 为什么这块要写得这么啰嗦 ──
// 它给出的东西比一般功能更容易被误解，而误解会直接影响学习判断：
//   ① 档位是**口语词频名次，不是 CEFR 等级**。官方 CEFR 词表只有 A1/A2/B1
//      且有版权，B2/C1/C2 压根没有官方表 —— 详见 scripts/build-dict.mjs 头部。
//      界面上标成「A1/B2」会让人按 CEFR 去理解一个完全不同的东西。
//   ② 语料是 OpenSubtitles（影视对白），所以偏口语，也会带进人名和粗话。
//   ③ 声音是**孤立词**发音，练不到连读 —— 而连读才是精听真正的难点。
// 三条都写在界面上，而不是只写在文档里。

import { useEffect, useState } from 'react';
import { dictMeta } from '@/dict/lookup';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useVocabStore } from '@/state/useVocabStore';
import { Banner, Button, Hint, Section } from '@/components/ui';
import type { DictMeta } from '@/dict/types';

const COUNTS = [10, 25, 50];

export function PresetPanel() {
  const { settings, update } = useSettingsStore();
  const { entries, addPresetWords } = useVocabStore();
  const [meta, setMeta] = useState<DictMeta | null | 'loading'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void dictMeta().then(setMeta);
  }, []);

  const presetCount = entries.filter((e) => e.preset).length;

  const add = async (count: number) => {
    setResult(null);
    setBusy('挑词…');
    try {
      const { added, skipped, human } = await addPresetWords(settings.presetBand, count, (phase, done, total) => {
        setBusy(phase === 'picking' ? `查词典 ${done}/${total}` : `取发音 ${done}/${total}`);
      });
      if (added.length === 0) {
        setResult(
          skipped > 0
            ? `一个都没加上：${skipped} 个词在内置词典里查不到。词典可能没跟着构建走（npm run build:dict）。`
            : '这一档以后的词都已经在生词本里了 —— 没有新词可加。',
        );
      } else {
        // 如实报出「多少张是真人音」：剩下的是合成音，而两者的训练价值不一样。
        setResult(
          `加了 ${added.length} 个词，其中 ${human} 个有真人录音、${added.length - human} 个用系统合成音。` +
            (skipped > 0 ? `另有 ${skipped} 个词典里查不到，跳过了。` : ''),
        );
      }
    } catch (err) {
      setResult(`失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
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

  const band = meta.decks.find((d) => d.id === settings.presetBand);

  return (
    <Section
      title={`预置词库${presetCount > 0 ? `（已加 ${presetCount} 个）` : ''}`}
      aside={
        <Button onClick={() => setOpen(!open)}>{open ? '收起' : '展开'}</Button>
      }
    >
      {!open ? (
        <p className="text-sm text-neutral-500">
          笔记还不多的时候，从这里取词先练起来。当前：第 {settings.presetBand} 档
          {band ? `（${band.label}，${band.count} 词）` : ''}。
        </p>
      ) : (
        <div className="space-y-3">
          <Hint tone="warn">
            这些档位是<b>口语词频名次，不是 CEFR 等级</b>。官方 CEFR 词表只有 A1/A2/B1
            且有版权，B2/C1/C2 没有官方表，所以这里不用那套标签 —— 免得按 A1/B2 去理解一个别的东西。
            语料是影视字幕，偏口语，偶尔会混进人名。
          </Hint>

          <label className="block text-sm">
            从哪一档开始取
            <select
              className="ml-2 rounded border border-neutral-300 px-2 py-1 text-sm"
              value={settings.presetBand}
              onChange={(e) => void update({ presetBand: Number(e.target.value) })}
            >
              {meta.decks.map((d) => (
                <option key={d.id} value={d.id}>
                  第 {d.id} 档 · {d.label} · {d.count} 词
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-neutral-500">
            默认第 4 档。前三档合起来约三千词，C1 的人基本全认识 ——
            从那里开始等于要点几千次「太简单」才挖到有用的地方。取空一档会自动接着往下一档。
          </p>

          <div className="flex flex-wrap items-center gap-2">
            {COUNTS.map((n) => (
              <Button key={n} variant="primary" disabled={busy !== null} onClick={() => void add(n)}>
                加 {n} 个词
              </Button>
            ))}
            {busy && <span className="text-sm text-neutral-500">{busy}</span>}
          </div>

          <p className="text-xs text-neutral-500">
            加词时会顺手把发音下下来（Wiktionary 上的真人录音，自由许可），因为复习多半发生在没网的时候。
            没有录音的词退到系统合成音。两者都是<b>孤立词</b>发音 —— 练得到词形和读音的对应，
            练不到连读，而连读要靠课程里的真语料。
          </p>

          {result && <Hint tone={result.startsWith('失败') ? 'error' : 'ok'}>{result}</Hint>}
        </div>
      )}
    </Section>
  );
}
