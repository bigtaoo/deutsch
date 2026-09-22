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
import { VersionSection } from './settings/VersionSection';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useLessonStore } from '@/state/useLessonStore';
import { useVocabStore } from '@/state/useVocabStore';
import { useStudyStore } from '@/state/useStudyStore';
import {
  GERMAN_CTC,
  WEIGHTS_BASE,
  LOCAL_MODEL_PATH,
  REMOTE_PLAN,
  PLAN_LADDER,
  hasLocalWeights,
  pickDevice,
  planLabel,
} from '@/align/config';
import { remoteEmissionsAvailable } from '@/align/remoteEmissions';
import { clearJournal, nextPlanStep, readHistory, type AlignRunRecord } from '@/align/journal';
import { nativePlatform } from '@/platform/native';
import { Banner, Button, Chip, Disclosure, FilePicker, Hint, Note, Section } from '@/components/ui';

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
    <Section
      title="本机存储"
      aside={<Button onClick={() => void requestPersist()}>申请持久化存储</Button>}
    >
      {estimate && !estimate.unsupported && (
        <p className="tnum text-ui text-muted">
          已用 {formatBytes(estimate.usageBytes)} / 配额 {formatBytes(estimate.quotaBytes)}
        </p>
      )}
      {estimate?.unsupported && <Hint>此浏览器不支持用量查询。</Hint>}
      {persistence &&
        (persistence.persisted ? (
          <Note tone="ok">已获得持久化存储，浏览器不会自动清空数据。</Note>
        ) : persistence.unsupported ? (
          <Note tone="warn">此浏览器不支持持久化存储请求（iOS 请务必「添加到主屏幕」）。</Note>
        ) : (
          <Note tone="warn">没拿到持久化存储，数据仍可能被浏览器驱逐。</Note>
        ))}
    </Section>
  );
}

/**
 * 对齐后端诊断（FR-15）。剩下的用处只有一个：**「为什么这台设备上对齐跑不动」**。
 *
 * 它回答的是三个只能在真机上问、猜不出来的问题：这台设备走 WebGPU 还是 wasm、
 * 权重是从随包拿的还是从权重站下的、以及最近几次运行各自怎么结束的。
 * 变更 42 之后 iOS 上根本没有本机这条路，所以第一行会先把那句话说清楚 ——
 * 否则下面每一行说的都是一条这台设备不走的路。
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
      const platform = await nativePlatform();
      // iOS 原生壳上**没有本机这条路**（变更 42）：下面关于 WebGPU / 降档 /
      // 「下一次加载哪份权重」的每一句话在那台设备上都不成立，所以先把话说清楚。
      const phone = platform === 'ios';
      if (phone) {
        out.push('这台设备不自己算 emissions —— 手机上只有服务器那条路（变更 42）');
      }
      const plan = await pickDevice();
      out.push(
        phone
          ? `WebView 那条路（不走，仅供参考）：${plan.device} / ${plan.dtype}`
          : `这台设备能跑的最优后端：${plan.device} / ${plan.dtype}`,
      );
      // 崩过就降档（journal.ts）。下面那个「实际用的是这份」的箭头要跟着降档走，
      // 不然它指的是一份下一次根本不会加载的权重 —— 而这一页存在的理由就是「砍掉没用的那份」。
      const step = nextPlanStep(PLAN_LADDER.length);
      const next = step === 0 ? plan : PLAN_LADDER[step];
      if (step > 0) {
        out.push(`⚠️ 第 1 档崩过，下一次会降到第 ${step + 1} 档：${next.device} / ${next.dtype}`);
      }
      out.push(`平台：${platform}`);
      const bundled = await hasLocalWeights(GERMAN_CTC);
      out.push(
        bundled
          ? '权重来源：随包（public/models/）'
          : WEIGHTS_BASE
            ? `权重来源：${WEIGHTS_BASE}（首次用时下载约 230MB，之后进 Cache API）`
            : '权重来源：**没有** —— 这个构建没配同步服务器，本机对齐取不到权重',
      );
      // 探的就是阶梯上那几档,而不是手写一份名单 ——
      // 手写的那份已经漂过一次（第 2 档从 int8 换成 q4 时这里还在探一份压根不带的权重)。
      for (const dtype of PLAN_LADDER.map((p) => p.dtype)) {
        const url = `${bundled ? LOCAL_MODEL_PATH : WEIGHTS_BASE}${GERMAN_CTC.modelId}/onnx/model_${dtype}.onnx`;
        const mark = !phone && dtype === next.dtype ? ' ← 下一次实际会加载这份' : '';
        out.push(`　model_${dtype}.onnx：${await probeSize(url)}${mark}`);
      }
      setLines(out);
    })();
  }, []);

  return (
    <Section title="对齐后端">
      <Hint>这一段只在排查「为什么这台设备上对齐跑不动」时有用。</Hint>
      <Disclosure summary="探测结果与最近几次运行">
      {lines
        ? lines.map((l) => (
            <p key={l} className="text-ui text-muted">
              {l}
            </p>
          ))
        : <p className="text-ui text-muted">探测中…</p>}

      {/*
        最近几次对齐的黑匣子。手机上唯一能拿到「上次为什么整个应用消失了」的地方 ——
        进程被系统杀掉时 JS 跑不了任何收尾代码，只有边跑边落盘的记录留得下来。
        细节见 src/align/journal.ts。
      */}
      <p className="pt-2 text-ui font-medium">最近几次运行</p>
      {history.length === 0 ? (
        <p className="text-ui text-muted">还没有记录。</p>
      ) : (
        <ul className="space-y-1 text-note text-muted">
          {history.map((run) => (
            <li key={run.startedAt} className="font-mono">
              {new Date(run.startedAt).toLocaleString('zh-CN', { hour12: false })}{' · '}
              <span className={run.status === 'crashed' ? 'text-danger' : ''}>
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
              {run.weights === 'local' ? (run.ranged ? ' · 分片取权重' : ' · 整份取权重') : run.weights === 'server' ? ' · 权重站' : ' · 权重在服务器上'}
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
          className="text-note text-muted underline"
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
      </Disclosure>
    </Section>
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
    <Section title="账号">
      {status === 'unconfigured' ? (
        <Note tone="warn">
          这个构建没有配置同步服务器（缺 <code>VITE_SYNC_API_BASE</code> 或{' '}
          <code>VITE_GOOGLE_WEB_CLIENT_ID</code>）。自动同步整体关闭，手动导出照常可用。
        </Note>
      ) : status === 'signed-in' && account ? (
        <div className="space-y-2 text-ui">
          <p className="flex items-center gap-2">
            {account.picture && (
              <img src={account.picture} alt="" className="size-6 rounded-full" referrerPolicy="no-referrer" />
            )}
            <strong className="min-w-0 truncate">{account.email}</strong>
            <Chip tone="ok">已登录</Chip>
          </p>
          <SyncTimes />
          <p className="text-note text-muted">
            服务器 <code>{SYNC_API_BASE}</code>
          </p>
          <Button disabled={busy} onClick={() => void handle(signOut)}>
            退出登录
          </Button>
          <Hint>退出只清掉这台设备上的登录状态和版本号，服务器上的数据一个字节都不动。</Hint>
        </div>
      ) : (
        <div className="space-y-2 text-ui">
          <p>登录之后生词与课程标注会自动同步。</p>
          <Button
            variant="primary"
            disabled={busy || status === 'signing-in'}
            onClick={() => void handle(signIn)}
          >
            {status === 'signing-in' ? '登录中…' : '用 Google 登录'}
          </Button>
          <Hint>
            服务器 <code>{SYNC_API_BASE}</code> 只认白名单里的邮箱，别人拿同一个按钮登录会被挡在 403。
          </Hint>
          {errorMessage && <Hint tone="danger">{errorMessage}</Hint>}
        </div>
      )}
    </Section>
  );
}

/**
 * 同步的**绝对时刻**。头部那个芯片给的是「几天前」那种摘要（FR-11.9 要求常驻可见
 * 的那一份），而在跟服务器对账时要的是精确到分钟的时刻 —— 两者用途不同，都留着。
 */
function SyncTimes() {
  const { lastSuccessAt, lastPullAt, pendingCount, refreshStatus } = useSyncStore();

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const offlineQueued = typeof navigator !== 'undefined' && !navigator.onLine && pendingCount > 0;

  return (
    <div className="space-y-1 text-note text-muted">
      <p>上次推送成功：{lastSuccessAt ? formatDateTime(lastSuccessAt) : '尚未推送过'}</p>
      {/* 拉那一半单独一行（FR-11.19）：推通了不代表拉通了，而「拉悄悄停了」的症状
          就是「另一台设备上的东西一直不来」—— 两个时刻必须分开看。 */}
      <p>上次拉取成功：{lastPullAt ? formatDateTime(lastPullAt) : '尚未拉取过'}</p>
      <p className={pendingCount > 0 ? 'text-warn' : undefined}>
        待推送 {pendingCount} 项
        {offlineQueued && ' —— 当前离线，恢复网络后自动重试'}
      </p>
    </div>
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
        // 原生壳里文件落在 App 的 Documents 目录（「文件」App → 努力学德语），分享面板只是顺手
        // 给一次「存到别处」的机会。不说清楚的话，划掉面板的人会以为这次导出没成。
        (target === 'native-file' ? '文件已存到「文件」App 的「努力学德语」文件夹。' : ''),
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
    // commitImport 写的是 IndexedDB，内存里的 store 要重读一遍才看得到 ——
    // 不重读的话，点完「确认导入」界面上**什么都不会变**，课程列表照旧是空的，
    // 要手动刷新一次才出现。从服务器恢复那一条（RestoreSection）一直是这么做的，
    // 这一条以前漏了。学习记录也在内：它同样由 commitImport 写。
    await Promise.all([
      useLessonStore.getState().load(),
      useVocabStore.getState().load(),
      useSettingsStore.getState().load(),
      useStudyStore.getState().load(),
    ]);
    pendingResultRef.current = null;
    setPendingSummary(null);
  };

  return (
    <Section
      title="手动导出与导入"
      aside={
        <Button variant="primary" onClick={() => void handleExport()}>
          导出备份 JSON
        </Button>
      }
    >
      <Hint>
        自动同步是主力。手动导出防的是同步服务器本身出问题（机器没了、证书过期、账号登不上）——
        两者是不同的故障域。
      </Hint>
      {exportMessage && <Note tone="ok">{exportMessage}</Note>}

      <div className="space-y-2">
        <FilePicker
          accept="application/json"
          onPick={(file) => {
            if (file) void handleFileSelected(file);
          }}
        >
          选一份备份 JSON 导入…
        </FilePicker>
        {importError && (
          <Banner tone="danger" title="这个备份文件读不出来">
            <p>{importError}</p>
          </Banner>
        )}
        {pendingSummary && (
          <Banner
            tone="warn"
            title="确认这次合并"
            action={
              <Button variant="primary" onClick={() => void handleConfirmImport()}>
                确认导入
              </Button>
            }
          >
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
          </Banner>
        )}
      </div>
    </Section>
  );
}

export function SettingsPage() {
  const hydrate = useSyncStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="hidden text-title font-semibold sm:block">设置</h1>
      {/* 顺序 = 会碰它的频率。诊断（存储用量、对齐后端探测）排在最后 ——
          它们以前是这一页的头两块，而那两块一年也用不到一次。 */}
      <AccountSection />
      <StudySettingsSection />
      <ManualBackupSection />
      <RestoreSection />
      <DictSection />
      <StorageSection />
      <AlignBackendSection />
      <VersionSection />
    </div>
  );
}
