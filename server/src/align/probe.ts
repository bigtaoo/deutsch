// 在真机器上读几个数。**不是测试，是排障与验收工具。**
//
//   docker compose exec sync node src/align/probe.ts /data/sample.mp3
//
// 它回答的正是部署之后唯一还不知道的那几件事（本机验不了：Windows 上没有 ffmpeg，
// 而这台 VPS 的 CPU 也不是本机那颗）：
//   ① ffmpeg 在不在、认不认这个文件（解码几秒）
//   ② 权重能不能加载、`MatMulNBits` 在这份 ORT 分发里有没有（加载几秒）
//   ③ **一块多少秒** —— 一课 27 块，这个数直接决定「服务器对齐要等多久」
//   ④ 一份指纹（帧数 + 前几个 log-prob + 全局均值），拿去和桌面浏览器算的同一课对比：
//      三条路应该给出**同一份矩阵**，而「应该一样」的事情最需要留下能对照的数
//
// 刻意不写成 vitest：它要跑真模型、要几分钟、要一个真实 mp3 —— 那三件事都不该出现在
// CI 里。真模型的正确性由「同一课在桌面和这里对出同样的时间戳」来验，不是由单测。

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { loadConfig } from '../config.ts';
import { createEngine, MODEL_SHAPE } from './engine.ts';

const file = process.argv[2];
if (!file) {
  console.error('用法：node src/align/probe.ts <音频文件>');
  process.exit(2);
}

// 配置从环境变量来，与服务进程一模一样 —— 探针要探的是**线上那套配置**，
// 不是另一套默认值。所以在容器里跑（`docker compose exec`），不要在宿主上跑。
const config = loadConfig();
const engine = createEngine({
  dir: config.align.modelDir,
  dtype: config.align.dtype,
  threads: config.align.threads,
  maxSeconds: config.align.maxSeconds,
});

const audio = await readFile(file);
console.log(`文件：${basename(file)}，${(audio.byteLength / 1024 / 1024).toFixed(1)} MiB`);
console.log(`配置：${config.align.dtype}，${config.align.threads} 线程，权重在 ${config.align.modelDir}`);

let stageStartedAt = Date.now();
let lastChunkAt = 0;
const chunkSeconds: number[] = [];

const result = await engine.compute(
  audio,
  extname(file).replace('.', '') || 'mp3',
  (p) => {
    const now = Date.now();
    if (p.stage === 'decode') {
      stageStartedAt = now;
    } else if (p.stage === 'model') {
      console.log(`① 解码：${((now - stageStartedAt) / 1000).toFixed(1)} 秒`);
      stageStartedAt = now;
    } else if (p.chunk === 0) {
      console.log(`② 加载权重：${((now - stageStartedAt) / 1000).toFixed(1)} 秒`);
      console.log(`　 一共 ${p.chunks} 块`);
      lastChunkAt = now;
    } else if (p.chunk !== undefined) {
      const seconds = (now - lastChunkAt) / 1000;
      lastChunkAt = now;
      chunkSeconds.push(seconds);
      // 每块都打一行：这个工具是给「盯着看它到底动没动」用的。
      console.log(`　 第 ${p.chunk}/${p.chunks} 块：${seconds.toFixed(1)} 秒`);
    }
  },
  () => false,
);

const total = chunkSeconds.reduce((a, b) => a + b, 0);
const mean = total / (chunkSeconds.length || 1);
console.log(`③ 每块平均 ${mean.toFixed(1)} 秒，推理共 ${total.toFixed(0)} 秒`);
console.log(
  `　 音频 ${result.duration.toFixed(1)} 秒 → 实时倍率 ${(result.duration / (total || 1)).toFixed(2)}×`,
);

let sum = 0;
for (let i = 0; i < result.logProbs.length; i++) sum += result.logProbs[i];
console.log(`④ 指纹：frames=${result.frames} vocab=${result.vocabSize}`);
console.log(`　 前 5 个 log-prob：${Array.from(result.logProbs.slice(0, 5)).map((v) => v.toFixed(4)).join(' ')}`);
console.log(`　 全局均值：${(sum / result.logProbs.length).toFixed(6)}`);
console.log(`　 期望帧数：${Math.floor((result.duration * MODEL_SHAPE.sampleRate) / MODEL_SHAPE.frameStride)}`);
