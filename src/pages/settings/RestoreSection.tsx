// FR-11.13 一键恢复 + FR-11.15 每年提示恢复演练 + FR-12 学习设置。
//
// 这三块单独一个文件，是因为 SettingsPage 已经被 GitHub 连接那一大段占满了，
// 而恢复是**验收清单里唯一「不做完不算通过」**的一项，值得自己一块地方。

import { useEffect, useState } from 'react';
import { getMeta, putMeta } from '@/db/meta';
import { restoreFromRepo, type RestoreResult } from '@/github/restore';
import { META_KEYS } from '@/db/schema';
import { useBackupStore } from '@/state/useBackupStore';
import { useLessonStore } from '@/state/useLessonStore';
import { useVocabStore } from '@/state/useVocabStore';
import { useSettingsStore } from '@/state/useSettingsStore';
import { Banner, Button, Hint, Section } from '@/components/ui';

const DRILL_META_KEY = 'lastRestoreDrillAt';
const DRILL_INTERVAL_MS = 365 * 86_400_000;

export function RestoreSection() {
  const { status, repo } = useBackupStore();
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
      const token = await getMeta<string>(META_KEYS.githubToken);
      if (!token || !repo) throw new Error('还没连接 GitHub 或没选仓库');
      const outcome = await restoreFromRepo(token, repo);
      setResult(outcome);
      await putMeta(DRILL_META_KEY, Date.now());
      setLastDrillAt(Date.now());
      // 恢复写的是 IndexedDB，内存里的 store 要重新读一遍才能看到
      await Promise.all([useLessonStore.getState().load(), useVocabStore.getState().load()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const drillOverdue = lastDrillAt === null || Date.now() - lastDrillAt > DRILL_INTERVAL_MS;

  return (
    <Section title="从仓库恢复（FR-11.13）">
      {status !== 'connected' || !repo ? (
        <Hint>先连接 GitHub 并选好备份仓库。</Hint>
      ) : (
        <>
          <Hint>
            拉取 {repo.owner}/{repo.repo} 里的 vocab.json 与 lessons/*.json，按 §2.4 合并规则写入本机。
            只恢复标注层；课程会显示「素材未下载」，音频去「来源」页一键补齐。
          </Hint>

          {/* FR-11.15：工具在变，恢复路径会悄悄坏掉。每年提醒重演一次。 */}
          {drillOverdue && (
            <Banner tone="warn">
              {lastDrillAt === null
                ? '还没走过一次恢复。备份没验证过就等于没有备份 —— 现在点一次，它是幂等的。'
                : '距上次恢复演练已超过一年。跑一次，确认这条路还通。'}
            </Banner>
          )}

          <Button variant="primary" disabled={busy} onClick={() => void run()}>
            {busy ? '恢复中…' : '一键恢复'}
          </Button>

          {error && <Banner tone="error">{error}</Banner>}

          {result && (
            <Banner tone={result.failures.length > 0 ? 'warn' : 'ok'}>
              <p>
                拉取 {result.lessonsFetched} 课 / {result.vocabFetched} 个生词。
                新增课程 {result.summary.addedLessons.length}、更新 {result.summary.updatedLessons.length}、
                跳过（本机更新）{result.summary.skippedLessons.length}；
                新增生词 {result.summary.addedVocab.length}、更新 {result.summary.updatedVocab.length}。
              </p>
              {result.summary.overwrittenLessonTitles.length > 0 && (
                <p className="mt-1">被覆盖的课程：{result.summary.overwrittenLessonTitles.join('、')}</p>
              )}
              {result.failures.length > 0 && (
                <p className="mt-1">这些文件没能读出来：{result.failures.join('；')}</p>
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
    <label className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-32">{label}</span>
      <input
        type="number"
        step={step}
        min={0}
        className="w-24 rounded border border-neutral-300 px-2 py-1"
        value={settings[key]}
        onChange={(e) => void update({ [key]: Number(e.target.value) || 0 })}
      />
      <span className="text-neutral-500">{hint}</span>
    </label>
  );

  return (
    <Section title="学习设置（FR-12）">
      {numberField('每日新卡', 'newPerDay', '每周 1 篇 ≈ 每天 3–4 个新词，设 30 会周一清空、之后空转')}
      {numberField('每日复习上限', 'reviewPerDay', '防爆闸，正常不会触顶')}
      {numberField('跟读重复次数', 'shadowingRepeat', '0 = 无限，手动推进')}
      {numberField('静默间隔倍数', 'shadowingGapRatio', '静默时长 = 句子时长 × 这个值', 0.1)}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.dictationStrictCase}
          onChange={(e) => void update({ dictationStrictCase: e.target.checked })}
        />
        听写严格区分大小写（关掉后大小写错不计错）
      </label>
    </Section>
  );
}
