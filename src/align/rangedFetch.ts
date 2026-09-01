// 按 Range 分片取随包权重。这是 2026-09-01 那次 iPhone 崩溃的正面修复。
//
// ── 事故 ──
// TestFlight 版导入一课后自动对齐，进度走到「加载对齐模型 181 MB / 187.6 MB」，
// 应用直接消失。JS 侧没有任何异常 —— 进程是被系统干掉的。
//
// ── 那条路上同时存在几份 187MB ──
//   1. Capacitor 的 iOS scheme handler 对非媒体扩展名走 `Data(contentsOf:)`，
//      **把整份 .onnx 一次性读进原生进程的堆**（node_modules/@capacitor/ios/…/
//      WebViewAssetHandler.swift；只有 mp3/mp4 那几个扩展名才用 mmap）。
//   2. WebKit 把这份 Data 搬进 WebContent 进程当响应体。
//   3. transformers.js 的 readResponse() 再拼出一个 187MB 的 Uint8Array。
//   4. 命中「本地文件也算 200 响应」的分支后，它还会把这 187MB **再写一份进 Cache API**
//      （hub.js 的 storeCachedResource）—— 一份已经躺在安装包里的文件，缓存毫无意义。
//   5. 最后 ORT 把权重拷进 WASM 堆 / GPU buffer。
// 加起来接近 1GB，而第 4 步正好发生在进度条走到最后那一刻 ——
// 与「181 MB / 187.6 MB 之后应用消失」完全吻合。
//
// ── 这一层做了什么 ──
// 冒充 transformers.js 的缓存命中：`match()` 返回一个**按 8MB 分片拉取**的流式 Response。
//   · 原生进程每次只读 8MB —— Capacitor 的 Range 分支走 FileHandle.seek + readData，
//     那条分支本来就在，只是没人给它发 Range 请求；
//   · 「命中缓存」使 transformers.js 不再回写缓存，第 4 步整份消失；
//   · JS 侧仍然只有一份预分配好的 187MB 缓冲（靠 Content-Length 一次分配到位）。
// 剩下两份（缓冲 + ORT 自己的拷贝）是绕不过去的下限。
//
// 单独一个文件而不是塞在 runtime.ts 里：runtime.ts 一 import 就连着 transformers.js +
// onnxruntime-web，在单测里跑不起来。这里的东西全部只依赖 fetch，所以可以真的测。

/** 分片大小。8MB 足够摊薄每次请求的固定开销，又不至于让原生壳一次读出一大块。 */
export const RANGE_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * 探「这个 URL 到底认不认 Range，以及总共多少字节」。
 * 只要第一个字节，所以无论文件多大这一步都是常数开销。
 *
 * ── 光看状态码 206 是不够的 ──
 * Vite 的 dev server 实测会回 **206 + Content-Range: bytes 0-196703175/196703176**，
 * 也就是「我知道你要 Range，但我给你整份」。只认状态码的话，后面每个分片请求都会
 * 拖回整个 187MB —— 正好把这一层要解决的问题放大 N 倍。
 * 所以判据是「回来的区间必须真的是我要的那一个字节」。
 * （Android 的 WebViewAssetLoader 直接回 200，走不到这一步就被挡掉了。）
 *
 * 不认就返回 null，调用方老老实实退回原来那条一次性整取的路 ——
 * 慢一点、费内存，但绝不因为这层优化而失败。
 */
export async function probeRanged(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    const contentRange = res.headers.get('content-range') ?? '';
    // **不要**读 body：服务端忽略 Range 时它就是整份 187MB。直接掐掉这次传输。
    void res.body?.cancel().catch(() => undefined);
    if (res.status !== 206) return null;
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange.trim());
    if (!match) return null;
    if (match[1] !== '0' || match[2] !== '0') return null; // 回了 206 却给整份
    const total = Number(match[3]);
    return Number.isFinite(total) && total > 0 ? total : null;
  } catch {
    return null;
  }
}

/**
 * 把一个大文件包成「按 Range 分片流式吐出」的 Response。
 * @param chunkBytes 分片大小。参数化只为了单测能用几个字节跑完整条流程 ——
 *   拿 8MB 去测「offset 有没有推进」要分配几十 MB，得不偿失。
 */
export function rangedResponse(url: string, total: number, chunkBytes = RANGE_CHUNK_BYTES): Response {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= total) {
        controller.close();
        return;
      }
      const end = Math.min(total - 1, offset + chunkBytes - 1);
      try {
        const res = await fetch(url, { headers: { Range: `bytes=${offset}-${end}` } });
        if (res.status !== 206 && !res.ok) throw new Error(`分片请求失败：${res.status}`);
        const chunk = new Uint8Array(await res.arrayBuffer());
        // 0 字节会让循环永远走不到 total，宁可报错也不能死循环。
        if (chunk.byteLength === 0) throw new Error('分片请求返回了 0 字节');
        // 比要的多 = 服务端在中途开始忽略 Range。这时拼出来的字节一定是错的
        // （错一个字节 = 模型加载失败，而且报错完全对不上号），宁可当场停。
        if (chunk.byteLength > end - offset + 1) throw new Error('分片请求返回的比要的多');
        offset += chunk.byteLength;
        controller.enqueue(chunk);
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      // readResponse() 靠这个头预分配缓冲；缺了它 transformers.js 会边读边扩容，
      // 那意味着最坏情况下同时存在两份 187MB。
      'Content-Length': String(total),
      'Content-Type': 'application/octet-stream',
    },
  });
}

export interface StreamingWeightsCache {
  match(request: string): Promise<Response | undefined>;
  put(): Promise<void>;
}

/**
 * 给 transformers.js 的 `env.customCache`：只接管随包权重里的大文件。
 *
 * @param localPrefix 只有以它开头的路径才接管（`/models/`）。远端 URL 与
 *   config.json / tokenizer.json 那几个 KB 级的文件一律走原路 —— 它们没有内存问题，
 *   多一层间接只会多一处可能出错的地方。
 */
export function createStreamingWeightsCache(
  localPrefix: string,
  chunkBytes = RANGE_CHUNK_BYTES,
): StreamingWeightsCache {
  return {
    async match(request: string): Promise<Response | undefined> {
      if (typeof request !== 'string') return undefined;
      if (!request.endsWith('.onnx') || !request.startsWith(localPrefix)) return undefined;
      const total = await probeRanged(request);
      if (total === null) return undefined; // 不支持 Range —— 退回原路，功能不变
      return rangedResponse(request, total, chunkBytes);
    },
    async put(): Promise<void> {
      // 故意什么都不做：随包的文件已经在盘上，没有第二份可存。见文件顶部第 4 步。
    },
  };
}
