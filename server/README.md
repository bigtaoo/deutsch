# deutsch-sync

德语精听训练器的同步后端。**部署步骤在 [`../deploy/README.md`](../deploy/README.md)**，这里只说它是什么。

一个进程 + 一个 SQLite 文件。没有 ORM、没有迁移框架、没有构建步骤：
Node 26 直接跑 `.ts`（内建类型擦除），存储用 Node 自带的 `node:sqlite`。
依赖只有三个：`hono`（路由 + CORS）、`@hono/node-server`、`jose`（验 Google 的签名、签自己的令牌）。

## 它存什么

「文档」是同步的最小单位，和前端 IndexedDB 的分片一一对应：

| 文档 id | 内容 | 谁在写 |
| --- | --- | --- |
| `vocab` | 全部生词（含 FSRS 状态） | 每次复习会话结束 |
| `lesson:<id>` | 单课的标注层 | 该课变更后去抖 30s |
| `settings` | 设置，整体一份 | 改过设置后去抖 5s |

**缓存层一个字节都不上传**：音频、原文 HTML 留在设备上，课程在新设备显示「素材未下载」，
按 lesson id 重新抓即可。

（`settings` 是 2026-09-02 加的，SPEC §0 变更 28。原本刻意不同步它，理由是「对齐档位这些
跟机器走」—— 那条理由后来被推翻：真正跟机器走的东西记在黑匣子 localStorage 里，
压根不在 `Settings` 结构里。**服务端为此一行都没改** —— 对它来说这只是又一个文档 id，
`docs` 表本来就不理解业务语义。）

每次写入都把旧值留进 `revisions` 表，每个文档保留最近 30 版 —— 这是 GitHub 方案里
「git 历史可回滚」的替代物。没有它，「写坏数据后同步」会像覆盖式备份一样把好数据冲掉。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/healthz` | 免鉴权。`{ok, users, docs}` |
| POST | `/v1/auth/google` | `{idToken}` → `{token, expiresAt, account}`。验 Google 签名 + 查白名单 |
| GET | `/v1/me` | 当前账号 |
| GET | `/v1/docs` | 文档列表（id / 版本 / 时间 / 字节数） |
| GET | `/v1/docs/:id` | 读一个文档 |
| PUT | `/v1/docs/:id` | `{baseVersion, body}`。版本对不上 → **409，并把远端现值一起返回** |
| DELETE | `/v1/docs/:id` | 删除（历史仍保留） |
| GET | `/v1/docs/:id/revisions` | 历史版本列表 |
| GET | `/v1/docs/:id/revisions/:version` | 读某个历史版本 |

409 把远端现值带回去，是为了让客户端**一次往返**就能跑完「合并 → 重推」——
合并规则（SPEC §2.4）仍然在客户端，服务器不理解业务语义，只管版本号。

## 鉴权

Google ID token（一小时）→ 验签 + `aud` + `email_verified` + 白名单 → 换一张自己签的
会话令牌（HS256，90 天）。令牌里只放 `sub`，邮箱每次从库里读 —— 这样把某个邮箱移出
`ALLOWED_EMAILS` 之后，他手上那张没过期的令牌下一次请求就失效。

## 开发

```bash
npm install
npm test          # 27 个测试，内存库 + 假的 Google 校验器，不碰网络
npm run typecheck
npm run dev       # 需要 .env（照 .env.example 填）
```
