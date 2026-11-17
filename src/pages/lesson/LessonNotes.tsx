// FR-20 笔记：这一课的要点，自己写的一块纯文本。
//
// 两处（§12.26，变更 93）：主入口在「⋯ → 笔记」，而通听页底部**只有这一课真写过笔记时**
// 才留一行可展开的「笔记 · N 行」。原来它无条件常驻在通听页底部，于是绝大多数课上
// 它是一个空框，占着练习页最该留给句子的那一块。写过的课照旧是「读和写在同一处」。
//
// 只做课程级：句级那一层已经被挖空和生词本占满了，再加一层，过几周就想不起来
// 某条东西当初记在哪一层。
//
// 自动保存（停手 800ms），另外在失焦和卸载时各存一次 —— 切 tab 就是卸载，
// 而「切走一下回来发现刚写的没了」比任何多余的保存按钮都糟。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLessonStore } from '@/state/useLessonStore';
import { Disclosure, field } from '@/components/ui';
import type { Lesson } from '@/types/models';

const SAVE_DEBOUNCE_MS = 800;

export function LessonNotes({
  lesson,
  standalone = false,
}: {
  lesson: Lesson;
  /** 「⋯ → 笔记」那一页：人是专门来写的，直接给文本框，不用再点一下展开。 */
  standalone?: boolean;
}) {
  const patchLesson = useLessonStore((s) => s.patchLesson);
  const [text, setText] = useState(lesson.notes ?? '');

  // 最新值与「已经存进去的值」都放 ref：卸载时那次保存跑在闭包外面，
  // 拿 state 会拿到挂载时的那一份。
  const latest = useRef(text);
  latest.current = text;
  const saved = useRef(lesson.notes ?? '');

  const flush = useCallback(() => {
    const next = latest.current;
    if (next === saved.current) return;
    saved.current = next;
    void patchLesson(lesson.id, (current) => ({
      ...current,
      // 空笔记不留字段：一个空串会让「这一课有没有笔记」这个判断到处都要多写一次 trim。
      notes: next.trim() ? next : undefined,
    }));
  }, [lesson.id, patchLesson]);

  useEffect(() => {
    if (text === saved.current) return;
    const timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, flush]);

  useEffect(() => flush, [flush]);

  const lines = text.trim() ? text.trim().split(/\n+/).length : 0;

  const box = (
    <textarea
      rows={standalone ? 12 : 6}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={flush}
      placeholder="这篇的要点、听不出来的地方、想记住的表达…"
      className={`${field} w-full p-3 leading-relaxed`}
    />
  );

  if (standalone) return box;

  // 通听页底部那一行：默认收起 —— 练的时候它只是「这里有东西」，不是要读的内容。
  return <Disclosure summary={`笔记 · ${lines} 行`}>{box}</Disclosure>;
}
