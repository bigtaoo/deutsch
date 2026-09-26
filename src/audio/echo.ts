// FR-6.8：跟读回放 —— 录下「我跟读的那一遍」，紧接着放给自己听。
//
// ── 麦克风在整段跟读期间一直开着 ──
// `open()` 在「开始跟读」的点击里调一次，拿到的流一直留到 `close()`（停止、切后台、离开页面）。
// 每遍再去 getUserMedia 的话，从调用到真的开始采样要一两百毫秒，而人往往是原句一停就开口 ——
// 头一个音节正好被吃掉，回放听起来像是自己漏了一个词，对照也就失去了意义。
//
// ── 回放走 Web Audio 而不是再建一个 <audio> ──
// 和 `player.ts` 单例是同一条理由：iOS 只让「手势链」上的元素开始播放，而回放发生在
// 静默间隔结束的定时器里，离最近一次点击已经好几秒。AudioContext 在 `open()`（手势里）
// resume 过一次之后就一直是 running，后面的 start() 不再需要手势。
// decodeAudioData 认得各家 MediaRecorder 自己吐出来的格式（Chrome/Firefox 的 webm/ogg-opus、
// Safari 的 mp4-aac），所以不需要指定 mimeType。
//
// ── 原生壳 ──
// iOS 上 WKWebView 调麦克风需要 Info.plist 里有 NSMicrophoneUsageDescription，**没有这条
// 系统会直接杀掉进程**，不是弹一个拒绝。而前端是热更下发的（§7.12）：这份 JS 会先落到还没有
// 那条声明的旧壳上。所以 iOS 要壳版本 ≥ `ECHO_MIN_IOS` 才开；问不出版本就当不支持 ——
// 少一个功能和闪退之间没有什么可权衡的。Android 壳没维护热更（变更 41），先不开。

import type { EchoRecorder } from './shadowing';
import { nativePlatform } from '@/platform/native';
import { askBridgeVerbose, versionAtLeast } from '@/platform/nativeUpdate';

/** 第一个带 NSMicrophoneUsageDescription 的 iOS 壳。 */
export const ECHO_MIN_IOS = '0.7.0';

type Ctor = new () => AudioContext;

function audioContextCtor(): Ctor | null {
  const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** 这台设备能不能录。只回答「能力在不在」，不申请权限 —— 权限在 `open()` 里要。 */
export async function echoSupported(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
  if (typeof MediaRecorder === 'undefined' || !audioContextCtor()) return false;
  const platform = await nativePlatform();
  if (platform === 'web') return true;
  if (platform === 'android') return false;
  const info = await askBridgeVerbose(async () => (await import('@capacitor/app')).App.getInfo());
  return info.ok && versionAtLeast(info.value.version, ECHO_MIN_IOS);
}

/** `getUserMedia` 抛出来的东西翻成一句人话，给跟读页上那条提示用。 */
export function describeMicError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风没有授权，这次跟读不录音。到浏览器地址栏的权限里放开即可。';
  if (name === 'NotFoundError') return '没有找到麦克风，这次跟读不录音。';
  if (name === 'NotReadableError') return '麦克风被别的程序占着，这次跟读不录音。';
  return `麦克风打不开（${err instanceof Error ? err.message : String(err)}），这次跟读不录音。`;
}

export class MicEcho implements EchoRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private source: AudioBufferSourceNode | null = null;

  get isOpen(): boolean {
    return this.stream !== null;
  }

  /** **必须从点击里调**：权限弹窗与 AudioContext 的 resume 都要手势。失败时抛原始错误。 */
  async open(): Promise<void> {
    if (!this.ctx) {
      const Ctx = audioContextCtor();
      if (Ctx) this.ctx = new Ctx();
    }
    // 先 resume 再要麦克风：权限弹窗一出来，这次点击的手势就算用掉了。
    await this.ctx?.resume().catch(() => {});
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      // 回声消除必须开：原句是外放的，不开的话录进去的有一半是原句本身。
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }

  close(): void {
    this.halt();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  async start(): Promise<void> {
    if (!this.stream) throw new Error('麦克风没开');
    this.discardRecording();
    const recorder = new MediaRecorder(this.stream);
    this.chunks = [];
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    });
    this.recorder = recorder;
    recorder.start();
  }

  stop(): Promise<Blob | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') return Promise.resolve(null);
    return new Promise((resolve) => {
      recorder.addEventListener(
        'stop',
        () => {
          // halt() 抢先把它换掉了 = 这一段已经作废
          if (this.recorder !== recorder) return resolve(null);
          this.recorder = null;
          const chunks = this.chunks;
          this.chunks = [];
          resolve(chunks.length ? new Blob(chunks, { type: recorder.mimeType || chunks[0]!.type }) : null);
        },
        { once: true },
      );
      recorder.stop();
    });
  }

  async play(clip: Blob, opts: { onEnded: () => void }): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) throw new Error('没有 AudioContext');
    const buffer = await ctx.decodeAudioData(await clip.arrayBuffer());
    this.stopSource();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const finish = () => {
      clearTimeout(fallback);
      // stopSource() 主动掐断时也会发 ended —— 那时它已经不是 this.source 了，不能往下走。
      if (this.source !== source) return;
      this.source = null;
      opts.onEnded();
    };
    // 保底：上下文被系统挂起（iOS 来电、切音频路由）时 ended 永远不来，
    // 循环就会一直停在「回放」上、只能手动点停止。时长到了加一秒还没响就当它放完了。
    const fallback = setTimeout(finish, buffer.duration * 1000 + 1000);
    source.addEventListener('ended', finish);
    this.source = source;
    source.start();
  }

  halt(): void {
    this.discardRecording();
    this.stopSource();
  }

  private discardRecording(): void {
    const recorder = this.recorder;
    this.recorder = null;
    this.chunks = [];
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  private stopSource(): void {
    const source = this.source;
    this.source = null;
    try {
      source?.stop();
    } catch {
      // 还没 start 或已经停了
    }
  }
}
