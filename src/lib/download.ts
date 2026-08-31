import { isNativeShell } from '@/platform/native';

export type SaveTarget = 'browser-download' | 'native-file';

export interface SaveOptions {
  /**
   * 写完之后弹系统分享面板（默认 true）。
   * FR-11.14 的「导入前自动快照」传 false —— 它是防呆备份，不是用户点的「导出」，
   * 中途弹一个必须手动打掉的模态会把导入流程拦在半路。
   */
  prompt?: boolean;
}

/**
 * 把一个 JSON 存到用户手上。
 *
 * 浏览器里就是 `a[download]`；原生壳里必须换路子 —— **WKWebView 不实现 `a[download]`**，
 * 点下去什么都不会发生（不报错、不下载，是最难查的那种静默失败）。所以原生走
 * Filesystem 写进 App 的 Documents 目录，再拉系统分享面板让用户存去「文件」/iCloud。
 * Documents 目录同时被 Info.plist 的 `UIFileSharingEnabled` 暴露给「文件」App，
 * 所以就算分享面板被划掉，那份 backup 也确实躺在那里，不会白导出一次。
 */
export async function downloadJson(
  filename: string,
  data: unknown,
  { prompt = true }: SaveOptions = {},
): Promise<SaveTarget> {
  const text = JSON.stringify(data, null, 2);

  if (await isNativeShell()) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    await Filesystem.writeFile({
      path: filename,
      data: text,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    if (prompt) {
      const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Documents });
      try {
        const { Share } = await import('@capacitor/share');
        await Share.share({ title: filename, url: uri });
      } catch {
        // 用户划掉分享面板也会走到这里。文件已经写好了，这不是失败。
      }
    }
    return 'native-file';
  }

  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // 不要在 click() 之后同步 revoke：Safari 是异步取这个 blob 的，同步撤销会让
  // 下载变成一个 0 字节的文件。挪到下一个 task 就够，也照样不留内存泄漏。
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return 'browser-download';
}
