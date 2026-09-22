// FR-18.5：把生成好的图交到用户手上。
//
// 三条路，按能用的挑第一条：
//   原生壳   写进 Cache 目录 → 拉系统分享面板（WKWebView 不实现 `a[download]`，
//            走浏览器那条路会**静默什么都不发生** —— 见 lib/download.ts 的同一个坑）
//   浏览器   `navigator.share({ files })`（手机上就是系统分享面板）
//   兜底     `a[download]` 下载到本地
//
// 「用户划掉了分享面板」不是失败：图已经生成好了，而且在原生壳里已经落盘。
// 所以这三条路都只报告**去了哪儿**，把「AbortError」当正常结束。

import { isNativeShell } from '@/platform/native';

export type ShareTarget = 'native-share' | 'web-share' | 'browser-download';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      // data:image/png;base64,XXXX —— Capacitor 的 Filesystem 只要逗号后面那一段
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('读取图片数据失败'));
    reader.readAsDataURL(blob);
  });
}

export async function shareCardImage(blob: Blob, filename: string): Promise<ShareTarget> {
  if (await isNativeShell()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    await Filesystem.writeFile({
      path: filename,
      data: await blobToBase64(blob),
      directory: Directory.Cache,
      recursive: true,
    });
    const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({ files: [uri] });
    } catch {
      // 划掉分享面板会走到这里。图还在 Cache 里，用户可以再点一次。
    }
    return 'native-share';
  }

  const file = new File([blob], filename, { type: 'image/png' });
  // canShare({files}) 必须问 —— 桌面 Chrome 有 navigator.share 却分享不了文件，
  // 不问就会在那里抛一个 TypeError，而用户看到的是「分享失败」。
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'web-share';
    } catch (err) {
      // AbortError = 用户自己取消的，不该再弹一次下载。
      if (err instanceof DOMException && err.name === 'AbortError') return 'web-share';
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // 同 lib/download.ts：Safari 是异步取这个 blob 的，同步 revoke 会下载出 0 字节。
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return 'browser-download';
}

/** `努力学德语-2026-09-15.png`。日期在文件名里，存进相册之后还能看出是哪天的。 */
export function shareCardFileName(dateKey: string): string {
  return `努力学德语-${dateKey}.png`;
}
