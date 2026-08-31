/**
 * `btoa`/`atob` 只处理 Latin1，德语内容有 äöüß 等非 ASCII 字符，
 * 必须先过一遍 TextEncoder/TextDecoder 才能安全走 base64（GitHub Contents API 要求 base64）。
 */
export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64Utf8(base64: string): string {
  // GitHub 返回的 content 每 60 字符一个换行，atob 处理不了换行。
  const binary = atob(base64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
