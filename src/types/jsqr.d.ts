// jsqr 没有官方类型定义，这里只声明用到的最小子集。
declare module 'jsqr' {
  export interface QRPoint {
    x: number;
    y: number;
  }

  export interface QRCode {
    data: string;
    location: {
      topLeftCorner: QRPoint;
      topRightCorner: QRPoint;
      bottomLeftCorner: QRPoint;
      bottomRightCorner: QRPoint;
    };
  }

  export default function jsQR(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    options?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' },
  ): QRCode | null;
}
