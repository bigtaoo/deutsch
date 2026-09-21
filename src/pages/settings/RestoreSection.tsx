// FR-11.13 一键恢复 + FR-11.15 每年提示恢复演练 + FR-12 学习设置。
//
// 这三块单独一个文件，是因为 SettingsPage 已经被账号与同步那一段占满了，
// 而恢复是**验收清单里唯一「不做完不算通过」**的一项，值得自己一块地方。

import { useEffect, useState } from 'react';
import { getMeta, putMeta } from '@/db/meta';
import { restoreFromServer, type RestoreResult } from '@/sync/restore';
import { useSyncStore } from '@/state/useSyncStore';
import { useLessonStore } from '@/state/useLessonStore';
import { useVocabStore } from '@/state/useVocabStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { useStudyStore } from '@/state/useStudyStore';
import { Banner, Button, Hint, Note, Section, field } from '@/components/ui';

const DRILL_META_KEY = 'lastRestoreDrillAt';
const DRILL_INTERVAL_MS = 365 * 86_400_000;

export function RestoreSection() {
  const { status, account } = useSyncStore();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastDrillAt, setLastDrillAt] = useState<number | null>(null);

  useEffect(() => {
    void getMeta<number>(DRILL_META_KEY).then((value) => setLastDrillAt(value ?? null));
  }, []);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await restoreFromServer();
      setResult(outcome);
      await putMeta(DRILL_META_KEY, Date.now());
      setLastDrillAt(Date.now());
      // 恢复写的是 IndexedDB，内存里的 store 要重新读一遍才能看到（设置也在内，§0 变更 28；
      // 学习记录同理 —— restoreFromServer 会合并它，不重读的话记录页停在恢复前的数）
      await Promise.all([
        useLessonStore.getState().load(),
        useVocabStore.getState().load(),
        useSettingsStore.getState().load(),
        useStudyStore.getState().load(),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const drillOverdue = lastDrillAt === null || Date.now() - lastDrillAt > DRILL_INTERVAL_MS;

  return (
    <Section title="从服务器恢复">
      {status !== 'signed-in' || !account ? (
        <Hint>先在上面用 Google 登录。</Hint>
      ) : (
        <>
          <Hint>
            把 {account.email} 在服务器上的生词与全部课程拉下来，按合并规则写入本机（本机更新过的部分留住）。
            只恢复标注层（含设置）—— 音频与原文按设计不上传，所以课程会显示「素材未下载」，
            打开那一课时会自动补齐。
          </Hint>

          {/* FR-11.15：工具在变，恢复路径会悄悄坏掉。每年提醒重演一次。 */}
          {drillOverdue && (
            <Banner
              tone="warn"
              title={lastDrillAt === null ? '这条恢复路径还没验证过' : '距上次恢复演练已超过一年'}
            >
              <p>
                {lastDrillAt === null
                  ? '备份没验证过就等于没有备份。现在点一次「一键恢复」—— 它是幂等的，不会覆盖本机更新的东西。'
                  : '跑一次，确认这条路还通。'}
              </p>
            </Banner>
          )}

          <Button variant="primary" disabled={busy} onClick={() => void run()}>
            {busy ? '恢复中…' : '一键恢复'}
          </Button>

          {error && (
            <Banner tone="danger" title="恢复失败">
              <p>{error}</p>
            </Banner>
          )}

          {result && (
            <Banner
              tone={result.failures.length > 0 ? 'warn' : 'ok'}
              title={result.failures.length > 0 ? '恢复完成，但有几份没读出来' : '恢复完成'}
            >
              <p>
                拉取 {result.lessonsFetched} 课 / {result.vocabFetched} 个生词。
                新增课程 {result.summary.addedLessons.length}、更新 {result.summary.updatedLessons.length}、
                跳过（本机更新）{result.summary.skippedLessons.length}；
                新增生词 {result.summary.addedVocab.length}、更新 {result.summary.updatedVocab.length}。
              </p>
              {result.settingsRestored && <p className="mt-1">设置也已从服务器恢复。</p>}
              {result.summary.overwrittenLessonTitles.length > 0 && (
                <p className="mt-1">被覆盖的课程：{result.summary.overwrittenLessonTitles.join('、')}</p>
              )}
              {result.failures.length > 0 && (
                <p className="mt-1">这些文档没能读出来：{result.failures.join('；')}</p>
              )}
            </Banner>
          )}

          {lastDrillAt && (
            <Hint>上次恢复：{new Date(lastDrillAt).toLocaleString('zh-CN', { hour12: false })}</Hint>
          )}
        </>
      )}
    </Section>
  );
}

/** FR-12：学习参数。默认值的理由写在 SPEC 的表里，这里只把它复述给使用者。 */
export function StudySettingsSection() {
  const { settings, update } = useSettingsStore();

  const numberField = (
    label: string,
    key: 'newPerDay' | 'reviewPerDay' | 'shadowingRepeat' | 'shadowingGapRatio',
    hint: string,
    step = 1,
  ) => (
    <label className="flex flex-wrap items-center gap-2 text-ui">
      <span className="w-32">{label}</span>
      <input
        type="number"
        step={step}
        min={0}
        className={`${field} w-24 px-2 py-1`}
        value={settings[key]}
        onChange={(e) => void update({ [key]: Number(e.target.value) || 0 })}
      />
      <span className="text-muted">{hint}</span>
    </label>
  );

  return (
    <Section title="学习参数">
      {numberField('每日新卡', 'newPerDay', '每周 1 篇 ≈ 每天 3–4 个新词，设 30 会周一清空、之后空转')}
      {numberField('每日复习上限', 'reviewPerDay', '防爆闸，正常不会触顶')}
      {numberField('跟读重复次数', 'shadowingRepeat', '0 = 无限，手动推进')}
      {numberField('静默间隔倍数', 'shadowingGapRatio', '静默时长 = 句子时长 × 这个值', 0.1)}
      <label className="flex items-center gap-2 text-ui">
        <input
          type="checkbox"
          checked={settings.dictationStrictCase}
          onChange={(e) => void update({ dictationStrictCase: e.target.checked })}
        />
        听写严格区分大小写（关掉后大小写错不计错）
      </label>
      <label className="flex items-center gap-2 text-ui">
        <input
          type="checkbox"
          checked={settings.autoAlignOnImport}
          onChange={(e) => void update({ autoAlignOnImport: e.target.checked })}
        />
        下载课程后自动对齐音频与文稿
      </label>
      <Note>
        关掉只是不再自动跑 —— 课程页头部那个「自动对齐」按钮永远可用。
      </Note>
    </Section>
  );
}
