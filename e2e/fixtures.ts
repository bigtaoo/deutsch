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
    // 设置留在默认值附近，但把「导入后自动对齐」关掉 —— E2E 里没有权重服务器，
    // 让它排队只会在底部挂一条永远失败的进度。
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
      updatedAt: now,
    },
    studyLog: { days: {}, updatedAt: 0 },
  };
}
