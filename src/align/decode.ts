// 音频解码。单独一个模块，不是为了整齐 —— 是为了**不把 transformers.js 拽进主线程包**。
//
// 解码只能在主线程做（Web Audio API 在 Worker 里不存在），
// 而模型推理只在 Worker 里做。如果解码函数和推理放同一个文件，
// 主线程 import 它就会连带 import @huggingface/transformers + onnxruntime-web，
// 首屏白白多背几百 KB —— 而绝大多数打开应用的时候根本不会跑对齐。

/**
 * 把任意浏览器能解的音频解成单声道、指定采样率的 Float32。
 *
 * 用 OfflineAudioContext 而不是手写重采样：它的重采样是浏览器原生实现，
 * 质量和速度都比在 JS 里插值好，而且 mp3 解码本来就得靠 decodeAudioData。
 */
export async function decodeToMono16k(blob: Blob, sampleRate: number): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();
  // decodeAudioData 按文件自己的采样率解，所以先解码、再用 OfflineAudioContext 重采样。
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(bytes);
  } finally {
    void decodeCtx.close();
  }

  const frames = Math.ceil(decoded.duration * sampleRate);
  const offline = new OfflineAudioContext(1, frames, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const resampled = await offline.startRendering();
  // getChannelData 返回的是 OfflineAudioContext 内部缓冲的视图。
  // 这份数据要被 transfer 进 Worker，必须是独立的 ArrayBuffer，所以拷一次。
  return new Float32Array(resampled.getChannelData(0));
}
