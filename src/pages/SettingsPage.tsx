import { useEffect, useRef, useState } from 'react';
import { useSyncStore } from '@/state/useSyncStore';
import { getStorageEstimate, initStoragePersistence, type StorageEstimateResult, type StoragePersistenceStatus } from '@/db';
import { buildBackupJson, backupFileName } from '@/backup/export';
import { prepareImport, commitImport } from '@/backup/import';
import { downloadJson } from '@/lib/download';
import type { BackupFile, MergeResult, MergeSummary } from '@/backup/types';
import { SYNC_API_BASE, isSyncConfigured } from '@/sync/config';
import { ensureGoogleReady } from '@/sync/session';
import { RestoreSection, StudySettingsSection } from './settings/RestoreSection';
import { DictSection } from './settings/DictSection';
import { useSettingsStore } from '@/state/useSettingsStore';
import {
  MMS_FA,
  LOCAL_MODEL_PATH,
  NATIVE_PLAN,
  REMOTE_PLAN,
  PLAN_LADDER,
  hasLocalWeights,
  pickDevice,
  planLabel,
} from '@/align/config';
import { nativeEmissionsAvailable } from '@/align/nativeEmissions';
import { remoteEmissionsAvailable } from '@/align/remoteEmissions';
import { clearJournal, nextPlanStep, readHistory, type AlignRunRecord } from '@/align/journal';
import { nativePlatform } from '@/platform/native';

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
 * （`pickPlan()` 有 WebGPU 走第 1 档，否则走第 2 档），而装机体积里绝大部分是权重，
 * 砍掉没用的那份是最大的一笔。而「iOS 的 WKWebView 到底有没有 WebGPU」
 * 只能在真机上问，猜不出来 —— 所以把答案显示出来。（问出来了：有，走 q4f16。）
 *
 * 顺便探每份权重在不在包里：砍完之后回来看这里就能确认砍对了。
 */
function AlignBackendSection() {
  const [lines, setLines] = useState<string[] | null>(null);
  const [history, setHistory] = useState<AlignRunRecord[]>(() => readHistory());

  useEffect(() => {
    void (async () => {
      const out: string[] = [];
      // 服务器那一档排在最最前面（FR-15.17）：它一旦可用，这一整页余下的每一行
      // 说的都是**这台设备上那条现在不走的路**。
      const remote = await remoteEmissionsAvailable();
      if (remote) {
        out.push(`emissions 由服务器算：${REMOTE_PLAN.device} / ${REMOTE_PLAN.dtype} —— 上行 mp3、下行矩阵，文稿不出设备`);
      }
      // 原生那一档跟在后面：它一旦可用，下面关于 WebGPU / 降档 / 「下一次加载哪份权重」
      // 的每一句话在这台设备上都不再成立 —— 权重压根不进 WebView。
      const native = await nativeEmissionsAvailable();
      if (native) {
        out.push(
          `emissions 由原生插件算：${NATIVE_PLAN.device} / ${NATIVE_PLAN.dtype} —— 权重不进 WebView，也不参与降档`,
        );
      }
      if (native && remote) {
        out.push('原生插件那条还在（服务器不可用时的手动退路，课程页上那个 ghost 按钮）');
      }
      const plan = await pickDevice();
      out.push(
        native
          ? `WebView 那条路（现在不走）：${plan.device} / ${plan.dtype}`
          : `这台设备能跑的最优后端：${plan.device} / ${plan.dtype}`,
      );
      // 崩过就降档（journal.ts）。下面那个「实际用的是这份」的箭头要跟着降档走，
      // 不然它指的是一份下一次根本不会加载的权重 —— 而这一页存在的理由就是「砍掉没用的那份」。
      const step = nextPlanStep(PLAN_LADDER.length);
      const next = step === 0 ? plan : PLAN_LADDER[step];
      if (step > 0) {
        out.push(`⚠️ 第 1 档崩过，下一次会降到第 ${step + 1} 档：${next.device} / ${next.dtype}`);
      }
      out.push(`平台：${await nativePlatform()}`);
      out.push(`权重来源：${(await hasLocalWeights(MMS_FA)) ? '随包（public/models/）' : 'HF CDN（首次用时下载）'}`);
      // 探的就是阶梯上那几档,而不是手写一份名单 ——
      // 手写的那份已经漂过一次（第 2 档从 int8 换成 q4 时这里还在探一份压根不带的权重)。
      for (const dtype of PLAN_LADDER.map((p) => p.dtype)) {
        const url = `${LOCAL_MODEL_PATH}${MMS_FA.modelId}/onnx/model_${dtype}.onnx`;
        const mark = dtype === (native ? NATIVE_PLAN.dtype : next.dtype) ? ' ← 下一次实际会加载这份' : '';
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

      {/*
        最近几次对齐的黑匣子。手机上唯一能拿到「上次为什么整个应用消失了」的地方 ——
        进程被系统杀掉时 JS 跑不了任何收尾代码，只有边跑边落盘的记录留得下来。
        细节见 src/align/journal.ts。
      */}
      <h3 className="pt-2 text-sm font-medium">最近几次运行</h3>
      {history.length === 0 ? (
        <p className="text-sm text-neutral-500">还没有记录。</p>
      ) : (
        <ul className="space-y-1 text-xs text-neutral-600">
          {history.map((run) => (
            <li key={run.startedAt} className="font-mono">
              {new Date(run.startedAt).toLocaleString('zh-CN', { hour12: false })}{' · '}
              <span className={run.status === 'crashed' ? 'text-rose-700' : ''}>
                {run.status === 'done'
                  ? '完成'
                  : run.status === 'error'
                    ? `失败（${run.error ?? '?'}）`
                    : '被系统杀掉'}
              </span>
              {' · '}
              {run.stage}
              {run.total ? ` ${formatBytes(run.loaded ?? 0)}/${formatBytes(run.total)}` : ''}
              {' · '}
              {planLabel(run.plan, run.planStep)}{' · '}
              {run.platform}
              {run.weights === 'local' ? (run.ranged ? ' · 分片取权重' : ' · 整份取权重') : ' · CDN 权重'}
              {run.heapMB !== undefined ? ` · 堆 ${run.heapMB}MB` : ''}
              {' · '}
              {Math.round(((run.finishedAt ?? run.updatedAt) - run.startedAt) / 1000)}s
              {' · '}
              {run.title}
            </li>
          ))}
        </ul>
      )}
      {history.length > 0 && (
        <button
          className="text-xs text-neutral-500 underline"
          onClick={() => {
            // 清掉记录同时也清掉「降档」——两者是同一份数据。换了设备或换了包之后
            // 想让第 1 档重新有机会，就点这里。
            clearJournal();
            setHistory([]);
          }}
        >
          清除记录（同时恢复用第 1 档后端）
        </button>
      )}
    </section>
  );
}

/**
 * 只要大小、不要正文 —— 权重有 200MB 量级，真下下来会把这个页面卡死。
 * 先试 HEAD；`capacitor://localhost` 的内建服务器不保证支持 HEAD，
 * 所以退到「只要第一个字节」的 Range 请求，从 content-range 的总长读大小。
 *
 * 一个真实的误报：文件不在时，SPA fallback（Cloudflare 与 vite dev 都会）回的是
 * **200 + index.html**，于是这里显示「1.1 KB」。而这一页的用途就是「确认哪份权重
 * 真的在包里」——「1.1 KB」比「不在包里」更糟，因为它看起来像个答案。
 * 所以任何 .onnx 小于 1MB 一律判成不在包里：真实的两份是 187MB 与 230MB，不存在中间地带。
 */
const MIN_PLAUSIBLE_WEIGHTS_BYTES = 1024 * 1024;

async function probeSize(url: string): Promise<string> {
  const judge = (bytes: number) =>
    bytes >= MIN_PLAUSIBLE_WEIGHTS_BYTES ? formatBytes(bytes) : '不在包里（回的是 index.html）';
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (head.ok) {
      const len = Number(head.headers.get('content-length') ?? 0);
      if (len > 0) return judge(len);
    }
    const ranged = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    if (!ranged.ok && ranged.status !== 206) return '不在包里';
    const total = Number(ranged.headers.get('content-range')?.split('/')[1] ?? 0);
    return total > 0 ? judge(total) : '在包里（大小未知）';
  } catch {
    return '探测失败';
  }
}

// FR-11.1 ~ FR-11.3 的现行形态：一个 Google 登录按钮。
//
// 换掉 GitHub PAT 的理由（SPEC §11 那段决策记录写了全文）：PAT 有有效期、要手动续期、
// 到期即静默失败，而「静默失败的备份」正是 FR-11.9 拼命要防的那类事故。
// Google 会话过期由服务器和插件自己处理，用户这边只剩「登录 / 退出」两个状态。
function AccountSection() {
  const { status, account, errorMessage, signIn, signOut } = useSyncStore();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // web 版的登录 SDK 是插一个 Google 的 <script>。进设置页就先插好 ——
    // 等用户点下去那一刻才开始下载，第一次点必然要多等几秒（插件文档明说
    // 「无法知道脚本何时就绪」）。原生壳里这一步是空转。
    if (isSyncConfigured()) void ensureGoogleReady().catch(() => {});
  }, []);

  const handle = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // 错误已经落在 store 的 errorMessage 里
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 p-4">
      <h2 className="font-semibold">账号与同步（FR-11.1 ~ FR-11.3）</h2>

      {status === 'unconfigured' ? (
        <p className="text-sm text-neutral-500">
          这个构建没有配置同步服务器（缺 <code>VITE_SYNC_API_BASE</code> 或{' '}
          <code>VITE_GOOGLE_WEB_CLIENT_ID</code>）。自动同步整体关闭，手动导出照常可用 ——
          它本来就是不同故障域的第二道保险。
        </p>
      ) : status === 'signed-in' && account ? (
        <div className="space-y-2 text-sm">
          <p className="flex items-center gap-2">
            {account.picture && (
              <img src={account.picture} alt="" className="h-6 w-6 rounded-full" referrerPolicy="no-referrer" />
            )}
            <span>
              ✅ 已登录：<strong>{account.email}</strong>
            </span>
          </p>
          <p className="text-neutral-500">
            服务器：<code>{SYNC_API_BASE}</code>
          </p>
          <button
            className="rounded border border-neutral-300 px-3 py-1 text-sm disabled:opacity-50"
            disabled={busy}
            onClick={() => void handle(signOut)}
          >
            退出登录
          </button>
          <p className="text-xs text-neutral-500">
            退出只清掉这台设备上的登录状态和版本号，服务器上的数据一个字节都不动。
          </p>
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <p>
            用 Google 登录 <code>{SYNC_API_BASE}</code>，之后生词与课程标注会自动同步到那台服务器。
            服务器只认白名单里的邮箱，别人拿同一个按钮登录会被挡在 403。
          </p>
          <button
            className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            disabled={busy || status === 'signing-in'}
            onClick={() => void handle(signIn)}
          >
            {status === 'signing-in' ? '登录中…' : '用 Google 登录'}
          </button>
          {errorMessage && <p className="text-red-600">{errorMessage}</p>}
        </div>
      )}
    </section>
  );
}

function SyncStatusBanner() {
  const { status, lastSuccessAt, lastPullAt, pendingCount, refreshStatus } = useSyncStore();

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  if (status !== 'signed-in') return null;

  return (
    <section className="space-y-1 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm">
      <h2 className="font-semibold">同步状态（FR-11.9：常驻可见）</h2>
      <p>上次推送成功：{lastSuccessAt ? formatDateTime(lastSuccessAt) : '尚未推送过'}</p>
      {/* 拉那一半单独一行（FR-11.19）：推通了不代表拉通了，而「拉悄悄停了」的症状
          就是「另一台设备上的东西一直不来」—— 两个时刻必须分开看。 */}
      <p>上次拉取成功：{lastPullAt ? formatDateTime(lastPullAt) : '尚未拉取过'}</p>
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
  const hydrate = useSyncStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-bold">设置</h1>
      <StorageSection />
      <DictSection />
      <AlignBackendSection />
      <AccountSection />
      <SyncStatusBanner />
      <ManualBackupSection />
      <RestoreSection />
      <StudySettingsSection />
    </div>
  );
}
