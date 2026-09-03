// 帧级 log-prob 的**远端实现**：那道缝（emissionMatrix.ts）的第三个 provider。
// 服务端那一半在 `server/src/align/`。
//
// ── 为什么值得有这一条 ──
// 手机上本地对齐是「十几分钟满载 + 必须一直亮屏别切走」（变更 33），实际上跑不完；
// 桌面上 26 秒。于是主路径一直是「桌面算完同步过来」，而那条路要求**先有一台桌面**。
// 服务器把这个前提去掉了：手机导入 → 上传 7MB → 服务器一两分钟算完 → 手机取回 3MB 矩阵
// → Viterbi 在手机上几秒钟。手机在这中间可以锁屏、可以退出 App。
//
// ── 上行是 mp3，下行是矩阵，**文稿不出设备** ──
// CTC 前向压根不看文本（emissionMatrix.ts 顶部那段），所以服务器只需要音频。
// SPEC §3.1 关于德语正文的一整套约束因此完全不受影响，要认的只有「音频经手」一条 ——
// 而那台服务器是自己的、只有白名单能进、音频跑完即从内存里放掉（不落盘、不入库）。
//
// ── 为什么是「任务 + 轮询」而不是一次长请求 ──
// 一课要一两分钟，而手机握不住一个一两分钟的连接（锁屏、切走、换基站）。
// 提交是几秒的事，之后计算在服务器上继续跑 —— 这正是本地那条路缺的东西。
// 协议与状态码的含义见 server/src/align/jobs.ts 顶部。

import { SYNC_API_BASE, isSyncConfigured } from '@/sync/config';
import { getSessionToken } from '@/sync/session';
import { SyncApiError, SyncAuthError } from '@/sync/client';
import type { AlignModelConfig } from './config';
import type { EmissionMatrix, EmissionsProgress } from './emissionMatrix';

/** 轮询间隔。一课一两分钟，2 秒一次既不吵也不迟钝。 */
const POLL_MS = 2000;
/** 提交之后多久没进展就放弃（服务器挂了、任务丢了）。一课最多几分钟，20 分钟是极宽松的兜底。 */
const MAX_WAIT_MS = 20 * 60_000;

interface JobView {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  stage?: 'decode' | 'model' | 'infer';
  chunk?: number;
  chunks?: number;
  queuePosition?: number;
  error?: string;
}

/**
 * 这台服务器**明确说了自己不做对齐**（503 + code=align_off）。
 *
 * 记在模块级、只记这一种情况：网络错误和 5xx 都可能是暂态的，下次该再试；
 * 而「这个部署没开对齐」在这次会话里不会变，记住它才能让自动对齐的闸门
 * （useAlignStore）立刻回到「手机上不自动跑」那条老路上，而不是每次导入都白试一轮。
 */
let serverSaidOff = false;

/**
 * 远端能不能用。**这是个便宜的判断**：只看「配了同步服务器 + 登录过 + 服务器没说过不做」，
 * 不发请求 —— 它出现在自动对齐的闸门上，每次导入都要问。
 * 真的不能用（掉线、服务器 5xx）由 computeRemoteEmissions 抛错，调用方退回本地那条路。
 */
export async function remoteEmissionsAvailable(): Promise<boolean> {
  if (serverSaidOff || !isSyncConfigured()) return false;
  return (await getSessionToken()) !== undefined;
}

/** 退出登录、换账号、或想重新探一次时调用。 */
export function resetRemoteEmissionsAvailability(): void {
  serverSaidOff = false;
}

export interface RemoteEmissionsOptions {
  /** 取消。会顺手把服务器上那个任务也 DELETE 掉，别让它白算完。 */
  signal?: AbortSignal;
  onProgress?: (p: EmissionsProgress) => void;
}

class RemoteAlignOffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteAlignOffError';
  }
}

async function request(path: string, init: RequestInit & { token: string }): Promise<Response> {
  const { token, ...rest } = init;
  const res = await fetch(`${SYNC_API_BASE}${path}`, {
    ...rest,
    headers: { ...(rest.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    throw new SyncAuthError('会话已过期，请重新登录');
  }
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
    if (body.code === 'align_off') {
      serverSaidOff = true;
      throw new RemoteAlignOffError(body.error ?? '这台服务器没有开对齐');
    }
  }
  return res;
}

async function errorOf(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new SyncApiError(res.status, body.error ?? `请求失败：HTTP ${res.status}`);
}

/**
 * 算一课。参数与本机 / 原生两条路刻意不同：**这里收的是 mp3 而不是波形**
 * （服务器自己用 ffmpeg 解码，理由同原生那条 —— 7MB vs 30MB）。
 *
 * `config` 只用来断言 `vocabSize`：服务器返回什么由它自己的模型决定，
 * 而下游的 Viterbi 按本地配置解释这个矩阵 —— 两边对不上必须当场炸，
 * 不能拿一份 31 列的矩阵按 32 列去读（那会得到一份看起来正常的错时间戳）。
 */
export async function computeRemoteEmissions(
  audio: Blob,
  config: AlignModelConfig,
  options: RemoteEmissionsOptions = {},
): Promise<EmissionMatrix> {
  const { signal, onProgress } = options;
  const token = await getSessionToken();
  if (!token) throw new SyncAuthError('尚未登录，无法用服务器对齐');

  // 上传就是「decode」阶段的前半 —— 服务器拿到之后才真的开始解码。
  // 报一次是为了让界面在这几秒里有话说（那几秒里手机在传 7MB）。
  onProgress?.({ stage: 'decode' });

  const submitted = await request('/v1/align/jobs', {
    token,
    method: 'POST',
    headers: { 'Content-Type': audio.type || 'audio/mpeg' },
    body: audio,
    signal,
  });
  if (!submitted.ok) await errorOf(submitted);
  const job = (await submitted.json()) as JobView;

  try {
    const finished = await poll(job.id, token, signal, onProgress);
    if (finished.status === 'cancelled') throw new Error('已取消');
    if (finished.status === 'error') throw new Error(finished.error ?? '服务器对齐失败');

    const res = await request(`/v1/align/jobs/${finished.id}/result`, { token, signal });
    if (!res.ok) await errorOf(res);
    return decodeMatrix(await res.arrayBuffer(), config);
  } catch (err) {
    // 取消或出错都别把任务留在那儿白算 —— 那台机器还跑着别人的东西。
    // 这一下是「尽力而为」：它失败不该盖掉真正的错误。
    void request(`/v1/align/jobs/${job.id}`, { token, method: 'DELETE' }).catch(() => {});
    throw err;
  }
}

async function poll(
  id: string,
  token: string,
  signal: AbortSignal | undefined,
  onProgress?: (p: EmissionsProgress) => void,
): Promise<JobView> {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    if (signal?.aborted) throw new Error('已取消');
    const res = await request(`/v1/align/jobs/${id}`, { token, signal });
    // 404 = 任务没了（过期、或服务器重启过）。这一类必须和「还在算」分开：
    // 重新提交要再上传 7MB，所以调用方得知道这是要重来，不是再等等。
    if (res.status === 404) throw new Error('服务器上的对齐任务不见了（可能已过期），要重新提交');
    if (!res.ok) await errorOf(res);

    const view = (await res.json()) as JobView;
    if (view.status !== 'queued' && view.status !== 'running') return view;
    onProgress?.({
      // 排队时报 model：界面上那句「加载对齐模型」在这里的意思是「还没轮到我」，
      // 而 queuePosition 只有一个人用的服务上几乎永远是 0，不值得单开一个阶段。
      stage: view.stage ?? 'model',
      chunk: view.chunk,
      chunks: view.chunks,
      fraction: view.chunk !== undefined && view.chunks ? view.chunk / view.chunks : undefined,
    });
    if (Date.now() > deadline) throw new Error('服务器对齐超时（20 分钟没算完）');
    await sleep(POLL_MS, signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 解线缆上那一帧。格式与 `server/src/align/wire.ts` 一一对应，**两边要一起改**：
 *   [0,4) 头部字节数（u32 LE，已补齐到 4 的整数倍）→ [4,4+n) JSON → 之后是 float32 负载
 *
 * 头部补齐让负载起点是 4 的倍数，所以这里能**零拷贝**建视图（3MB 不用抄一遍）。
 */
export function decodeMatrix(buffer: ArrayBuffer, config: AlignModelConfig): EmissionMatrix {
  if (buffer.byteLength < 4) throw new Error('服务器返回的矩阵是空的');
  const headerLength = new DataView(buffer).getUint32(0, true);
  const start = 4 + headerLength;
  if (start > buffer.byteLength || start % 4 !== 0) {
    throw new Error('矩阵头部长度不合法 —— 服务端与客户端的格式对不上');
  }
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)),
  ) as { frames?: number; vocabSize?: number; duration?: number };

  const { frames, vocabSize, duration } = header;
  if (!frames || !vocabSize || duration === undefined) {
    throw new Error('矩阵头部缺字段（frames / vocabSize / duration）');
  }
  if (vocabSize !== config.vocabSize) {
    throw new Error(`服务器的词表大小是 ${vocabSize}，本机配置写的是 ${config.vocabSize}`);
  }
  const logProbs = new Float32Array(buffer, start);
  if (logProbs.length !== frames * vocabSize) {
    // 长度对不上多半是传输被截断。宁可在这里失败 —— 一份短了的矩阵会让
    // 后半课的时间戳全部落在 log(1/31) 的均匀分布上，而那是「看起来正常」的错。
    throw new Error(`矩阵长度对不上：说有 ${frames} × ${vocabSize}，实际 ${logProbs.length}`);
  }

  return {
    logProbs,
    frames,
    vocabSize,
    duration,
    source: { kind: 'remote', origin: SYNC_API_BASE },
  };
}
