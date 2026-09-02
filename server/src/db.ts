// 存储层：一个 SQLite 文件，用 Node 自带的 node:sqlite —— 不引 better-sqlite3，
// 就不需要在镜像里装编译工具链，`docker build` 是纯拷贝，几秒钟。
//
// 「文档」是同步的最小单位，和前端 IndexedDB 的分片一一对应：
//   vocab            —— 全部生词（一次全量，FSRS 状态不可重建，最要命的就是它）
//   settings         —— 设置
//   lesson:<id>      —— 单课的标注层
// 版本号是每文档一个单调递增的整数，扮演 GitHub 方案里 `sha` 的角色：
// PUT 带上你读到的 baseVersion，对不上就是 409，由客户端合并后重推（§2.4 那套规则没变）。
//
// revisions 表是「git 历史可回滚」的替代物：每次写入留一份旧值，每个文档保留最近 N 版。
// 没有它，「写坏数据后同步」就会像覆盖式备份一样把好数据一次性冲掉。

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export interface DocMeta {
  id: string;
  version: number;
  updatedAt: number;
  bytes: number;
}

export interface DocRow extends DocMeta {
  body: string;
}

export type PutResult =
  | { ok: true; version: number; updatedAt: number }
  | { ok: false; conflict: DocRow };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT,
  picture      TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
  user_id    TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  body       TEXT NOT NULL,
  PRIMARY KEY (user_id, doc_id)
);
CREATE TABLE IF NOT EXISTS revisions (
  rowid_alias INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  doc_id      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  body        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS revisions_doc ON revisions (user_id, doc_id, version DESC);
`;

export class Store {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    // WAL：写不阻塞读，且进程被 kill 时已提交的事务不会丢。
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** 登录成功后调用。同一个 Google sub 再次登录只刷新资料和 last_seen。 */
  upsertUser(user: UserRow): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO users (id, email, name, picture, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email,
           name = excluded.name,
           picture = excluded.picture,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(user.id, user.email, user.name, user.picture, now, now);
  }

  getUser(id: string): UserRow | null {
    const row = this.db
      .prepare('SELECT id, email, name, picture FROM users WHERE id = ?')
      .get(id) as UserRow | undefined;
    return row ?? null;
  }

  listDocs(userId: string): DocMeta[] {
    const rows = this.db
      .prepare(
        `SELECT doc_id AS id, version, updated_at AS updatedAt, LENGTH(body) AS bytes
           FROM docs WHERE user_id = ? ORDER BY doc_id`,
      )
      .all(userId) as unknown as DocMeta[];
    return rows.map((r) => ({ ...r }));
  }

  getDoc(userId: string, docId: string): DocRow | null {
    const row = this.db
      .prepare(
        `SELECT doc_id AS id, version, updated_at AS updatedAt, LENGTH(body) AS bytes, body
           FROM docs WHERE user_id = ? AND doc_id = ?`,
      )
      .get(userId, docId) as unknown as DocRow | undefined;
    return row ? { ...row } : null;
  }

  /**
   * 乐观并发写入。
   * baseVersion === null 表示「我以为这个文档还不存在」；文档已存在即冲突。
   */
  putDoc(userId: string, docId: string, baseVersion: number | null, body: string): PutResult {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getDoc(userId, docId);
      const expected = current?.version ?? null;
      if (expected !== baseVersion) {
        this.db.exec('ROLLBACK');
        // 冲突时把远端现值一并交回去，客户端不必再多跑一趟 GET 才能合并。
        return { ok: false, conflict: current ?? { id: docId, version: 0, updatedAt: 0, bytes: 0, body: 'null' } };
      }

      const version = (current?.version ?? 0) + 1;
      if (current) {
        this.db
          .prepare('INSERT INTO revisions (user_id, doc_id, version, updated_at, body) VALUES (?, ?, ?, ?, ?)')
          .run(userId, docId, current.version, current.updatedAt, current.body);
      }
      this.db
        .prepare(
          `INSERT INTO docs (user_id, doc_id, version, updated_at, body) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, doc_id) DO UPDATE SET
             version = excluded.version, updated_at = excluded.updated_at, body = excluded.body`,
        )
        .run(userId, docId, version, now, body);
      this.db.exec('COMMIT');
      return { ok: true, version, updatedAt: now };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 删除也留一份 revision —— 误删是「写坏数据」的一种，同样要能捞回来。 */
  deleteDoc(userId: string, docId: string): boolean {
    const current = this.getDoc(userId, docId);
    if (!current) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO revisions (user_id, doc_id, version, updated_at, body) VALUES (?, ?, ?, ?, ?)')
        .run(userId, docId, current.version, current.updatedAt, current.body);
      this.db.prepare('DELETE FROM docs WHERE user_id = ? AND doc_id = ?').run(userId, docId);
      this.db.exec('COMMIT');
      return true;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listRevisions(userId: string, docId: string): Omit<DocMeta, 'id'>[] {
    const rows = this.db
      .prepare(
        `SELECT version, updated_at AS updatedAt, LENGTH(body) AS bytes
           FROM revisions WHERE user_id = ? AND doc_id = ? ORDER BY version DESC`,
      )
      .all(userId, docId) as unknown as Omit<DocMeta, 'id'>[];
    return rows.map((r) => ({ ...r }));
  }

  getRevision(userId: string, docId: string, version: number): DocRow | null {
    const row = this.db
      .prepare(
        `SELECT doc_id AS id, version, updated_at AS updatedAt, LENGTH(body) AS bytes, body
           FROM revisions WHERE user_id = ? AND doc_id = ? AND version = ?`,
      )
      .get(userId, docId, version) as unknown as DocRow | undefined;
    return row ? { ...row } : null;
  }

  /** 每个文档只留最近 keep 版历史。写入之后调，越界的最旧版本直接删。 */
  pruneRevisions(userId: string, docId: string, keep: number): void {
    this.db
      .prepare(
        `DELETE FROM revisions
          WHERE user_id = ? AND doc_id = ?
            AND version <= COALESCE(
              (SELECT version FROM revisions WHERE user_id = ? AND doc_id = ?
                ORDER BY version DESC LIMIT 1 OFFSET ?), -1)`,
      )
      .run(userId, docId, userId, docId, keep);
  }

  /** /v1/healthz 用：不碰用户数据，只证明库能读。 */
  stats(): { users: number; docs: number } {
    const users = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    const docs = this.db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number };
    return { users: users.n, docs: docs.n };
  }
}
