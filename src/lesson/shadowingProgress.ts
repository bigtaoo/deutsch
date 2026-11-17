// FR-6.11：跟读练到第几句，记下来（变更 92）。
//
// 起因：练了一多半，切出去看一条消息回来，循环从第一句重新开始 —— 位置只活在
// `ShadowingMachine` 的内存里，切后台时调的 `stop()` 还顺手把它清成 -1
// （那里的注释写着「暂停并保留位置」，但 `IDLE` 的 position 就是 -1，一直在撒谎）。
//
// 两层一起存，各管各的时间尺度：
//
//   · **本机**（这里）—— 每换一句就写一次。同一台设备上切后台、关进程、刷新页面，
//     回来都在原处。写 localStorage 一次不到 0.1ms，不值得节流。
//   · **课程**（`Lesson.shadowingAt`）—— 离开跟读、切后台、关页面时才写一次。
//     它要跟着同步走，而同步是整份文档推送：每换一句推一次等于把一课练完推五十次。
//
// 读的时候本机优先：本机那份一定不比同步那份旧（同步那份是本机某次离开时写的），
// 而「我在这台设备上练到哪」正是这件事的本意。
//
// 存的是 `Sentence.index` 而不是队列下标：队列会因为「只练标记为困难的句子」
// 整个换掉，下标换一套含义，句号不会。

const PREFIX = 'deutsch.shadowingAt.';

/** 这台设备上这一课练到的句号；没练过是 null。 */
export function loadLocalShadowingAt(lessonId: string): number | null {
  try {
    const raw = localStorage.getItem(PREFIX + lessonId);
    if (raw === null || raw.trim() === '') return null; // Number('') 是 0，会把「空值」读成第 0 句
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveLocalShadowingAt(lessonId: string, sentenceIndex: number): void {
  try {
    localStorage.setItem(PREFIX + lessonId, String(sentenceIndex));
  } catch {
    // 存不下（隐私模式 / 配额满）：这一次会话里位置仍然活在机器的内存里，不影响当场继续
  }
}

export function clearLocalShadowingAt(lessonId: string): void {
  try {
    localStorage.removeItem(PREFIX + lessonId);
  } catch {
    // 同上
  }
}

/**
 * 从两层里挑出该从哪一句接着练。
 * `fromLesson` 是同步回来的那一份（`Lesson.shadowingAt`）。
 */
export function resumeShadowingAt(lessonId: string, fromLesson: number | undefined): number | null {
  const local = loadLocalShadowingAt(lessonId);
  if (local !== null) return local;
  return typeof fromLesson === 'number' && Number.isInteger(fromLesson) && fromLesson >= 0 ? fromLesson : null;
}
