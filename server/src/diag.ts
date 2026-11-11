// 设备诊断的收件箱（变更 56）。
//
// ── 为什么这条服务上要有这么一个东西 ──
// 开发机是 Windows，iPhone 上那个热更插件出问题时**没有任何一条能看见原生侧的路**：
// 没有 Mac、没有 Xcode 控制台、Safari 远程调试也用不了。前端那边把能问的都问了
// （`src/platform/bridgeDiag.ts`：逐方法自检 + 抄一份 console），但问出来的东西
// 有几百行，念不出来也截不完图。所以给它一个收件箱：手机上点一下，报告落成一个
// JSON 文件，我在这台 VPS 上直接 `cat`。
//
// ── 存文件而不是进 sqlite ──
// 这些东西是**一次性**的：查完一个问题就没用了，而且形状会随着下一次诊断需要什么
// 而变（`schema` 字段就是为此留的）。塞进有 schema 的库里要迁移、要清理，
// 而一个目录 + `ls -lt` 就够了，删也只是 `rm`。备份那一半（sync.sqlite）是长期资产，
// 这一半不是，两者不该共用存储。
//
// ── 每个用户一个子目录、有条数上限 ──
// 上限是防「点上瘾了」把盘塞满：这台机器上还跑着别人的东西（见 KICKOFF），
// 而一份报告可以有几百 KB。超了就删最旧的，不通知任何人 —— 诊断的价值全在最近几份。

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 每个用户最多留多少份。超了删最旧的。
 *
 * 变更 88 从 30 提到 60：诊断按钮改成自动上报之后，一个排查的晚上就能攒十几份，
 * 而 30 份意味着两三天前那份「还正常的时候是什么样」会被挤掉 —— 而对照组恰恰是
 * 这些报告最值钱的那一半。每份几百 KB，60 份也就十几 MB。
 */
const KEEP_PER_USER = 60;

export interface DiagEntry {
  id: string;
  at: number;
  bytes: number;
  /** 哪个按钮点出来的（变更 88）。旧报告没有这一项。 */
  trigger?: string;
}

export interface DiagSink {
  save(userId: string, report: unknown, trigger?: string): DiagEntry;
  list(userId: string): DiagEntry[];
  get(userId: string, id: string): string | null;
}

/**
 * 文件名只允许这些字符 —— id 直接进路径，别让它能往上跳一层。
 * 末尾那一段是触发源（变更 88），可有可无：它在那儿是为了 `ls -lt` **不用打开文件**
 * 就知道哪份是试听、哪份是查更新。没有它的话，一目录同样的时间戳跟没有一样。
 */
const ID_RE = /^[0-9]{13}-[a-z0-9]{6}(-[a-z][a-z-]{0,15})?$/;

/** 触发源来自客户端的 JSON，而它要进文件名 —— 不合格的就当没有。 */
function safeTrigger(trigger: string | undefined): string {
  if (!trigger) return '';
  return /^[a-z][a-z-]{0,15}$/.test(trigger) ? `-${trigger}` : '';
}

/** 用户 id 是 Google 的 sub（一串数字），但还是按最坏情况过一遍。 */
function safeUserDir(userId: string): string {
  return userId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'unknown';
}

export function createFileDiagSink(rootDir: string): DiagSink {
  const userDir = (userId: string): string => {
    const dir = join(rootDir, safeUserDir(userId));
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const entriesIn = (dir: string): DiagEntry[] => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return []; // 还没人发过 —— 目录不存在不是错误。
    }
    return names
      .filter((n) => n.endsWith('.json') && ID_RE.test(n.slice(0, -5)))
      .map((n) => {
        const id = n.slice(0, -5);
        const trigger = id.slice(21) || undefined;
        return { id, at: Number(id.slice(0, 13)), bytes: statSync(join(dir, n)).size, trigger };
      })
      // 同一毫秒进来的两份按 id 排，别让顺序取决于 readdir —— 删旧的那一步也靠这个顺序。
      .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  };

  return {
    save(userId, report, trigger) {
      const dir = userDir(userId);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}${safeTrigger(trigger)}`;
      const text = JSON.stringify(report, null, 2);
      writeFileSync(join(dir, `${id}.json`), text, 'utf8');
      // 先写再删：新的那一份永远不会因为清理失败而丢。
      for (const old of entriesIn(dir).slice(KEEP_PER_USER)) {
        try {
          unlinkSync(join(dir, `${old.id}.json`));
        } catch {
          // 删不掉就留着，下一次再试。诊断不该因为清理失败而失败。
        }
      }
      return { id, at: Number(id.slice(0, 13)), bytes: Buffer.byteLength(text), trigger: id.slice(21) || undefined };
    },

    list(userId) {
      return entriesIn(join(rootDir, safeUserDir(userId)));
    },

    get(userId, id) {
      if (!ID_RE.test(id)) return null;
      try {
        return readFileSync(join(rootDir, safeUserDir(userId), `${id}.json`), 'utf8');
      } catch {
        return null;
      }
    },
  };
}
