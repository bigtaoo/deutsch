// E2E 用的素材。两样都**自己造**，不放二进制文件进仓库：
//   · WAV —— 44 字节头 + 一段正弦波。Chromium 原生解得了，真的能读出时长来。
//   · 备份 JSON —— 种数据的正路。E2E 里不直接写 IndexedDB：那等于绕过被测代码，
//     而「导入备份」本身就是 FR-11.14 要验的一条路，顺手把数据也种好了。

import type { BackupFile } from '../src/backup/types';
import type { Lesson, Sentence, VocabEntry } from '../src/types/models';

/**
 * 一段能被浏览器解码的单声道 WAV。
 *
 * 用正弦波而不是全零：全零也能解，但一段真有内容的波形在「时长读出来了吗」
 * 这件事上更接近真实文件，而且将来若有人拿它去试解码也不会得到一个静音的假象。
 */
export function wavBytes(seconds = 2, sampleRate = 8000): Buffer {
  const samples = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 440) * 12000), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk 长度
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // 字节率
  header.writeUInt16LE(2, 32); // 块对齐
  header.writeUInt16LE(16, 34); // 位深
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

/** 一段德语文稿，切出来正好 4 句。 */
export const MANUSCRIPT = [
  'Der deutsche Wald ist mehr als nur eine Ansammlung von Bäumen.',
  'Für viele Menschen ist er ein Ort der Ruhe und der Erholung.',
  'Im Herbst färben sich die Blätter rot, gelb und braun.',
  'Wer dort spazieren geht, hört oft nur den Wind und die Vögel.',
].join(' ');

export const MANUSCRIPT_SENTENCE_COUNT = 4;

function fsrsCard(dueAt: number) {
  return {
    due: dueAt,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0 as const,
  };
}

/**
 * 一课**已经对齐过、已经挖过空**的课程，外加两个到期的生词。
 *
 * 时间戳是手写的：E2E 里不跑真的对齐（一课要几十秒到几分钟，而且要下 230MB 权重）。
 * 有时间戳这件事本身是前提，不是这套要验的东西 —— 对齐算法有它自己的 9 个单测文件。
 */
export function sampleBackup(now = Date.now()): BackupFile {
  const texts = [
    'Der deutsche Wald ist mehr als nur eine Ansammlung von Bäumen.',
    'Für viele Menschen ist er ein Ort der Ruhe und der Erholung.',
    'Im Herbst färben sich die Blätter rot, gelb und braun.',
  ];

  let charStart = 0;
  const sentences: Sentence[] = texts.map((text, index) => {
    const sentence: Sentence = {
      index,
      text,
      charStart,
      charEnd: charStart + text.length,
      startTime: index * 4,
      endTime: index * 4 + 3.5,
      endTimeExplicit: false,
      blanks: [],
      markedDifficult: false,
      excluded: false,
    };
    charStart += text.length + 1;
    return sentence;
  });

  // 第 0 句里的 Ansammlung 挖一个空，对应下面第一个生词。
  const surface = 'Ansammlung';
  const at = texts[0].indexOf(surface);
  sentences[0].blanks = [
    { id: 'blank-1', vocabEntryId: 'vocab-ansammlung', surface, ranges: [{ start: at, end: at + surface.length }] },
  ];

  const lesson: Lesson = {
    id: 'e2e-lesson-1',
    title: 'Alltagsdeutsch: Der deutsche Wald',
    source: { type: 'manual', audioFileName: 'wald.wav' },
    audioDuration: 12,
    sentences,
    createdAt: now - 86_400_000,
    updatedAt: now - 86_400_000,
  };

  const vocab: VocabEntry[] = [
    {
      id: 'vocab-ansammlung',
      surface: 'Ansammlung',
      meaning: '聚集，集合',
      contextSentence: texts[0],
      lessonId: lesson.id,
      sentenceIndex: 0,
      hasTimestamp: true,
      suspended: false,
      fsrs: fsrsCard(now - 3_600_000),
      createdAt: now - 86_400_000,
      updatedAt: now - 86_400_000,
    },
    {
      id: 'vocab-erholung',
      surface: 'Erholung',
      meaning: '休养，恢复',
      contextSentence: texts[1],
      lessonId: lesson.id,
      sentenceIndex: 1,
      hasTimestamp: true,
      suspended: false,
      fsrs: fsrsCard(now - 3_600_000),
      createdAt: now - 86_400_000,
      updatedAt: now - 86_400_000,
    },
  ];

  return {
    _warning: 'Contains copyrighted text. Local backup only. Do not share.',
    formatVersion: 1,
    exportedAt: now,
    lessons: [lesson],
    vocab,
    settings: testSettings(now),
    studyLog: { days: {}, updatedAt: 0 },
  };
}

/**
 * 备份里那份设置。留在默认值附近，但有两项是**为 E2E 刻意关掉的**：
 * `autoAlignOnImport` —— 这里没有权重服务器，让它排队只会在底部挂一条永远失败的进度；
 * `soundEffects` —— 开着会去 fetch + decodeAudioData 三个文件，而它对任何一条用例的
 * 判据都没有贡献（FR-10.12 由单测守）。
 */
function testSettings(now: number) {
  return {
    newPerDay: 10,
    reviewPerDay: 60,
    shadowingGapRatio: 1.2,
    shadowingRepeat: 2,
    playbackRate: 1,
    dictationStrictCase: true,
    autoAlignOnImport: false,
    presetBand: 4,
    enrolledBands: [],
    onlineDictFallback: false,
    showTranslation: false,
    soundEffects: false,
    updatedAt: now,
  };
}

/**
 * FR-21：一份**只含读卡**的备份，用来验识词卡那条路。
 *
 * 不塞进 sampleBackup：那份 fixture 的「到期 2 张」被好几条用例断言着，
 * 往里加卡会让它们全红，而它们验的是别的东西。
 *
 * 形状是刻意摆出来的：两张读卡到期（一张 read-gloss、一张 cloze），
 * 它们的**听卡都没到期** —— 否则同日互斥（FR-21.3）会让听卡优先，读卡一张也出不来。
 * 另外四个词条只当干扰项来源（组题至少要三个），所以也都没到期。
 */
export function readCardBackup(): BackupFile {
  const now = Date.now();
  const past = now - 3_600_000;
  const future = now + 7 * 86_400_000;

  const reviewed = (dueAt: number, reps: number) => ({
    ...fsrsCard(dueAt),
    state: 2 as const,
    reps,
    stability: 5,
    difficulty: 5,
    last_review: now - 5 * 86_400_000,
  });

  const filler = (id: string, surface: string, meaning: string): VocabEntry => ({
    id,
    surface,
    meaning,
    lookup: true,
    hasTimestamp: false,
    suspended: false,
    fsrs: reviewed(future, 4),
    // 读卡**已经开过**且没到期。少了这一行，进复习页时 FR-21.2 会给这四个词
    // 各开一张读卡（它们的听卡都在 Review、也都有释义），队列就从 2 张变成 6 张 ——
    // 那是对的行为，只是会把这份 fixture 想验的东西淹掉。
    fsrsRead: reviewed(future, 3),
    createdAt: now - 86_400_000,
    updatedAt: now - 86_400_000,
  });

  const vocab: VocabEntry[] = [
    {
      ...filler('lese-gloss', 'Zuversicht', 'fester Glaube an einen guten Ausgang'),
      // 读卡还没进 Review → read-gloss（看词形选释义）
      fsrsRead: fsrsCard(past),
    },
    {
      ...filler('lese-cloze', 'Vorhang', 'Stoffbahn vor einem Fenster'),
      // 读卡在 Review 且 reps 是偶数 → cloze（看挖空句选词）
      fsrsRead: reviewed(past, 2),
      examples: ['Der Vorhang fiel nach dem letzten Akt.'],
    },
    filler('fill-1', 'Erholung', 'das Wiedererlangen von Kraft'),
    filler('fill-2', 'Ansammlung', 'eine Menge an einem Ort'),
    filler('fill-3', 'Gelassenheit', 'innere Ruhe in schwierigen Lagen'),
    filler('fill-4', 'Umgebung', 'was einen Ort herum liegt'),
  ];

  return {
    _warning: 'Contains copyrighted text. Local backup only. Do not share.',
    formatVersion: 1,
    exportedAt: now,
    lessons: [],
    vocab,
    settings: {
      newPerDay: 10,
      reviewPerDay: 60,
      shadowingGapRatio: 1.2,
      shadowingRepeat: 2,
      playbackRate: 1,
      dictationStrictCase: true,
      autoAlignOnImport: false,
      presetBand: 4,
      enrolledBands: [],
      onlineDictFallback: false,
      showTranslation: false,
      // 音效关掉：E2E 跑的是真浏览器，开着会去 fetch + decodeAudioData 三个文件，
      // 而它对任何一条用例的判据都没有贡献（FR-10.12 由单测守）。
      soundEffects: false,
      updatedAt: now,
    },
    studyLog: { days: {}, updatedAt: 0 },
  };
}

/**
 * FR-5.3：一份**带词级时间戳**的备份，覆盖到指定的那一课上。
 *
 * 为什么是「覆盖已有的一课」而不是像 `sampleBackup` 那样自带一课：
 * 逐词高亮要同时具备**音频**和**词级时间戳**，而备份里从来没有音频（缓存层不进备份）。
 * 所以先用 `importLesson` 带着 WAV 导入一课（拿到它的 id），再用这份备份把时间戳
 * 盖上去 —— 合并规则是「`updatedAt` 较新者整体胜出」，音频在缓存层不受影响。
 *
 * 另一条路（导 `sampleBackup` 再在课程页选本地音频）走不通得很安静：
 * 绑音频会顺手 `enqueueAlign()`，而 E2E 里没有对齐服务器。
 *
 * 时间戳是手写的：每句按空格分词、在句子的时间范围里均分，够回答
 * 「这一刻哪个词该亮」。真实的那份由对齐器产出，有它自己的 9 个单测文件。
 */
export function timedLessonBackup(lessonId: string, now = Date.now() + 60_000): BackupFile {
  const texts = [
    'Der deutsche Wald ist mehr als nur eine Ansammlung von Bäumen.',
    'Für viele Menschen ist er ein Ort der Ruhe und der Erholung.',
    'Im Herbst färben sich die Blätter rot, gelb und braun.',
  ];

  let charStart = 0;
  const sentences: Sentence[] = texts.map((text, index) => {
    // 一句 10 秒（比真实素材慢得多）是**刻意的**：断言要在「当前词还亮着」的窗口里跑完，
    // 而 CI 上点一下按钮慢半秒很正常。句子短了，用例就会随机掉进句间空档里变红。
    const startTime = index * 10;
    const endTime = startTime + 9.5;

    // 按空格切，逐词均分这一句的时间范围。charStart/charEnd 是**句内** offset。
    const words: { charStart: number; charEnd: number; start: number; end: number }[] = [];
    let at = 0;
    const parts = text.split(' ');
    const step = (endTime - startTime) / parts.length;
    for (const [i, part] of parts.entries()) {
      const bare = part.replace(/[.,]$/, '');
      words.push({
        charStart: at,
        charEnd: at + bare.length,
        start: startTime + i * step,
        end: startTime + (i + 1) * step,
      });
      at += part.length + 1;
    }

    const sentence: Sentence = {
      index,
      text,
      charStart,
      charEnd: charStart + text.length,
      startTime,
      endTime,
      endTimeExplicit: true,
      timingSource: 'auto',
      blanks: [],
      markedDifficult: false,
      excluded: false,
      words,
    };
    charStart += text.length + 1;
    return sentence;
  });

  return {
    _warning: 'Contains copyrighted text. Local backup only. Do not share.',
    formatVersion: 1,
    exportedAt: now,
    lessons: [
      {
        id: lessonId,
        title: 'Alltagsdeutsch: Der deutsche Wald',
        source: { type: 'manual', audioFileName: 'wald.wav' },
        audioDuration: 30,
        sentences,
        createdAt: now - 86_400_000,
        updatedAt: now,
      },
    ],
    vocab: [],
    settings: testSettings(now),
  };
}
