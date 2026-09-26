// FR-1.7：导入时确认「哪些行首标记是说话人」。
//
// 候选来自 `detectSpeakers`；符号默认勾上，名字出现两次以上才默认勾上。
// 只出现一次的名字类候选（`Eines gleich vorweg:`、`Viele denken:`）根本不列 ——
// 在真实的 Aspekte 文稿里那一档全是正文里的冒号，列出来只会让人一个个去确认「不是」。

import type { SpeakerCandidate } from '@/lesson/speakers';
import { Hint } from './ui';

export function visibleCandidates(candidates: SpeakerCandidate[]): SpeakerCandidate[] {
  return candidates.filter((c) => c.kind === 'symbol' || c.count >= 2);
}

export function defaultSpeakers(candidates: SpeakerCandidate[]): string[] {
  return visibleCandidates(candidates)
    .filter((c) => c.suggested)
    .map((c) => c.label);
}

export function SpeakerPicker({
  candidates,
  selected,
  onChange,
}: {
  candidates: SpeakerCandidate[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const shown = visibleCandidates(candidates);
  if (shown.length === 0) return null;
  const toggle = (label: string) =>
    onChange(selected.includes(label) ? selected.filter((l) => l !== label) : [...selected, label]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {shown.map((c) => (
          <label
            key={c.label}
            className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-ctl border border-line px-3 text-ui sm:min-h-0 sm:py-1"
          >
            <input type="checkbox" checked={selected.includes(c.label)} onChange={() => toggle(c.label)} />
            <span>{c.label}</span>
            <span className="tnum text-note text-faint">×{c.count}</span>
          </label>
        ))}
      </div>
      <Hint>勾上的是说话人标记：从句子里拿掉（它不念），在句子前面单独标出来。</Hint>
    </div>
  );
}

/** 句子前面那个说话人标记。符号原样画，名字用小一号的字。 */
export function SpeakerMark({ speaker }: { speaker?: string }) {
  if (!speaker) return null;
  return (
    <span className="mr-1.5 inline-block text-note font-medium text-faint select-none" aria-label={`说话人 ${speaker}`}>
      {speaker}
    </span>
  );
}
