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

/** 每个用户最多留多少份。超了删最旧的。 */
const KEEP_PER_USER = 30;

export interface DiagEntry {
  id: string;
  at: number;
  bytes: number;
}

export interface DiagSink {
  save(userId: string, report: unknown): DiagEntry;
  list(userId: string): DiagEntry[];
  get(userId: string, id: string): string | null;
}

/** 文件名只允许这些字符 —— id 直接进路径，别让它能往上跳一层。 */
const ID_RE = /^[0-9]{13}-[a-z0-9]{6}$/;

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
        return { id, at: Number(id.slice(0, 13)), bytes: statSync(join(dir, n)).size };
      })
      .sort((a, b) => b.at - a.at);
  };

  return {
    save(userId, report) {
      const dir = userDir(userId);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
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
      return { id, at: Number(id.slice(0, 13)), bytes: Buffer.byteLength(text) };
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
