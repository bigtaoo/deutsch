# deutsch-sync

德语精听训练器的后端：**同步**（本职）+ **对齐**（2026-09-03 搭上来的第二个用途）。
**部署步骤在 [`../deploy/README.md`](../deploy/README.md)**，这里只说它是什么。

一个进程 + 一个 SQLite 文件。没有 ORM、没有迁移框架、没有构建步骤：
Node 26 直接跑 `.ts`（内建类型擦除），存储用 Node 自带的 `node:sqlite`。
依赖只有三个：`hono`（路由 + CORS）、`@hono/node-server`、`jose`（验 Google 的签名、签自己的令牌），
加一个 **optional** 的 `onnxruntime-node`（只有对齐要它）。

**两个用途的关系是单向的**：对齐可以整块不存在（`ALIGN_ENABLED=false`，或者
`onnxruntime-node` 在这个平台上装不上），那时对齐的路由回 503 而同步一切照常。
反过来不成立 —— 对齐要用同一套 Google 登录和白名单。

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
| POST | `/v1/align/jobs` | **上传音频**（请求体就是 mp3 原始字节），排一个对齐任务 → 202 `{id, status}` |
| GET | `/v1/align/jobs/:id` | 任务状态 + 进度（`stage` / `chunk` / `chunks`） |
| GET | `/v1/align/jobs/:id/result` | 取矩阵（二进制，见下）。还没算完 → **409 + 当前状态**；取走即删 |
| DELETE | `/v1/align/jobs/:id` | 取消（正在跑的那个在下一个块边界停） |

409 把远端现值带回去，是为了让客户端**一次往返**就能跑完「合并 → 重推」——
合并规则（SPEC §2.4）仍然在客户端，服务器不理解业务语义，只管版本号。

## 对齐（FR-15.17）

**上行 mp3、下行帧级 log-prob 矩阵，文稿一个字都不上来。** CTC 前向只吃波形，
所以文本没有理由离开设备 —— SPEC §3.1 关于德语正文的那一整套约束因此不受影响，
要认的只有「音频经手」一条（§3.1.1 里补了那一段）。

管线：ffmpeg 解成 16kHz 单声道 float32 → 20 秒一块（重叠 2 秒、只采用中间段）→
`onnxruntime-node` 跑 `model_q4.onnx` → log-softmax → 拼成一份 `frames × 31` 的矩阵。
**`src/align/frames.ts` 是浏览器与 Swift 那两份实现的第三份逐条移植** ——
三份必须逐字等价，否则同一课在不同机器上会得到不同的时间戳。那个文件顶部列了四个锚点。

为什么是「任务 + 轮询」而不是一次长请求：一课一两分钟，而手机握不住这么久的连接
（锁屏、切走、换基站）。拆开之后上传是几秒的事，计算留在服务器上 ——
**这期间手机可以锁屏、可以退出 App**，而这正是手机本地那条路做不到的事。

矩阵在线缆上的格式（`src/align/wire.ts`，客户端那一半在 `src/align/remoteEmissions.ts`）：

```
[0,4)      u32 LE：头部 JSON 的字节数（补齐到 4 的整数倍，让负载能零拷贝取视图）
[4,4+n)    UTF-8 JSON：{ frames, vocabSize, duration }
[4+n,...)  frames × vocabSize 个 float32 LE，帧优先
```

**不做任何有损压缩**（不 float16、不 gzip）：一课 3MB，而压了之后同一课在服务器上算
和在桌面上算会得到细微不同的边界 —— 那是这条路最不该引入的差别。

权重（241MB 的 `model_q4.onnx`）**不进镜像**，落在挂进来的 `/data/models/`：
镜像重建不碰它，第一次要用时自己去 HF 取（也可以 `scp` 一份省掉那几分钟）。

排障工具：`node src/align/probe.ts <音频文件>` 在真机器上打出解码耗时、权重加载耗时、
**每块耗时**和一份可对比的指纹。用法见 `../deploy/README.md` §4b。

## 鉴权

Google ID token（一小时）→ 验签 + `aud` + `email_verified` + 白名单 → 换一张自己签的
会话令牌（HS256，90 天）。令牌里只放 `sub`，邮箱每次从库里读 —— 这样把某个邮箱移出
`ALLOWED_EMAILS` 之后，他手上那张没过期的令牌下一次请求就失效。

## 开发

```bash
npm install
npm test          # 52 个测试，内存库 + 假的 Google 校验器 + 假的对齐 engine，不碰网络、不碰模型
npm run typecheck
npm run dev       # 需要 .env（照 .env.example 填）
```
