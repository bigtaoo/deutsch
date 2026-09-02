import { describe, it, expect, vi, afterEach } from 'vitest';
import { pickPlayable, type PronunciationRef } from './audio';

// 这里测的是**挑哪个文件**，因为挑错的两种方式都很难在用后才发现：
//   · 挑了方言录音 → 声音是对的一个词，但发音不是标准德语，练歪了还不知道
//   · 挑了放不动的格式 → 播放键点了没反应（§3.2 记过的那种最难查的静默失败）

const ref = (file: string, mime: string): PronunciationRef => ({
  lemma: 'einhergehen',
  file,
  url: `https://upload.wikimedia.org/${file}`,
  mime,
  size: 20000,
});

const DE_OGG = ref('De-einhergehen.ogg', 'application/ogg');
const BAR_OGG = ref('Bar-einhergehen.ogg', 'application/ogg'); // 巴伐利亚方言
const LL_WAV = ref('LL-Q188 (deu)-Sebastian Wallroth-einhergehen.wav', 'audio/wav');

/** 假装成某个浏览器：只有列出的 mime 放得动。 */
function stubCanPlay(playable: string[]) {
  vi.stubGlobal('document', {
    createElement: () => ({
      canPlayType: (mime: string) => (playable.includes(mime) ? 'probably' : ''),
    }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('pickPlayable', () => {
  it('两个都能放时选 De-* —— 德语维基词典的标准录音', () => {
    stubCanPlay(['application/ogg', 'audio/wav']);
    expect(pickPlayable([LL_WAV, DE_OGG])?.file).toBe('De-einhergehen.ogg');
  });

  it('放不了 ogg 时退到 Lingua Libre 的 wav，而不是判成「没有真人音」', () => {
    // 这就是 WKWebView：Safari 一直不支持 Ogg Vorbis。
    // 按偏好序硬挑的话 iPhone 上几乎每个词都会退到合成音，
    // 而明明旁边就有一份放得动的 wav。
    stubCanPlay(['audio/wav']);
    expect(pickPlayable([DE_OGG, LL_WAV])?.file).toMatch(/^LL-Q188/);
  });

  it('一个都放不动时返回 undefined（调用方退 TTS）', () => {
    stubCanPlay([]);
    expect(pickPlayable([DE_OGG, LL_WAV])).toBeUndefined();
  });

  it('候选为空时返回 undefined，不抛', () => {
    stubCanPlay(['application/ogg']);
    expect(pickPlayable([])).toBeUndefined();
  });

  it('方言录音即使能放也不选 —— 宁可没有声音', () => {
    // Bar-（巴伐利亚）在 findPronunciations 那一层就被 scoreFile 判为
    // Infinity 而滤掉了；这里再钉一次，防止哪天有人「顺手」放宽那个过滤。
    stubCanPlay(['application/ogg']);
    expect(pickPlayable([BAR_OGG])).toBeUndefined();
  });

  it('方言与标准录音同时在场时选标准的', () => {
    stubCanPlay(['application/ogg']);
    expect(pickPlayable([BAR_OGG, DE_OGG])?.file).toBe('De-einhergehen.ogg');
  });
});
