/**
 * cyrb53：53 位非加密哈希，同步、无依赖。
 *
 * 用途只有一个：FR-3.7 的 `manuscriptHash` —— 补齐素材后判断「DW 是不是改过稿」。
 * 这不是安全场景，没有人会构造碰撞来骗过它，要防的是「改了稿但我没发现」。
 * 用 crypto.subtle.digest 会把这条路径变成异步，代价大于收益。
 */
export function cyrb53(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** 比较前先折叠空白：DW 改个换行不该被当成改稿。 */
export function manuscriptHash(plainText: string): string {
  return cyrb53(plainText.replace(/\s+/g, ' ').trim());
}
