import { useEffect, useRef, useState } from 'react';
import { decodeQrFromImageData } from '@/lib/qrPairing';

interface QrScannerProps {
  onDecoded: (raw: string) => void;
  onCancel: () => void;
}

const CAMERA_SUPPORTED = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/**
 * 摄像头扫码组件。只在用户主动点了"扫码连接"时挂载，卸载时必须停掉摄像头轨道——
 * 这是隐私敏感的权限，不能在后台悄悄占用。
 */
export function QrScanner({ onDecoded, onCancel }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onDecodedRef = useRef(onDecoded);
  onDecodedRef.current = onDecoded;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!CAMERA_SUPPORTED) return;

    let stream: MediaStream | null = null;
    let rafId: number | null = null;
    let stopped = false;

    function scanLoop() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (stopped || !video || !canvas) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const decoded = decodeQrFromImageData(imageData);
          if (decoded) {
            onDecodedRef.current(decoded);
            return; // 找到了就停：父组件会卸载本组件，effect 的 cleanup 负责关摄像头
          }
        }
      }
      rafId = requestAnimationFrame(scanLoop);
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          void videoRef.current.play();
        }
        scanLoop();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      stopped = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  if (!CAMERA_SUPPORTED) {
    return <p className="text-sm text-neutral-500">此设备/浏览器不支持摄像头扫码，请用下面的手动粘贴。</p>;
  }

  return (
    <div className="space-y-2">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video ref={videoRef} className="w-full rounded bg-black" muted playsInline />
      <canvas ref={canvasRef} className="hidden" />
      {error && <p className="text-sm text-red-600">摄像头打不开：{error}</p>}
      <button className="rounded border border-neutral-300 px-3 py-1 text-sm" onClick={onCancel}>
        取消
      </button>
    </div>
  );
}
