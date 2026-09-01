import { useEffect, useRef, useState } from 'react';
import { useBackupStore, isExpiryWarningActive } from '@/state/useBackupStore';
import { getStorageEstimate, initStoragePersistence, type StorageEstimateResult, type StoragePersistenceStatus } from '@/db';
import { buildBackupJson, backupFileName } from '@/backup/export';
import { prepareImport, commitImport } from '@/backup/import';
import { downloadJson } from '@/lib/download';
import { generatePairingQrDataUrl, decodePairingPayload, type PairingPayload } from '@/lib/qrPairing';
import { QrScanner } from '@/components/QrScanner';
import type { BackupFile, MergeResult, MergeSummary } from '@/backup/types';
import type { RepoRef } from '@/github/repo';
import { RestoreSection, StudySettingsSection } from './settings/RestoreSection';
import { useSettingsStore } from '@/state/useSettingsStore';
import { MMS_FA, LOCAL_MODEL_PATH, hasLocalWeights, pickDevice } from '@/align/config';
import { nativePlatform } from '@/platform/native';

const PAT_CREATE_URL = 'https://github.com/settings/personal-access-tokens/new';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function StorageSection() {
  const [persistence, setPersistence] = useState<StoragePersistenceStatus | null>(null);
  const [estimate, setEstimate] = useState<StorageEstimateResult | null>(null);

  useEffect(() => {
    void getStorageEstimate().then(setEstimate);
  }, []);

  const requestPersist = async () => {
    const status = await initStoragePersistence();
    setPersistence(status);
  };

  return (
    <section className="space-y-2 rounded-lg border border-neutral-200 p-4">
      <h2 className="font-semibold">存储（§2.2 / FR-11.16）</h2>
      {estimate && !estimate.unsupported && (
        <p className="text-sm text-neutral-600">
          已用 {formatBytes(estimate.usageBytes)} / 配额 {formatBytes(estimate.quotaBytes)}
        </p>
      )}
      {estimate?.unsupported && <p className="text-sm text-neutral-500">此浏览器不支持用量查询。</p>}
      <button className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-white" onClick={requestPersist}>
        申请持久化存储
      </button>
      {persistence && (
        <p className="text-sm">
          {persistence.unsupported
            ? '此浏览器不支持持久化存储请求（iOS 请务必"添加到主屏幕"）。'
            : persistence.persisted
              ? '✅ 已获得持久化存储，浏览器不会自动清空数据。'
              : '⚠️ 未获得持久化存储，数据仍可能被浏览器驱逐。'}
        </p>
      )}
    </section>
  );
}

/**
 * 对齐后端诊断（FR-15）。存在的理由很具体：**IPA 里两份权重只会用到一份**
 * （`pickDevice()` 有 WebGPU 走 q4f16，退 WASM 走 int8），但装机 553MB 里
 * 490MB 是权重，砍掉没用的那份是最大的一笔。而「iOS 的 WKWebView 到底有没有
 * WebGPU」只能在真机上问，猜不出来 —— 所以把答案显示出来。
 *
 * 顺便探每份权重在不在包里：砍完之后回来看这里就能确认砍对了。
 */
function AlignBackendSection() {
  const [lines, setLines] = useState<string[] | null>(null);

  useEffect(() => {
    void (async () => {
      const out: string[] = [];
      const plan = await pickDevice();
      out.push(`推理后端：${plan.device} / ${plan.dtype}`);
      out.push(`平台：${await nativePlatform()}`);
      out.push(`权重来源：${(await hasLocalWeights(MMS_FA)) ? '随包（public/models/）' : 'HF CDN（首次用时下载）'}`);
      for (const dtype of ['q4f16', 'int8'] as const) {
        const url = `${LOCAL_MODEL_PATH}${MMS_FA.modelId}/onnx/model_${dtype}.onnx`;
        const mark = dtype === plan.dtype ? ' ← 这台设备实际用的是这份' : '';
        out.push(`　model_${dtype}.onnx：${await probeSize(url)}${mark}`);
      }
      setLines(out);
    })();
  }, []);

  return (
    <section className="space-y-2 rounded-lg border border-neutral-200 p-4">
      <h2 className="font-semibold">对齐后端（FR-15 诊断）</h2>
      {lines
        ? lines.map((l) => (
            <p key={l} className="text-sm text-neutral-600">
              {l}
            </p>
          ))
        : <p className="text-sm text-neutral-500">探测中…</p>}
    </section>
  );
}

/**
 * 只要大小、不要正文 —— 权重有 300MB，真下下来会把这个页面卡死。
 * 先试 HEAD；`capacitor://localhost` 的内建服务器不保证支持 HEAD，
 * 所以退到「只要第一个字节」的 Range 请求，从 content-range 的总长读大小。
 */
async function probeSize(url: string): Promise<string> {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (head.ok) {
      const len = Number(head.headers.get('content-length') ?? 0);
      if (len > 0) return formatBytes(len);
    }
    const ranged = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    if (!ranged.ok && ranged.status !== 206) return '不在包里';
    const total = Number(ranged.headers.get('content-range')?.split('/')[1] ?? 0);
    return total > 0 ? formatBytes(total) : '在包里（大小未知）';
  } catch {
    return '探测失败';
  }
}

function ConnectSection() {
  const {
    status,
    identity,
    tokenLast4,
    tokenExpiresAt,
    errorMessage,
    connectWithToken,
    chooseExistingRepo,
    disconnect,
  } = useBackupStore();
  const [tokenInput, setTokenInput] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  const handleConnect = async () => {
    const token = tokenInput.trim();
    if (!token) return;
    setTokenInput('');
    try {
      await connectWithToken(token);
    } catch {
      // 错误已经落在 store 的 errorMessage 里，这里不需要再处理
    }
  };

  const handleScanned = async (raw: string) => {
    setScanning(false);
    setScanMessage(null);
    const payload = decodePairingPayload(raw);
    try {
      await connectWithToken(payload.token);
      if (payload.repo) {
        const verification = await chooseExistingRepo(payload.repo);
        setScanMessage(
          verification.writable
            ? '✅ 已连接，并自动选好了配对设备用的那个仓库。'
            : `已连接，但仓库校验没通过：${verification.reason}`,
        );
      } else {
        setScanMessage('✅ 已连接。这台设备还没选仓库，去下面选或建一个。');
      }
    } catch (err) {
      setScanMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 p-4">
      <h2 className="font-semibold">GitHub 连接（FR-11.1 ~ FR-11.5）</h2>

      {status !== 'connected' && (
        <div className="space-y-2 text-sm">
          <p>
            1. 打开{' '}
            <a className="underline" href={PAT_CREATE_URL} target="_blank" rel="noreferrer">
              创建 fine-grained token
            </a>
            2. Resource owner 选你自己的账号 3. Repository access 选{' '}
            <strong>"All repositories"</strong>（备份仓库这时候还不存在，选不了具体某一个；
            一键建仓成功后可以回来改成只选那一个仓库，token 字符串不会变） 4. Permissions →
            Repository permissions → <strong>Contents</strong> 设为{' '}
            <strong>Read and write</strong>，其余保持 No access 5. 生成后复制 token（形如{' '}
            <code>github_pat_...</code>），粘贴到下面
          </p>
          <p className="text-amber-700">
            不要用 classic PAT 的 <code>repo</code> scope —— 那会交出你全部仓库的读写权。
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              className="flex-1 rounded border border-neutral-300 px-2 py-1.5 text-sm"
              placeholder="github_pat_..."
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
            />
            <button
              className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              disabled={status === 'connecting' || !tokenInput.trim()}
              onClick={handleConnect}
            >
              {status === 'connecting' ? '连接中…' : '连接'}
            </button>
          </div>
          {errorMessage && <p className="text-red-600">{errorMessage}</p>}

          <div className="border-t border-neutral-200 pt-2">
            <p className="mb-1 text-neutral-500">已经在另一台设备上连过？可以直接扫码，不用重新敲一遍。</p>
            {!scanning ? (
              <button className="rounded border border-neutral-300 px-3 py-1 text-sm" onClick={() => setScanning(true)}>
                扫码连接
              </button>
            ) : (
              <QrScanner onDecoded={(raw) => void handleScanned(raw)} onCancel={() => setScanning(false)} />
            )}
            {scanMessage && <p className="mt-1">{scanMessage}</p>}
          </div>
        </div>
      )}

      {status === 'connected' && (
        <div className="space-y-1 text-sm">
          <p>
            ✅ 已连接：<strong>@{identity?.login ?? '…'}</strong>
            {tokenLast4 && <span className="text-neutral-500"> （token 末四位 {tokenLast4}）</span>}
          </p>
          {tokenExpiresAt && (
            <p className={isExpiryWarningActive({ tokenExpiresAt }) ? 'text-amber-700' : 'text-neutral-500'}>
              Token 到期时间：{tokenExpiresAt.toLocaleDateString('zh-CN')}
              {isExpiryWarningActive({ tokenExpiresAt }) && '（即将过期，请续期）'}
            </p>
          )}
          <button className="rounded border border-neutral-300 px-3 py-1 text-sm" onClick={() => void disconnect()}>
            断开连接
          </button>
        </div>
      )}
    </section>
  );
}

function RepoSection() {
  const { status, repo, createRepo, listExistingRepos, chooseExistingRepo } = useBackupStore();
  const [repoName, setRepoName] = useState('deutsch-listening-backup');
  const [existing, setExisting] = useState<RepoRef[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (status !== 'connected') return null;

  const handleCreate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await createRepo(repoName);
      setMessage('✅ 仓库创建成功，已设为备份目标。');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleLoadExisting = async () => {
    setBusy(true);
    try {
      setExisting(await listExistingRepos());
    } finally {
      setBusy(false);
    }
  };

  const handleChoose = async (ref: RepoRef) => {
    setBusy(true);
    setMessage(null);
    try {
      const verification = await chooseExistingRepo(ref);
      setMessage(
        verification.writable
          ? `✅ 已选择 ${ref.owner}/${ref.repo}`
          : `❌ 无法使用该仓库：${verification.reason}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 p-4">
      <h2 className="font-semibold">备份仓库（FR-11.3 / FR-11.4）</h2>

      {repo ? (
        <p className="text-sm">
          当前仓库：<code>{repo.owner}/{repo.repo}</code>
        </p>
      ) : (
        <p className="text-sm text-neutral-500">尚未选择备份仓库。全程不需要手填 owner/repo。</p>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
          value={repoName}
          onChange={(e) => setRepoName(e.target.value)}
        />
        <button
          className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          disabled={busy}
          onClick={() => void handleCreate()}
        >
          一键创建私有仓库
        </button>
        <button
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={busy}
          onClick={() => void handleLoadExisting()}
        >
          从已有私有仓库选择
        </button>
      </div>

      {existing && (
        <ul className="space-y-1 text-sm">
          {existing.map((ref) => (
            <li key={`${ref.owner}/${ref.repo}`}>
              <button className="underline" onClick={() => void handleChoose(ref)}>
                {ref.owner}/{ref.repo}
              </button>
            </li>
          ))}
          {existing.length === 0 && <li className="text-neutral-500">没有找到私有仓库。</li>}
        </ul>
      )}

      {message && <p className="text-sm">{message}</p>}
    </section>
  );
}

const PAIRING_QR_AUTO_HIDE_MS = 90_000;

function PairingSection() {
  const { status, repo, exportTokenForPairing } = useBackupStore();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  if (status !== 'connected') return null;

  const handleGenerate = async () => {
    const token = await exportTokenForPairing();
    if (!token) return;
    const payload: PairingPayload = repo ? { v: 1, token, repo } : { v: 1, token };
    setQrDataUrl(await generatePairingQrDataUrl(payload));
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setQrDataUrl(null), PAIRING_QR_AUTO_HIDE_MS);
  };

  const handleHide = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setQrDataUrl(null);
  };

  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 p-4">
      <h2 className="font-semibold">配对新设备</h2>
      <p className="text-sm text-neutral-500">
        在新设备的"GitHub 连接"里点"扫码连接"，用它的摄像头扫这张图，就不用在那台设备上手动敲 token
        {repo ? '，仓库也会一起选好' : ''}。
      </p>

      {!qrDataUrl ? (
        <button className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-white" onClick={() => void handleGenerate()}>
          生成配对二维码
        </button>
      ) : (
        <div className="space-y-2">
          <img src={qrDataUrl} alt="配对二维码" className="h-48 w-48" />
          <p className="text-sm text-amber-700">
            ⚠️ 谁扫到这张图，谁就拿到了这个仓库的读写权限 —— 别截图发给别人、别在别人能看到屏幕的地方久留。
            扫完立刻点"隐藏"，{PAIRING_QR_AUTO_HIDE_MS / 1000} 秒后也会自动隐藏。
          </p>
          <button className="rounded border border-neutral-300 px-3 py-1 text-sm" onClick={handleHide}>
            立即隐藏
          </button>
        </div>
      )}
    </section>
  );
}

function BackupStatusBanner() {
  const { status, lastSuccessAt, pendingCount, refreshPendingCount } = useBackupStore();

  useEffect(() => {
    void refreshPendingCount();
  }, [refreshPendingCount]);

  if (status !== 'connected') return null;

  return (
    <section className="space-y-1 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm">
      <h2 className="font-semibold">备份状态（FR-11.9：常驻可见）</h2>
      <p>上次成功备份：{lastSuccessAt ? formatDateTime(lastSuccessAt) : '尚未备份过'}</p>
      <p>{pendingCount > 0 ? `⏳ ${pendingCount} 项待推送` : '✅ 没有待推送的变更'}</p>
      {typeof navigator !== 'undefined' && !navigator.onLine && pendingCount > 0 && (
        <p className="text-amber-700">当前离线，已排队，恢复网络后自动重试（FR-11.10）。</p>
      )}
    </section>
  );
}

function ManualBackupSection() {
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [pendingSummary, setPendingSummary] = useState<MergeSummary | null>(null);
  const pendingResultRef = useRef<MergeResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const handleExport = async () => {
    const backup = await buildBackupJson();
    const target = await downloadJson(backupFileName(), backup);
    // FR-11.12 的 90 天提醒读的就是这个时间戳；不记的话首页横幅会一直挂着。
    await useSettingsStore.getState().update({ lastBackupAt: Date.now() });
    setExportMessage(
      `已导出 ${backup.lessons.length} 课 / ${backup.vocab.length} 个生词。` +
        // 原生壳里文件落在 App 的 Documents 目录（「文件」App → 精听），分享面板只是顺手
        // 给一次「存到别处」的机会。不说清楚的话，划掉面板的人会以为这次导出没成。
        (target === 'native-file' ? '文件已存到「文件」App 的「精听」文件夹。' : ''),
    );
  };

  const handleFileSelected = async (file: File) => {
    setImportError(null);
    setPendingSummary(null);
    pendingResultRef.current = null;
    try {
      const text = await file.text();
      const incoming = JSON.parse(text) as BackupFile;
      const { safetySnapshot, result } = await prepareImport(incoming);
      // FR-11.14：导入前自动先导出一份当前状态（防呆）。
      // prompt: false —— 这一份不是用户点的「导出」，原生壳里不要在导入流程中间弹分享面板。
      await downloadJson(`before-import-${backupFileName()}`, safetySnapshot, { prompt: false });
      pendingResultRef.current = result;
      setPendingSummary(result.summary);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfirmImport = async () => {
    if (!pendingResultRef.current) return;
    await commitImport(pendingResultRef.current);
    pendingResultRef.current = null;
    setPendingSummary(null);
  };

  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 p-4">
      <h2 className="font-semibold">手动导出 / 导入（FR-11.11 / FR-11.14，第二道保险）</h2>

      <div className="flex items-center gap-2">
        <button className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-white" onClick={() => void handleExport()}>
          导出备份 JSON
        </button>
        {exportMessage && <span className="text-sm text-neutral-600">{exportMessage}</span>}
      </div>

      <div className="space-y-2">
        <input
          type="file"
          accept="application/json"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFileSelected(file);
            e.target.value = '';
          }}
        />
        {importError && <p className="text-sm text-red-600">{importError}</p>}
        {pendingSummary && (
          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
            <p>已自动导出一份当前状态作为防呆备份。合并预览：</p>
            <ul className="list-disc pl-5">
              <li>新增课程 {pendingSummary.addedLessons.length}</li>
              <li>
                更新课程 {pendingSummary.updatedLessons.length}
                {pendingSummary.overwrittenLessonTitles.length > 0 &&
                  `（被覆盖：${pendingSummary.overwrittenLessonTitles.join('、')}）`}
              </li>
              <li>跳过课程（本机更新）{pendingSummary.skippedLessons.length}</li>
              <li>新增生词 {pendingSummary.addedVocab.length}</li>
              <li>更新生词 {pendingSummary.updatedVocab.length}</li>
              <li>跳过生词（本机更新）{pendingSummary.skippedVocab.length}</li>
            </ul>
            <button
              className="mt-2 rounded bg-neutral-800 px-3 py-1.5 text-sm text-white"
              onClick={() => void handleConfirmImport()}
            >
              确认导入
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export function SettingsPage() {
  const hydrate = useBackupStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-bold">设置</h1>
      <StorageSection />
      <AlignBackendSection />
      <ConnectSection />
      <RepoSection />
      <PairingSection />
      <BackupStatusBanner />
      <ManualBackupSection />
      <RestoreSection />
      <StudySettingsSection />
    </div>
  );
}
