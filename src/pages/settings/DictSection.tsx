// 词典诊断与署名（FR-16.6 / FR-16.7）。
//
// ── 署名不是可选的 ──
// 词典数据是 **CC BY-SA**（WikDict ← Wiktionary ← DBnary），而这份数据随应用分发。
// CC BY-SA 要求署名，所以这一段必须出现在**用户能看到的地方**，
// 写在 scripts/build-dict.mjs 的注释里或 meta.json 里都不算履行义务。
// 它从 meta.json 原样读出来，构建脚本改了来源这里就跟着变，不会漂。
//
// ── 诊断为什么值得占一块 ──
// 与 AlignBackendSection 同一个理由：**「词典在不在包里」只能由设备自己回答。**
// web 版走 HTTP 取分桶文件（Service Worker 的 globPatterns 不含 json，所以断网就查不到）；
// 原生壳里 public/dict/ 在包内、完全离线。两者行为不同，而用户看到的症状一样
// 都是「查不到这个词」—— 不显示出来就分不清是「词典没部署」还是「这个词确实没有」。

import { useEffect, useState } from 'react';
import { dictMeta, lookupDict } from '@/dict/lookup';
import { germanVoice } from '@/dict/audio';
import { getWordAudioBytes } from '@/db/wordAudio';
import { useSettingsStore } from '@/state/useSettingsStore';
import { nativePlatform, type NativePlatform } from '@/platform/native';
import type { DictMeta } from '@/dict/types';
import { Button, Disclosure, Hint, Note, Section } from '@/components/ui';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function DictSection() {
  const { settings, update } = useSettingsStore();
  const [meta, setMeta] = useState<DictMeta | null | 'loading'>('loading');
  const [platform, setPlatform] = useState<NativePlatform | null>(null);
  const [audio, setAudio] = useState<{ count: number; bytes: number } | null>(null);
  const [probe, setProbe] = useState<string | null>(null);
  const [voice, setVoice] = useState<string | null>(null);

  useEffect(() => {
    void dictMeta().then(setMeta);
    void nativePlatform().then(setPlatform);
    void getWordAudioBytes().then(setAudio);
    // 嗓音列表在部分浏览器里是异步填的，getVoices() 第一次可能是空的。
    const readVoice = () => setVoice(germanVoice()?.name ?? null);
    readVoice();
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.addEventListener('voiceschanged', readVoice);
      return () => speechSynthesis.removeEventListener('voiceschanged', readVoice);
    }
  }, []);

  const runProbe = async () => {
    setProbe('查询中…');
    // 用一个必然在词典里、且能试到词形还原那条路的词。
    const hit = await lookupDict('Plattformen');
    setProbe(
      hit
        ? `✅ 查得到：Plattformen → ${hit.entry.w}（${hit.via === 'form' ? '经词形还原' : '直接命中'}）`
        : '❌ 查不到 —— 词典没部署，或者分桶文件取不到',
    );
  };

  return (
    <Section
      title="词典与预置词库"
      aside={<Button onClick={() => void runProbe()}>查一个词试试</Button>}
    >
      {meta === 'loading' ? (
        <Hint>读取中…</Hint>
      ) : meta === null ? (
        <Note tone="warn">
          内置词典没有就位。打包版应随包带 <code>public/dict/</code>；本机跑一次{' '}
          <code>npm run build:dict</code>。
        </Note>
      ) : (
        <>
          <p className="text-ui text-muted">
            词条 {meta.words.toLocaleString()} 条 · 词形索引 {meta.forms.toLocaleString()} 个 ·{' '}
            {meta.buckets} 个分桶
          </p>
          <p className="text-ui text-muted">
            预置词库：{meta.decks.map((d) => `第${d.id}档 ${d.count}`).join(' · ')}
          </p>
          <p className="text-note text-muted">
            {platform === 'web'
              ? '当前是 web 版：分桶文件按需联网取，断网时查不到新词。'
              : '当前是原生壳：词典在 App 包内，完全离线可用。'}
          </p>
        </>
      )}

      {probe && <Note tone={probe.startsWith('❌') ? 'danger' : 'ok'}>{probe}</Note>}

      <label className="flex items-center gap-2 pt-1 text-ui">
        <input
          type="checkbox"
          checked={settings.onlineDictFallback}
          onChange={(e) => void update({ onlineDictFallback: e.target.checked })}
        />
        内置词典查不到时联网查 de.wiktionary
      </label>
      <Hint>直连 Wiktionary，没有任何中转。长尾复合词内置词典覆盖不全，而 Alltagsdeutsch 满篇都是复合词。</Hint>

      <p className="text-note text-muted">
        发音缓存：{audio ? `${audio.count} 个词 · ${formatBytes(audio.bytes)}` : '统计中…'}
        {' · '}
        {voice ? `合成音兜底：${voice}` : '系统里没有德语嗓音，只能靠真人录音'}
      </p>

      {/* CC BY-SA 要求署名，所以它必须在用户看得到的地方 —— 但它不必占主路径。
          折叠块是「在」的，`<details>` 打印时也会展开。 */}
      {meta !== 'loading' && meta !== null && (
        <Disclosure summary="数据来源与许可">
          <ul className="space-y-1">
            {meta.attribution.map((a) => (
              <li key={a.url} className="text-note text-muted">
                {a.what} —— {a.source}，
                <a className="underline" href={a.url} target="_blank" rel="noreferrer noopener">
                  {a.url}
                </a>
                ，{a.license}
              </li>
            ))}
            <li className="text-note text-muted">
              发音 —— Wikimedia Commons 上的录音，各文件许可随原文件（多为 CC BY-SA / CC0）
            </li>
            <li className="text-note text-muted">{meta.note}</li>
          </ul>
        </Disclosure>
      )}
    </Section>
  );
}
