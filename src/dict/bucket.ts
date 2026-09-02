// 词典的分桶函数。**这个文件必须与 scripts/build-dict.mjs 里的同名函数逐字一致。**
//
// 不一致的症状很难查：不是「词典坏了」，而是「查得到的词随机变成查不到」——
// 构建期把 Zuversicht 写进 3f 号桶，运行期去 a1 号桶找，找不到就当没有这个词。
// 所以 bucket.test.ts 里钉了一批固定词的桶号，两边改了任一处都会红。
//
// 为什么分桶而不是一整本：13 万词条的 JSON 有二十多 MB，
// §7.10 说内存是手机上比速度和体积都硬的一道约束 —— 一次 JSON.parse 二十多 MB
// 在 iPhone 的 WebView 里正是那种会被系统杀掉的形状。分成 256 桶之后，
// 查一个词只解析约 100KB。

export const DICT_BUCKETS = 256;

/**
 * NFC + 小写。德语的 ß/ẞ 用 toLowerCase 就够，不必 toLocaleLowerCase('de')
 * —— 那个 locale 变体是给土耳其语的 i/İ 用的，德语上两者结果相同。
 *
 * NFC 是必须的：DW 的文稿里 ä 可能是单码位 U+00E4，也可能是 a + U+0308，
 * 两者看起来一样但字符串不相等。词典侧统一 NFC，查询侧也统一 NFC，才对得上。
 */
export function normalizeKey(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

/**
 * FNV-1a 32 位。选它不是因为它散列质量最好，而是因为二十行能在 JS 和
 * 构建脚本里写得一模一样，且不需要任何依赖 —— 换成 crypto.subtle 就得是异步的，
 * 而这个函数在渲染路径上被调用。
 */
export function bucketOf(key: string): number {
  let h = 0x811c9dc5;
  const norm = normalizeKey(key);
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % DICT_BUCKETS;
}

/** 桶号的两位十六进制文件名，如 `3f`。 */
export function bucketHex(key: string): string {
  return bucketOf(key).toString(16).padStart(2, '0');
}
