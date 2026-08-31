// 设备配对二维码：把 token（以及可选的已选仓库）编码进一个二维码，
// 另一台设备扫码即可跳过手动敲一长串 token 字符、以及重新选一遍仓库。
//
// 安全模型不变：二维码里的内容就是明文 token，效力等同于把 token 念出来给对方抄——
// 谁看到这张图谁就有这个仓库的读写权。这不是新的攻击面，只是比手动输入更方便的传递方式。

import QRCode from 'qrcode';
import jsQR from 'jsqr';
import type { RepoRef } from '@/github/repo';

export interface PairingPayload {
  v: 1;
  token: string;
  repo?: RepoRef;
}

export function encodePairingPayload(payload: PairingPayload): string {
  return JSON.stringify(payload);
}

/**
 * 尽量宽容地解码：正常情况下扫到的是我们自己生成的 JSON；
 * 如果扫到的是别的、不是 JSON 的二维码，就把原始内容当成一个裸 token 处理，
 * 而不是直接报错——反正后续 connectWithToken() 会去验证它是否真的是个有效 token。
 */
export function decodePairingPayload(raw: string): PairingPayload {
  try {
    const parsed = JSON.parse(raw) as Partial<PairingPayload>;
    if (parsed && typeof parsed.token === 'string') {
      return { v: 1, token: parsed.token, repo: parsed.repo };
    }
  } catch {
    // 不是 JSON，走下面的兜底
  }
  return { v: 1, token: raw };
}

export async function generatePairingQrDataUrl(payload: PairingPayload): Promise<string> {
  return QRCode.toDataURL(encodePairingPayload(payload), { errorCorrectionLevel: 'M', margin: 2 });
}

/** 从一帧摄像头画面里找二维码；找不到返回 null，不抛错——大多数帧本来就找不到。 */
export function decodeQrFromImageData(imageData: ImageData): string | null {
  const result = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'dontInvert',
  });
  return result?.data ?? null;
}
