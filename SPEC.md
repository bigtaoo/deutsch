# 德语精听训练器 — 需求文档 v1

> 个人自用工具，单用户，不联网，不托管内容。
> 目标节奏：每周 1 篇 DW Alltagsdeutsch，一年约 50 篇。
> 工具的价值在于**降低单篇的摩擦成本**，不在于加速学习。

---

## 0. 相对原始规格的变更

| # | 变更 | 理由 |
|---|---|---|
| 1 | 运行形态定为 **PWA**，明确桌面/手机的**设备角色分工** | 复习必须在碎片时间做，绑死桌面浏览器等于复习不会发生 |
| 2 | 新增 **§3.3 能力依赖链**：时间戳 → 挖空 → 听写 → 音频卡 | 原规格中「听写点句子重播」和「手动稀疏打点」互相矛盾，必须显式约束 |
| 3 | 新增 **导入时的段落排除**（FR-1.4） | DW Manuskript 含标题、栏目说明、文末 Glossar，音频里没有 |
| 4 | 切句从「自动」改为 **自动 + 强制可手工修正**（FR-2.3） | `Intl.Segmenter` 对 `z. B.` 一定会断错，切错一次整篇报废 |
| 5 | `newPerDay` 默认 30 → **10**，`reviewPerDay` 70 → **60** | 每周 1 篇 ≈ 每天 3–4 个新词，30 会导致周一清空、之后六天空转 |
| 6 | 新增 V1 的**生词去重降级策略**（FR-9.3） | V1 没有 lemma，同一个词跨课会生成两张卡 |
| 7 | 新增**存储持久化与备份**为 V1 必做项（FR-11） | IndexedDB 会被浏览器驱逐；一年的积累不能靠运气 |
| 8 | 数据模型新增 `updatedAt` / `audioFileName` / `audioDuration` / `Blank.vocabEntryId` | 分别支撑：跨设备合并、手机端音频重绑定校验、听写错误回写 FSRS |
| 9 | 「可分享包」导出**函数在 V1 就实现并加测试**，UI 留到 V2 | 边界事后拆很痛；纯函数 + 断言测试的成本接近零 |
| 10 | 新增 **FR-13 来源与自动导入**，**纯前端实现，不需要任何后端进程** | 实测 DW 的 RSS、页面、mp3 CDN 三者**全部返回 `Access-Control-Allow-Origin: *`**（见附录 A），浏览器可直连，原先设想的本地 helper 整个不需要 |
| 11 | 新增 **FR-14 Glossar 候选词** | DW 的 `manuscript` 里用 `<span data-type="GLOSSARY">` 内联标注了生词，并给出**词条（含性和复数）+ 德语释义**。这把 V2 才打算做的语境释义在 DW 素材上直接白送（见附录 A.3） |
| 12 | §2.5 单一 origin（原「桌面 localhost + 手机 https 两个 origin」作废） | 没有 helper 就没有同源需求，桌面手机跑同一份部署，功能完全一致 |
| 13 | **§2.3 数据分层：缓存层 vs 标注层**，数据模型据此拆开，FR-3 重写为缓存管理 | 素材下载一次就缓存、永不重复下载；缓存不跨端，每台设备自己补齐。连带解决了 Q2（归档旧课程），并把备份要保护的数据量从 700 MB 压到几百 KB |
| 14 | **§2.6 重写为「备份与同步」，主次对调**：备份是首要需求，同步是副产品。方案为 GitHub 私有仓库自动备份（**不建服务器**），FR-11 相应重写并升为 V1 最高优先级的非学习功能 | 初稿把两者当同一件事（「手动搬一次顺带备份」）。**这对同步成立，对备份不成立** —— 备份的失效模式正是「你忘了」。且威胁模型里「写坏数据后覆盖备份」和「几年后工具跑不起来」两条，要求方案必须有**版本历史**且**格式能脱离工具被读懂** |
| 15 | **不做 OAuth 登录**，改为「粘贴一次 PAT，其余全自动」：应用自动识别账号、**一键创建私有备份仓库**、校验权限、监控 token 过期 | 实测 GitHub 的 OAuth 端点不支持 CORS 且不支持 PKCE，纯前端拿不到 token（附录 B.1）。但 `api.github.com` 完全开放，所以「填 owner/repo」这一步可以彻底消灭，手工操作只剩「建 token + 粘贴」 |

---

## 1. 产品定义

**一句话**：把一份德语文稿 + 一段音频，变成可以逐句跟读、按自己的生词挖空听写、并长期复习听觉识别的训练材料。

**唯一用户**：本人。无账号、无多用户、无权限模型。

**成功标准**：完成第一篇 Alltagsdeutsch 的完整动线后，主观上愿意继续用第二篇。不设任何量化指标。

### 1.1 明确不做（非目标）

- 用户注册、账号、云端账户
- 内容托管、上传、分享（法律硬约束，见 §3.1）
- 自动强制对齐（V2）
- 自动挖空难度判定（V2）
- 词形还原 / 离线词典 / 语境释义（V2）
- 中文 → 德语方向的卡片（见 §7.5）
- 连胜、徽章、学习时长统计等游戏化
- 云同步（V1 用手动导出/导入，见 FR-11）

---

## 2. 运行形态与设备角色

**形态**：Vite 构建的纯前端 PWA，无后端。本地 `localhost` 开发，构建产物可放任意静态托管（仅托管**代码**，不托管任何学习内容）。

### 2.1 设备角色

| 设备 | 角色 | 承担的步骤 |
|---|---|---|
| **桌面** | 制作工位 | 导入、切句修正、时间戳标注、跟读、挖空、听写 |
| **手机** | 复习工位 | SRS 复习；可选地跟读已标注的句子 |

分工的理由：标注和听写需要键盘和大屏；复习需要随手可及。工具在两端是**同一个 PWA**，只是使用的功能子集不同。

### 2.2 安装要求（必须写进 README）

- **iOS**：必须「添加到主屏幕」后使用。Safari 对普通网站的 storage 有 7 天无交互即清除的策略，已安装的 PWA 豁免。**不装到主屏幕 = 数据一定会丢。**
- 首次启动调用 `navigator.storage.persist()` 申请持久化配额，结果记录在设置页。
- 设置页展示 `navigator.storage.estimate()` 的用量/配额。

### 2.3 数据分层：缓存层 vs 标注层

**这是整个存储设计的地基。** 所有数据按「丢了能不能重建」分成两层，性质完全不同：

| | **缓存层** | **标注层** |
|---|---|---|
| 内容 | 音频 Blob、原始 manuscript、Glossar 元数据 | 时间戳、切句边界、挖空、生词、FSRS 状态、困难标记 |
| 体积 | 大（一期 6–10 MB） | 小（一期几 KB） |
| 丢了会怎样 | 重新下载即可，**无损** | **不可重建**，一年的功夫没了 |
| 跨设备 | **不跨端**，每台设备各自持有 | **必须同步** |
| 进导出包 | **永不** | 全部 |
| 可以主动删 | 可以，随时 | 不可以 |

由此得到三条硬规则：

- **R-缓存-1 下载过的不再下载。** 同一课程的音频与文稿，在同一设备上只获取一次，之后永远从 IndexedDB 读。
- **R-缓存-2 缓存不跨端。** 导出包里零字节音频。另一台设备要这份素材，自己按 lesson id 去 DW 取（§2.5 使这成为可能）。
- **R-缓存-3 缓存可弃。** 清空缓存对 DW 来源的课程是无损操作，标注层原封不动。

三条规则合起来的效果：**备份只需要保护那个几百 KB 的标注层**，音频的存储压力和数据安全彻底解耦。

### 2.4 跨设备同步（V1 手动）

不做云同步。只有一个通道：导出 `backup-YYYY-MM-DD.json`（**标注层全部，缓存层零字节**），传到另一台设备导入。

对端拿到后，被引用但本机无缓存的课程显示为「素材未下载」，点一下按 lesson id 重新获取（FR-3.5）。手动导入的课程无从重获取，则提示重新选择本地文件。

**合并规则**（导入时执行，不静默覆盖）：

- `Lesson`：按 `id` 匹配，`updatedAt` 较新者整体胜出。
- `VocabEntry`：按 `id` 匹配，比较 `fsrs.last_review`，较新者整条胜出（复习状态 last-write-wins）。
- **缓存层不参与合并**，各设备自管。
- 导入完成后展示摘要：新增 N 条 / 更新 M 条 / 跳过 K 条，并列出被覆盖的课程标题。

**约定的搬运方向**：标注永远 桌面 → 手机；复习状态回流 手机 → 桌面。避免两端同时复习产生分叉。

### 2.5 部署与 origin

**单一 origin，桌面和手机跑同一份部署，功能完全一致。**

因为 DW 的三类端点都允许跨域（附录 A.1），自动导入在浏览器里就能完成，不需要任何后端或本地进程。因此：

| 设备 | 访问地址 | 可用功能 |
|---|---|---|
| 桌面 | `https://<静态托管>/`（开发时 `http://localhost:5173`） | 全部 |
| 手机 | 同上，安装到主屏幕 | 全部，**含自动导入** |

这带来两个原本没预期的好处：

- **手机可以自己补齐素材**，不必搬运 mp3。这正是 §2.3 的 R-缓存-2「缓存不跨端」能够成立的前提 —— 如果浏览器不能直连 DW，缓存就必须跨端搬，那条规则也就写不出来。
- 部署面缩小到「一堆静态文件」，没有进程要启动、没有端口要记。

§2.4 的合并规则仍然需要 —— 两台设备各自导入、各自复习，标注层照样会分叉。

### 2.6 备份与同步

**首要需求是备份，不是同步。** 同步是备份做对之后的副产品。

一次澄清（推翻本节初稿）：本文档一度把备份和同步当成同一件事，说「每周手动搬一次，备份顺带就做了」。**这对同步成立，对备份不成立** —— 备份的失效模式恰恰是「你忘了」，而人会在认真做了八个月之后，恰好在设备损坏前的三周漏掉。依赖纪律的备份，总在最需要它时失效。

#### 2.6.1 威胁模型

| 威胁 | 说明 |
|---|---|
| 换手机 / 手机丢失损坏 | 主要动机 |
| 浏览器清掉 IndexedDB | 比换手机更可能，且两端都会发生。`persist()` 是请求，不是保证 |
| 误删、应用 bug 写坏数据 | 低概率但致命。**单份覆盖式备份会把坏数据一起覆盖过去** → 必须有版本历史 |
| 几年后工具本身跑不起来 | 时间够长就必然发生 → **备份格式必须能脱离本工具被读懂** |

后两条决定了方案形状：**要历史，不能只要最新副本；要纯文本，不能是不透明快照。**

#### 2.6.2 珍贵程度分级

| 数据 | 可重建性 | 一年体积 | 备份策略 |
|---|---|---|---|
| **`vocab`（生词 + FSRS 状态）** | **完全不可重建**。「该词记忆稳定度 47 天」无法从任何来源推回 | **~450 KB** | 每次复习会话结束即推 |
| `lessons`（时间戳、切句、挖空） | 可重建，但要重做一遍 | ~1.2 MB | 导入或标注变更后推 |
| 缓存层 | 免费重下 | ~700 MB | **永不备份** |

关键观察：**最珍贵的数据恰好是最小的**，三年也不过 1.4 MB。而它主要在**手机**上每天增长 —— 正是最可能被换掉的那台设备。

#### 2.6.3 V1 方案：GitHub 私有仓库自动备份

`api.github.com` **实测返回 `Access-Control-Allow-Origin: *` 并暴露 `ETag`**（2026-08-30 验证），浏览器可直接调，无需服务器。

```
lessons/45334084.json   ← 导入/标注后推        ~25 KB
vocab.json              ← 每次复习结束推       ~450 KB
settings.json
```

它同时满足威胁模型的四条：**异地**（不在任何一台设备上）、**自动**（没有要记住的动作）、**有历史**（每次备份一个 commit，可回滚到任意一天）、**可脱离工具存活**（仓库里就是普通 JSON 加 git 历史）。

- 每个文件的 `sha` 天然是乐观并发令牌：PUT 时带上，对不上 GitHub 返回 409，据此提示合并而非静默覆盖。
- 单文件均在 1 MB 以内，不必压缩；真超了用 `CompressionStream` gzip 后 base64。

代价如实记录：

- **手机上也必须放 PAT**。不放的话手机的 FSRS 状态仍需手动搬运，等于没解决核心问题。权限收到「单仓库 + contents:write」。设备丢失的最坏情况是他人可读写这一个私有仓库。
- **引入新的单点：GitHub 账号本身**。因此手动导出（FR-11.2）**必须保留**，作为第二份、不同故障域的保险。

#### 2.6.4 同步是副产品

备份做对之后，同步几乎不用额外做 —— 两台设备读写同一个仓库即可。而且这不是真正的双向同步，因为两台设备**写的根本不是同一批字段**。

| | 桌面写什么 | 频率 |
|---|---|---|
| 桌面 | 新增 `Lesson`、新增 `VocabEntry` | 每周 |
| 手机 | 更新已有 `VocabEntry` 的 `fsrs` | 每天 |

桌面**新增**，手机**更新存量**。只要遵守 §2.4 的约定（复习只在手机做），这就是一个 **append-only 的交接**，不是真正的双向同步 —— 没有 CRDT、没有向量时钟、没有三路合并的必要。§2.4 那条 `fsrs.last_review` 比较的规则足够了，它唯一要防的就是桌面把手机的复习状态覆盖掉。

#### 2.6.5 恢复演练（不是可选项）

**没演练过的恢复不算备份。** 只写「能导出」而从不验证「能装回去」，等于把一个未经测试的代码路径押上几年的积累。

- 验收阶段必须在第二台设备（或清空本机数据后）**完整恢复一次**，见 §10。
- 恢复要能从零开始：空浏览器 → 填 PAT → 拉取 → 标注层齐全 → 课程显示「素材未下载」→ 补齐 → 复习照常。
- 每年提示一次重新演练。工具在变，恢复路径会悄悄坏掉。

#### 2.6.6 已否决的方案

| 方案 | 否决理由 |
|---|---|
| 自建 VPS / 小型服务 | 为每周 400 KB 维护一台要打补丁的机器；且自己写的服务没有版本历史，防不住「写坏 + 覆盖」 |
| Firebase / Supabase | 功能远超需求，引入账号体系与厂商绑定 |
| PouchDB + CouchDB | 离线同步的经典答案，但要用它重写整个数据层，代价与收益严重不匹配 |
| 云盘文件夹 + File System Access API | 桌面上很优雅，但该 API 在 iOS Safari 上**不存在** —— 恰好是最需要自动备份的那台设备用不了 |
| 仅靠手动导出 | **本节初稿的方案，已推翻**：依赖纪律，而备份的失效模式正是「你忘了」。保留为第二道保险，不作为主方案 |
| WebRTC / 局域网直传 | 仍需信令服务器，要求两端同时在线，且不产生异地副本 —— 对备份毫无用处 |
| **GitHub OAuth 登录** | **纯前端不可行**（实测见附录 B.1）：授权码流程需要 `client_secret`，GitHub 不支持 PKCE，而 Device Flow 的两个端点在 `github.com` 上、预检 404 无 CORS，浏览器发不出请求 |
| OAuth + 自建 token 交换代理（Cloudflare Worker 等） | 技术上可行，且**不违反 §3.1.1 R-1**（只交换 token，不碰内容通路）。否决是工程理由：换来的仅是省掉一次性三分钟操作，代价是永久的部署依赖，且登录会随它宕机而坏 |

#### 2.6.7 法律补充

备份载荷含 `Sentence.text` 与 `contextSentence`，即受版权的正文。放进**私有且需认证**的存储（GitHub 私有仓库、你自己的网盘）属于私人存档，与放进 Dropbox 无异，**不构成 §3.1 所说的「向公众提供」**。

但这条豁免完全依赖「私有」二字：**该仓库任何时候都不得转为公开**。若真要公开分享，走的是 §3.1 的 `ShareablePackage`（不含正文），不是这个备份文件。

---

## 3. 核心约束

### 3.1 法律：BYOC（Bring Your Own Content）

**原则：工具不托管、不传输、不经手任何版权内容。**

- 用户自行从 DW 下载 mp3、自行复制 Manuskript，文件只存在本地设备 → 属于私人复制，合法。
- 教材音频（Aspekte neu 等）同理。
- **不做任何分享功能。** 一旦托管用户上传内容并向公众提供，即落入 **UrhDaG**（欧盟版权指令第 17 条的德国落实法），平台承担**直接责任**，"收到通知才删"的避风港抗辩不成立。教科书出版社（Klett、Cornelsen）是该领域最积极的维权方。
- 若将来要做分享：**只分享标注层** —— 内容标识（`sourceUrl` 或 "Alltagsdeutsch, 2025-11-03"）+ 时间戳数组 + lemma 列表 + 挖空位置。**绝不含正文或例句原文**，带了就是分发原作片段。思路等同字幕轴文件。

**架构落实**（V1 必做）：

```
ShareablePackage = f(Lesson)   // 纯函数，白名单式构造
```

- 白名单构造，不是黑名单剔除。只显式挑选允许的字段。
- 配单元测试：把导出结果 `JSON.stringify` 后，断言**不包含**该课任何一句正文的任意 8 词以上连续片段，且不含 `text` / `contextSentence` / `surface` 字段名。
- 全量备份 `backup-*.json` **含正文**，文件顶层写 `"_warning": "Contains copyrighted text. Local backup only. Do not share."`

#### 3.1.1 自动获取内容的边界（FR-13 / §7.8）

自动从 DW 抓取音频和文稿**不违反上面的原则**，因为 BYOC 管的是「谁在托管、谁在向公众提供」，不是「谁点的下载按钮」。私人复制（§ 53 UrhG）不区分是手点的还是脚本点的。据此把红线精确化：

| 规则 | 说明 |
|---|---|
| **R-1 请求只能从用户设备发出** | 实现上就是浏览器里的一次 `fetch()`：用户自己的浏览器、自己的 IP、直连 DW，中间没有任何第三方。**代码库中不得出现任何我们运营的中转/代理服务，也不得引入公共 CORS 代理** —— 一旦有服务器代抓，就变成我们在复制和传输，性质立刻不同。这是本节唯一的硬红线，而现在它是**免费满足**的：没有后端可写，就没有红线可越。 |
| **R-2 不绕过任何付费墙或技术保护措施** | § 95a UrhG。DW 无 DRM，本来也不需要绕；但这条约束对将来任何新来源都适用。 |
| **R-3 抓取要礼貌** | 串行请求、请求间隔 ≥ 1s、不做批量预抓。每周 1 次本来也构不成负载，但代码里不能写出可以被误用成批量抓取的形状（比如「一键导入全部 100 期」）。浏览器里无法自定义 User-Agent，这条不适用。 |
| **R-4 抓下来的内容性质不变** | 仍然受版权、仍然只存本地、仍然永不进 `ShareablePackage`。自动获取只是省掉手工步骤，不改变内容的法律地位。 |
| **R-5 代码可开源，内容零份** | 抓取器作为工具本身没有问题（性质类似 yt-dlp）。但仓库、构建产物、示例数据中必须**不含任何一句 Manuskript 或一个音频文件**，测试固件也不行（用自造的德语句子）。 |

关于使用条款：抓取可能触碰 DW 的 Nutzungsbedingungen，那属于合同层面而非版权层面。DW 是公共资金支持的广播机构，语言学习材料本就是免费提供给学习者的，这大概是抓取里风险最低的一类。但「风险低」不等于「获得授权」，所以 R-4 的本地留存约束不因此放松。（以上是工程判断，不是法律意见。）

### 3.2 平台约束（会直接影响实现）

| 约束 | 后果 |
|---|---|
| iOS 需要用户手势才能开始播放 | **全程复用同一个 `<audio>` 元素**，不要每句 `new Audio()`。首次点击后的 seek + play 被视为同一手势链，允许。 |
| iOS 静音开关会静音 `<audio>` | README 提示；或用 Web Audio API 的 `AudioContext`（不受静音开关影响）播放。V1 先用 `<audio>`，遇到问题再换。 |
| 手机锁屏/切后台会暂停跟读循环 | 跟读在手机上是次要功能，不做后台播放。`visibilitychange` 时暂停并保留位置。 |
| `playbackRate` 在移动 Safari 支持但过低会失真 | 变速范围限定 **0.7–1.2**（与原规格一致）。 |
| IndexedDB 配额与驱逐 | 见 FR-11。 |

### 3.3 能力依赖链（重要）

一期 Alltagsdeutsch 约 8–10 分钟、80–120 句。打点是**稀疏且按需**的——一期里真正需要反复听的可能就五六句。因此：

```
标注 startTime ──→ 可跟读
               └──→ 可挖空 ──→ 可听写 ──→ 生词入库 ──→ 带音频的 SRS 卡

未标注句子     ──→ 只能阅读、只能标记生词（生成【无音频卡】）
```

**规则**：

- **R1**：挖空操作只允许在**已标注时间戳**的句子上进行。未标注句子点词时，提示「先标注这句的时间点」并提供一键跳转到打点模式。
- **R2**：`VocabEntry` 允许来自未标注句子（阅读时直接标记生词），此时卡片正面无音频，标记为「无音频卡」，在复习界面显式提示，并提供「补标注」入口。
- **R3**：UI 任何位置都不得出现「点了重播却没有声音」的死角。播放按钮在无时间戳时为禁用态 + tooltip 说明原因。

---

## 4. 用户动线

```
① 导入   粘贴 Manuskript + 选择本地 mp3
    ↓
② 切句   自动切分 → 肉眼扫一遍 → 合并/拆分误切 → 排除 Glossar 等非朗读段落
    ↓
③ 通听   完整播放一遍，不看文本（文本区域可折叠）
    ↓
④ 标注   播放中对想练的句子打点（稀疏，只标要练的）
    ↓
⑤ 学词   阅读文本，点击生词 → 标记 → 自动挖空 + 入生词本草稿
    ↓
⑥ 跟读   逐句循环 + 静默间隔 + 变速；跟不上的句子按 D 标记为 markedDifficult
    ↓
⑦ 听写   对已挖空的句子作答，实时校验；答错自动入生词本
    ↓
⑧ 复习   SRS 队列（手机）：听句子音频 + 看挖空句 → 回忆词与释义
```

②③④⑤ 顺序可打乱；⑥⑦ 依赖 ④；⑧ 依赖 ⑤ 或 ⑦。

---

## 5. 功能需求

### FR-1 课程导入

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-1.1 | 新建课程，填写标题（必填）、`sourceUrl`（选填） | 标题为空时不能保存 |
| FR-1.2 | 粘贴 Manuskript 纯文本到 textarea | 支持 20000 字符以上不卡顿 |
| FR-1.3 | 选择本地音频文件（`accept="audio/*"`），读取时长 | 显示文件名与时长；未选音频也允许保存课程（可后补） |
| FR-1.4 | **段落排除**：切句后，每句可标记为「非朗读内容」并从正文中排除 | 提供「批量排除文末 N 句」快捷操作（对付 Glossar）；被排除的句子不参与索引编号、不出现在跟读/听写/复习 |
| FR-1.5 | 导入后可随时重新编辑原文并重新切句 | 重新切句时，**保留已有 startTime/blanks 的句子**（按文本内容匹配），无法匹配的句子列出来让用户确认丢弃 |

### FR-2 句子切分

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-2.1 | 用 `Intl.Segmenter('de', {granularity:'sentence'})` 初切 | — |
| FR-2.2 | 应用后处理合并规则（见 §7.1） | `z. B.` / `u. a.` / `am 3. Oktober` / `im 19. Jahrhundert` / `Dr. Müller` 均不被误断 |
| FR-2.3 | **手工修正**：在句子列表中「与下一句合并」/「在光标处拆分」 | 每句都有这两个操作；操作后重排 index，已有 startTime 跟随 |
| FR-2.4 | 每句保存其在原文中的 `charStart`/`charEnd` | 用于 FR-1.5 的重切匹配 |

### FR-3 素材缓存（实现 §2.3 的三条缓存规则）

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-3.1 | 缓存单元 = `LessonCache`，一课一条，存音频 Blob + 原始 manuscript HTML + Glossar 元数据，key 为 `lessonId` | 关掉浏览器再打开，无需任何网络请求即可播放和学习 |
| FR-3.2 | **下载前先查缓存**（R-缓存-1）。命中则直接用，不发任何请求 | 同一课程重复进入，Network 面板零请求 |
| FR-3.3 | 播放用 `URL.createObjectURL`，组件卸载时 `revokeObjectURL` | 不泄漏 |
| FR-3.4 | **缓存缺失态**：标注层有这一课，本机无缓存 | 明确显示「素材未下载」；播放控件禁用并说明原因（§3.3 R3）；给出补齐入口 |
| FR-3.5 | **补齐（rehydrate）**：DW 来源的课程，凭 `source.dwLessonId` 重新拉取音频与 manuscript | 手机导入备份后，一键补齐即可复习带音频的卡片 |
| FR-3.6 | 手动来源的课程无法自动补齐 → 提示重新选择本地文件，并按 `audioDuration` 校验 | 时长差 > 0.5s 时警告「时长不匹配，时间戳可能失效」，允许用户坚持 |
| FR-3.7 | 补齐后校验文稿一致性：比对纯文本的 hash | 不一致说明 DW 改过稿，**时间戳与挖空 offset 可能全部失效** —— 必须显式警告，让用户选择「按新文稿重切」或「保留旧标注自行核对」，不能静默接受 |
| FR-3.8 | 缓存管理页：按课列出占用空间、单课清除、一键清除全部 | 与 `storage.estimate()` 用量一起显示 |
| FR-3.9 | 清除前区分**可补齐**（DW 来源，无损）与**不可补齐**（手动导入，音频要你自己再找回来） | 两者用不同颜色和不同确认文案；后者需二次确认 |

### FR-4 时间戳标注

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-4.1 | 标注界面：左侧句子列表（可滚动、当前句高亮），底部音频播放条 | — |
| FR-4.2 | 播放中按快捷键或点击句子 → 记录当前 `currentTime` 为该句 `startTime` | 快捷键：`Enter` 标记当前选中句并自动选中下一句 |
| FR-4.3 | 支持**乱序、稀疏**打点：可跳到任意句子直接标记 | 不强制从第一句顺序标注 |
| FR-4.4 | `endTime` 规则：显式标记优先；未显式标记时取**下一个有 startTime 的句子**的 startTime；若无后续标注则取音频总时长 | UI 上区分「推断的 endTime」（虚线）与「显式的 endTime」（实线） |
| FR-4.5 | 微调：对选中句的 startTime/endTime 做 ±0.1s / ±0.5s 步进调整，并即时试听 | — |
| FR-4.6 | 清除单句时间戳 | 清除后该句上的 blanks 保留但听写不可用（提示补标） |

### FR-5 通听

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-5.1 | 全篇连续播放，文本区域默认**折叠** | 一键展开/折叠 |
| FR-5.2 | 播放中，已标注句子随播放进度高亮 | 未标注句子不高亮（不做假装的伪同步） |

### FR-6 跟读模式（最高频界面，优先级最高）

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-6.1 | 循环单元：`播放 [start,end] → 静默 gap → （重复 N 次）→ 手动或自动进入下一句` | gap = 句子时长 × `shadowingGapRatio`（默认 1.2） |
| FR-6.2 | 每句重复次数可配置（默认 2），或设为「无限，手动推进」 | — |
| FR-6.3 | 变速 0.7 / 0.85 / 1.0 / 1.2 四档 | 切换即时生效，不重启当前句 |
| FR-6.4 | 只在**已标注**的句子间循环，跳过未标注句 | 顶部显示「本篇已标注 6 / 112 句」 |
| FR-6.5 | 键盘快捷键 | `Space` 重播当前句 · `→` 下一句 · `←` 上一句 · `D` 切换 `markedDifficult` · `+`/`-` 变速 |
| FR-6.6 | 静默间隔期间有可见倒计时（进度条或环） | 让人知道该开口了 |
| FR-6.7 | 可切换「只练标记为困难的句子」 | — |

### FR-7 生词标记与挖空

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-7.1 | 句子渲染为可点击的 token（按空白与标点切分，保留原始 offset） | 点击任一 token 高亮 |
| FR-7.2 | 支持**多 token 连选**（拖选或 shift+点击）标记搭配 | 能标记 `hing ... ab` 这类不连续片段：一个 Blank 允许含多个 `[charStart, charEnd]` 区间 |
| FR-7.3 | 标记后：在该句创建 `Blank` + 创建 `VocabEntry` 草稿（`meaning` 待填） | 挖空在听写模式下显示为 `____` |
| FR-7.4 | 可手动填写 `meaning` / `gender` / `plural` | 名词未填 `gender` 时在生词本列表标黄提示（德语名词不带性等于没记） |
| FR-7.5 | 取消挖空 → 询问是否同时删除生词条目 | — |
| FR-7.6 | 未标注时间戳的句子上点词 → 按 §3.3 R1 提示 | — |

### FR-8 听写模式

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-8.1 | 队列 = 本篇所有含 Blank 且有时间戳的句子 | — |
| FR-8.2 | 展示挖空后的句子 + 每个空一个输入框；`Space`（非输入焦点时）或按钮重播本句 | — |
| FR-8.3 | 校验分级（见 §7.4）：**正确 / 转写等价 / 仅大小写错 / 错误** | 每级有明确的视觉区分与文案 |
| FR-8.4 | 错误时展示字符级 diff（正确答案与输入的差异高亮） | — |
| FR-8.5 | 「我不会」按钮：直接判错并显示答案 | — |
| FR-8.6 | 结果回写：错误或「我不会」→ 对应 `VocabEntry` 记 FSRS `Again`；仅大小写错 → `Hard`；正确 → `Good` | — |
| FR-8.7 | 德语输入辅助：ä ö ü ß 快捷按钮（手机端必需） | — |

### FR-9 生词本

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-9.1 | 列表视图：surface / 释义 / 出处课程 / 原句 / 下次复习时间 | 支持按课程、按 FSRS 状态筛选 |
| FR-9.2 | 每条可编辑、可删除、可「暂停复习」 | — |
| FR-9.3 | **V1 去重降级策略**：新建时按 `surface.toLowerCase()` 全库匹配，命中则提示「已有该词条（来自《XX》）」，给三个选项：合并到已有条目 / 仍然新建 / 取消 | V1 无 lemma，只能靠 surface 匹配；`gelaufen` 与 `laufen` 匹配不上是**已知且接受**的局限，V2 上 lemma 后补一个批量归并工具 |
| FR-9.4 | 条目粒度鼓励用**搭配/整句**：若选中的是单个常见词，轻提示「考虑连搭配一起标记」 | 不强制。`sich einer Sache bewusst sein` 比 `bewusst` 有用得多 |

### FR-10 SRS 复习

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-10.1 | 用 **FSRS**（`ts-fsrs`），不用 SM-2 | — |
| FR-10.2 | 卡片**正面**：句子音频（自动播放一次，可重播）+ 挖空后的原句文本 | 音频里包含答案是**设计意图**：目标是训练「听到 /ˈtsuːfɐˌzɪçt/ 能反应过来是 Zuversicht 且知道意思」，不是遮蔽听觉线索 |
| FR-10.3 | 卡片**背面**：词 + 词性/性/复数 + 释义 + 完整原句 | — |
| FR-10.4 | 评分四档 `Again / Hard / Good / Easy`，键盘 `1234`，手机端为四个大按钮 | — |
| FR-10.5 | 无音频卡要**区分两种原因**，给不同出口：`hasTimestamp=false` → 「去补标注」；有时间戳但本机无缓存 → 「下载素材」（FR-3.5） | 两者都不能静默降级成纯文本卡。后者是一键可解的，混为一谈会让人以为卡片废了 |
| FR-10.6 | 队列受 `newPerDay` / `reviewPerDay` 限制；今日无卡时显示下次到期时间 | — |
| FR-10.7 | 手机端复习界面单手可用，按钮在拇指可达区 | — |

### FR-11 备份、恢复与存储

> 实现 §2.6。**这是 V1 中优先级最高的非学习功能** —— 它保护的是几年积累里唯一不可重建的部分。

**连接 GitHub**

> 不做 OAuth 登录 —— 纯前端不可行，实测依据见附录 B.1。改为「粘贴一次 token，其余全自动」。

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-11.1 | 引导页说明如何创建 **fine-grained PAT**，权限精确到 `Contents: Read and write` + 仅选定仓库，并提供直达 GitHub 创建页的链接 | 说明要具体到点哪几个下拉框。**不要用 classic PAT 的 `repo` scope** —— 那等于交出你全部仓库的读写权 |
| FR-11.2 | 粘贴 token 后自动 `GET /user`，显示「已连接：@用户名」+ 头像 | token 存 IndexedDB，界面此后只显示后四位 |
| FR-11.3 | **一键创建**备份仓库（`POST /user/repos`，`private: true`, `auto_init: true`），或列出已有私有仓库供选择 | **用户不需要手填 owner/repo，也不需要离开应用去 GitHub 建仓库** |
| FR-11.4 | 连接校验：仓库存在、为 **private**、token 确实可写（试写一个 `.keep` 验证） | 是 public 则拒绝并说明原因（§2.6.7）；只读 token 要在配置时就报错，不能等到第一次备份才发现 |
| FR-11.5 | **监控 token 过期**：从 API 响应头读取过期时间，剩余 30 天起提醒续期 | fine-grained PAT 强制有有效期，到期即静默失败 —— 正是 FR-11.9 要防的那类事故。具体响应头名称在实现时确认 |

**自动备份（主方案）**

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-11.6 | 推送 `vocab.json`：**每次复习会话结束**触发 | 不可重建的数据不过夜 |
| FR-11.7 | 推送 `lessons/<id>.json`：该课导入完成、或标注/挖空变更后触发（去抖 30s） | — |
| FR-11.8 | 用文件 `sha` 做乐观并发；收到 409 → 拉取远端、按 §2.4 合并规则合并、重推 | **绝不静默覆盖**；合并有摘要 |
| FR-11.9 | **备份状态常驻可见**：上次成功时间 + 待推送变更数 + token 剩余有效期 | 静默失败的备份比没有备份更危险 —— 它给你虚假的安全感 |
| FR-11.10 | 推送失败 → 显式报警横幅，且**离线时排队、恢复网络后自动重试** | 手机常在弱网下复习，失败必须是暂态而非丢失 |

**手动导出（第二道保险，不同故障域）**

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-11.11 | 导出备份 JSON = **标注层全部，缓存层零字节**，文件名 `backup-YYYY-MM-DD.json` | 顶层带 `_warning` 版权提示（§3.1）；**按日期命名，永不覆盖同名文件** —— 覆盖式备份防不住「写坏数据后备份」 |
| FR-11.12 | 距上次手动导出超过 90 天 → 首页横幅提醒 | 自动备份已是主力，手动只是防 GitHub 账号失效，故周期放长；不用弹窗打断 |

**恢复**

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-11.13 | 一键从仓库恢复到空设备：粘贴 token → 自动发现备份仓库 → 拉取全部 → 写入本地 | 空浏览器 → 标注层齐全 → 课程显示「素材未下载」→ 补齐（FR-3.5）→ 复习照常 |
| FR-11.14 | 导入本地备份文件，按 §2.4 合并规则执行，展示合并摘要 | 导入前自动先导出一份当前状态（防呆） |
| FR-11.15 | **每年提示一次恢复演练** | 工具在变，恢复路径会悄悄坏掉。见 §2.6.5 |

**其他**

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-11.16 | 启动时 `navigator.storage.persist()`；设置页显示持久化状态与 `estimate()` 用量 | — |
| FR-11.17 | 实现 `toShareablePackage(lesson)` 纯函数 + 单元测试（见 §3.1），V1 不暴露 UI 入口 | 测试必须断言导出结果不含任何正文片段 |

### FR-12 设置

| 项 | 默认值 | 说明 |
|---|---|---|
| `newPerDay` | **10** | 每周 1 篇 ≈ 每天 3–4 个新词，设 30 会导致周一清空、之后空转 |
| `reviewPerDay` | **60** | 防爆闸，正常不会触顶 |
| `shadowingGapRatio` | 1.2 | 静默间隔 = 句子时长 × ratio |
| `shadowingRepeat` | 2 | 每句重复次数，可设为 0（无限，手动推进） |
| `playbackRate` | 1.0 | 0.7 / 0.85 / 1.0 / 1.2 |
| `dictationStrictCase` | true | 关掉后大小写错误不计错 |

### FR-13 来源与自动导入（纯前端，无后端）

**分三层降级，L3 永不删除：**

| 层 | 方式 | 何时用 |
|---|---|---|
| **L1 全自动** | 选来源 → 看期次列表 → 选一期 → 音频和文稿自动到位 | 正常情况 |
| **L2 半自动** | 粘贴单个 DW 页面 URL（或直接粘 lesson id） | RSS 100 期窗口之外的存档期次 |
| **L3 手动** | 粘贴文本 + 选本地文件（即现有 FR-1.2 / FR-1.3） | DW 改版、教材音频、任何非 DW 素材 |

L3 是地板：DW 改版会打掉 L1/L2，Aspekte neu 这类教材根本没有 feed。**任何时候都不能让 L3 依赖 L1/L2 的代码路径。**

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-13.1 | 内置来源常量表：DW Alltagsdeutsch / DW Sprachbar / DW Langsam gesprochene Nachrichten，各带 RSS 地址与 adapter 标识 | 不做「用户自定义来源」UI（个人工具，加来源就是改一行常量） |
| FR-13.2 | 拉取 RSS（`fetch` + `DOMParser`），展示期次列表：标题、`itunes:duration`、`firstPublicationDate` | 列表缓存进 IndexedDB，离线可看，显示「抓取于 X」 |
| FR-13.3 | **排序与去重按 `firstPublicationDate`，不按 `pubDate`** | DW 在把 2019 年的旧期以当周日期重新推送（附录 A.2）。用 `pubDate` 排序会让「最新」全是老内容 |
| FR-13.4 | 选中一期 → 抓页面 HTML → 解析 `window.__APOLLO_STATE__` → 取 `Lesson:<id>` 的 `manuscript` / `teaser` / `knowledges`，取 `Audio:*` 的 `mp3Src` 与 `duration` | 见 §7.8 |
| FR-13.5 | 下载 mp3 存入 IndexedDB，用 `Audio.duration` 预填 `audioDuration` | 有下载进度（`Content-Length` 已知，CDN 支持 `Accept-Ranges`）；可重试；**音频与文本任一失败不影响另一个** |
| FR-13.6 | `manuscript` 转纯文本后喂进现有流程，走 FR-2 切句 + FR-1.4 段落排除 | 自动导入不是独立分支，只替 FR-1.2 / FR-1.3 填数据。切句逻辑一行都不重写 |
| FR-13.7 | **自动排除开头的 teaser 块**：`manuscript` 首个 `<strong>` 块 = 标题 + teaser，音频里不朗读 | 判定方式不用启发式：该块文本包含 `Lesson.teaser` 才排除，否则保留并提示人工确认 |
| FR-13.8 | 已导入期次按 **lesson id**（= RSS `<guid>` = URL 里的 `l-<id>`）标记「已导入」 | 不用 `sourceUrl` 匹配 —— RSS 的 link 带 `?maca=` 跟踪参数，不稳定 |
| FR-13.9 | 抓取失败 → 说明失败在哪一步 + 一键切到 L3，**保留已抓到的部分** | 不能只显示「导入失败」 |
| FR-13.10 | 串行请求、间隔 ≥ 1s、**不提供「批量导入全部期次」** | 见 §3.1.1 R-3 |
| FR-13.11 | 每个来源一个 adapter 模块，各配一份 `__APOLLO_STATE__` 快照回归测试 | DW 改版时**测试先红**，而不是某天用的时候才发现。快照受 R-5 约束，正文替换成自造句子，只保留结构 |

### FR-14 Glossar 候选词（DW 素材专属）

DW 在 `manuscript` 里已经把它认定的生词内联标注好了（附录 A.3）：

```html
<span class="editable placeholder" data-id="43252624"
      data-title="Plattform, -en (f.)" data-type="GLOSSARY">Plattformen</span>
```

一个 span 同时给出四样东西：句中**表层形式**（`Plattformen`）、**词条 + 复数 + 性**（`Plattform, -en (f.)`）、指向释义的 `data-id`，以及精确的**字符位置**。对应的 `Knowledge:<id>.text` 是一句德语释义。

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-14.1 | 导入时解析 GLOSSARY span，生成**候选词**列表，不自动建条目 | 这是 DW 选的词，不是「我不认识的词」—— 原始需求明确抱怨过现有 app 不能按后者挖空。候选是便利，不是代替判断 |
| FR-14.2 | 候选词在文本中以浅色下划线标出，点一下即接受为 `Blank` + `VocabEntry` | 一次点击完成 FR-7.3 |
| FR-14.3 | 接受时自动填充 `surface` / `lemma` / `gender` / `plural` / `meaning` | 从 `data-title` 解析性和复数（格式 `名词, 复数词尾 (性.)`）；`meaning` 取 `Knowledge.text` 的纯文本 |
| FR-14.4 | 解析不出 `data-title` 格式时降级：只填 `surface`，其余留空 | 不能因为格式意外就丢掉整个候选 |
| FR-14.5 | 「全部接受」按钮，但**不是默认行为** | 有些期次 Glossar 有二十多条，全接受会把生词本灌满你本来就认识的词 |

**对 V2 的影响**：§7.7 原计划用 Claude API 做语境释义。在 DW 素材上，释义、性、复数 DW 已经给了，且是德德释义（比中文释义更适合 C1）。Claude API 的价值收窄到两处：① 非 DW 素材；② DW 没标注但你不认识的词。

---

## 6. 数据模型（修订版）

模型按 §2.3 的两层切开。**判断一个字段属于哪层的标准只有一条：丢了能不能重建。**

```ts
// ══════ 标注层：跨设备同步，永不可重建 ══════

interface Lesson {
  id: string;
  title: string;                 // "Alltagsdeutsch: Der deutsche Wald"
  source:
    | { type: 'dw'; dwLessonId: string; sourceUrl: string }   // 可补齐（FR-3.5）
    | { type: 'manual'; audioFileName?: string };             // 不可补齐（FR-3.6）
  audioDuration?: number;        // 秒；补齐或重绑定时校验时长
  manuscriptHash?: string;       // plainText 的 hash；补齐后校验 DW 是否改过稿（FR-3.7）
  sentences: Sentence[];
  createdAt: number;
  updatedAt: number;             // 跨设备合并用（§2.4）
}

interface Sentence {
  index: number;
  text: string;
  charStart: number;             // 在 LessonCache.plainText 中的 offset（FR-2.4）
  charEnd: number;
  startTime?: number;            // 秒，未标注为 undefined
  endTime?: number;              // 显式标记；否则按 FR-4.4 推断
  endTimeExplicit: boolean;      // 区分显式与推断
  blanks: Blank[];
  markedDifficult: boolean;      // 跟读时跟不上的句子
  excluded: boolean;             // 非朗读内容，如 Glossar（FR-1.4）
}

interface Blank {
  id: string;
  ranges: Array<{ start: number; end: number }>;  // 句内 offset；多区间支持 "hing ... ab"
  surface: string;               // 拼接后的表层形式："gelaufen" / "hing ab"
  lemma?: string;                // V2 填充
  vocabEntryId: string;          // 反向关联，听写结果回写 FSRS（FR-8.6）
}

interface VocabEntry {
  id: string;
  surface: string;
  lemma?: string;                // V2
  gender?: 'm' | 'f' | 'n';
  plural?: string;
  meaning?: string;
  contextSentence: string;       // 原句，只存本地，永不进 ShareablePackage
  lessonId: string;
  sentenceIndex: number;
  dwKnowledgeId?: string;        // 来自 Glossar 候选（FR-14）；也用于判断候选是否已接受
  hasTimestamp: boolean;         // 来源句是否有 startTime（FR-10.5）
  suspended: boolean;            // 暂停复习
  fsrs: FSRSCard;                // ts-fsrs 状态
  createdAt: number;
  updatedAt: number;
}

interface Settings {
  newPerDay: number;             // 10
  reviewPerDay: number;          // 60
  shadowingGapRatio: number;     // 1.2
  shadowingRepeat: number;       // 2
  playbackRate: number;          // 1.0
  dictationStrictCase: boolean;  // true
  lastBackupAt?: number;         // 备份提醒（FR-11.4）
}

// ══════ 缓存层：本机持有，不同步，可随时丢弃 ══════

interface LessonCache {
  lessonId: string;              // = Lesson.id
  manuscriptHtml?: string;       // DW 原始 HTML；手动导入时存粘贴的原文
  plainText?: string;            // 转换后的纯文本，Sentence.charStart/charEnd 的基准
  glossary?: GlossaryCandidate[];// FR-14 候选词
  hasAudio: boolean;
  audioBytes: number;            // 占用统计（FR-3.8），读它不必载入 Blob
  fetchedAt: number;
}

interface GlossaryCandidate {
  dwKnowledgeId: string;
  sentenceIndex: number;
  ranges: Array<{ start: number; end: number }>;  // 句内 offset
  surface: string;               // "Plattformen"
  title: string;                 // "Plattform, -en (f.)"，原样保留以便降级（FR-14.4）
  lemma?: string;                // 解析出的 "Plattform"
  gender?: 'm' | 'f' | 'n';
  plural?: string;               // "-en"
  meaning?: string;              // Knowledge.text 的纯文本
}

// 可分享包（V1 只实现函数 + 测试，不暴露 UI）
interface ShareablePackage {
  formatVersion: 1;
  sourceUrl?: string;
  title?: string;                // 仅内容标识，如 "Alltagsdeutsch, 2025-11-03"
  timings: Array<{ index: number; start: number; end: number }>;
  blanks: Array<{
    sentenceIndex: number;
    ranges: Array<{ start: number; end: number }>;
    lemma?: string;
  }>;
  // 绝不含：plainText / Sentence.text / Blank.surface / contextSentence
}
```

**IndexedDB object stores**：

| store | 层 | 内容 |
|---|---|---|
| `lessons` | 标注 | `Lesson`（含 `sentences`、`blanks`） |
| `vocab` | 标注 | `VocabEntry` |
| `settings` / `meta` | 标注 | 设置、上次备份时间等 |
| `lessonCache` | 缓存 | `LessonCache`（文本 + Glossar + 体积元数据） |
| `audioBlobs` | 缓存 | `lessonId → Blob`，**单独一个 store** |

音频单独开 store，是为了让 FR-3.8 的占用列表和缓存命中判断能只读元数据，不必把 6–10 MB 的 Blob 载进内存。

**关于一处刻意的冗余**：`Sentence.text` 和 `VocabEntry.contextSentence` 严格说可以由 `LessonCache.plainText` + offset 推导出来，放进标注层是重复存储。这是**故意的** —— 它让标注层在 DW 撤稿、改稿或你清空缓存之后**依然完整可读**：句子还在，生词的语境还在，复习照常，只是没有音频。为了这个，多存几百 KB 完全值得。反过来，`plainText` 本身不进标注层，因为它能从这些句子拼回来。

---

## 7. 技术决策

### 7.1 句子切分

`Intl.Segmenter('de', {granularity:'sentence'})` 初切（Chrome 87+ / Safari 14.1+ / Firefox 125+），随后按序应用合并规则：

| 规则 | 条件 | 说明 |
|---|---|---|
| **R-lower** | 下一片以**小写字母**开头 → 合并 | 最强的启发式：德语所有名词大写、句首必大写，小写开头几乎一定是误切 |
| **R-abbr** | 本片以已知缩写结尾 → 合并 | 见下表 |
| **R-ordinal** | 本片以 `\d+\.` 结尾 → 合并 | `am 3. Oktober`、`im 19. Jahrhundert`（这类靠大小写无法判断，因为 Jahrhundert 本就大写） |
| **R-initial** | 本片以单个大写字母 + `.` 结尾 → 合并 | `A. Merkel` |
| **R-quote** | 引号或括号未闭合 → 合并 | — |

缩写表（可在设置中扩充）：
`z. B.` `u. a.` `d. h.` `bzw.` `usw.` `evtl.` `ggf.` `ca.` `vgl.` `bspw.` `i. d. R.` `z. T.` `v. a.` `o. Ä.` `u. Ä.` `Dr.` `Prof.` `Nr.` `Abb.` `S.` `Jh.` `Mio.` `Mrd.` `St.` `Str.`
（同时匹配带空格与不带空格的变体：`z. B.` 与 `z.B.`）

**无论规则多好，FR-2.3 的手工修正都是必须的。** 规则只是把需要手工修的句子从 30 句降到 3 句。

### 7.2 时间戳

DW 只给文本和音频，不给对应关系，映射必须自己造。V1 用手动打点：工程量接近零，且符合实际使用——一期里真正需要反复听的可能就五六句，全部标注多数用不上。

数据模型已留好 `startTime` / `endTime`，V2 接自动对齐（aeneas / Montreal Forced Aligner / whisper.cpp-WASM）时不改模型，只加一个写入器。

### 7.3 音频播放

- **全局单例 `<audio>` 元素**（iOS 手势链约束，§3.2）。
- 句子播放 = 设 `currentTime = start` + `play()`，检测越过 `end` 后 `pause()`。`timeupdate` 触发频率约 4Hz，精度不够，用 `requestAnimationFrame` 轮询 `currentTime`。
- 跟读循环用**状态机**实现，不用嵌套 `setTimeout`：
  `IDLE → PLAYING → GAP → (repeat--) → PLAYING | NEXT`
  变速、跳句、暂停都作为状态机事件处理，避免定时器泄漏。

### 7.4 听写校验分级

先做归一化：`trim` + 折叠连续空白。然后：

| 结果 | 判定 | 处理 |
|---|---|---|
| **正确** | 完全一致（含大小写、含变音符） | FSRS `Good` |
| **转写等价** | 仅 `ae/oe/ue/ss` ↔ `ä/ö/ü/ß` 的差异 | 不计错，提示「注意变音符」，FSRS `Good`（照顾没有德语键盘的场景） |
| **仅大小写错** | 忽略大小写后一致 | FSRS `Hard`，提示「注意大写」（`dictationStrictCase=false` 时按正确处理） |
| **错误** | 其他 | FSRS `Again`，展示字符级 diff |

注：`ß/ss` 在瑞士德语中是合法变体，但 DW 是标准德语，故归入「转写等价」而非「正确」——给提示但不惩罚。

### 7.5 FSRS 与卡片方向

用 `ts-fsrs`。卡片方向是**听觉识别**方向，不做「中文 → 德语」。

理由：真实痛点是听觉识别 —— 看到 `Zuversicht` 认得，听到 /ˈtsuːfɐˌzɪçt/ 反应不过来。这是两套独立的记忆，产出型（中→德）不是当前目标。

### 7.6 技术栈

| 层 | 选择 | 理由 |
|---|---|---|
| 构建 | Vite | — |
| 框架 | React + TypeScript | — |
| PWA | `vite-plugin-pwa` | manifest + Service Worker；只缓存应用壳，不缓存学习数据 |
| 存储 | IndexedDB via `idb` | localStorage 存不下音频 |
| SRS | `ts-fsrs` | 成熟实现，调度质量明显优于 SM-2 |
| 状态 | Zustand | 单用户小应用，不需要 Redux |
| 样式 | Tailwind | 个人工具，出界面快 |
| 测试 | Vitest | 至少覆盖：切句规则、听写校验、`toShareablePackage`、合并逻辑、各来源 extractor |
| 抓取 | 浏览器原生 `fetch` + `DOMParser` | 无后端、无第三方库。RSS 是 XML，`DOMParser` 直接解析；页面只需要内嵌的 JSON（§7.8） |

### 7.7 V2 预留（不在 V1 实现，但不挡路）

- **词形还原 + 语境释义**：优先走 Claude API（把「词 + 整句」一起发过去，返回该语境下的释义、词性、复数、支配介词），省掉 spaCy 那层 Python 基础设施。可分动词（`hing ... ab` → `abhängen`）需要句法分析才能还原，模型比规则划算。PWA 直连需要 `anthropic-dangerous-direct-browser-access` header 或一个极薄的代理。
- Wiktionary 离线词典（Kaikki.org 解析后 JSON dump，CC BY-SA，**需标注署名**）
- 自动强制对齐、自动挖空判定、TTS、无文稿素材转写

### 7.8 DW adapter（纯前端）

没有后端。整条链路就是浏览器里的三次 `fetch`：

```
浏览器 PWA
   │
   ├─① fetch(RSS)        → DOMParser 解析 XML   → 期次列表
   │
   ├─② fetch(页面 HTML)  → 正则截出 window.__APOLLO_STATE__
   │                      → JSON.parse           → manuscript / knowledges / mp3Src
   │
   └─③ fetch(mp3Src)     → Blob                 → IndexedDB
```

三个端点全部返回 `Access-Control-Allow-Origin: *`（附录 A.1），因此无需代理、无需扩展、无需本地进程。

**解析 `__APOLLO_STATE__`**：它是 `window.__APOLLO_STATE__={...}` 形式的内联 JS，不是 `<script type="application/json">`，所以取不到现成的 JSON。用**字符串感知的大括号配平**从 `={` 扫到匹配的 `}`（要正确处理 `\"` 转义和字符串内的花括号），再 `JSON.parse`。不要用贪婪正则。

需要的实体（键名即 `<类型>:<id>`，id 与 RSS `<guid>` 一致）：

| 实体 | 字段 | 用途 |
|---|---|---|
| `Lesson:<id>` | `manuscript` | 正文 HTML（只含 `<p> <strong> <br> <span>`） |
| | `teaser` | 用于 FR-13.7 判定开头非朗读块 |
| | `name`、`namedUrl`、`firstPublicationDate` | 标题、`sourceUrl`、真实首发日期 |
| | `knowledges` | `__ref` 数组，指向 Glossar 条目 |
| `Audio:<id>` | `mp3Src`、`duration` | 音频直链与秒数（预填 `audioDuration`） |
| `Knowledge:<id>` | `name`、`text` | 词条（含性和复数）与德语释义（FR-14） |

**manuscript → 纯文本，必须保留 offset 映射**（关键实现约束）：

正文里的 GLOSSARY span 携带 FR-14 需要的位置信息，而 FR-2 切句、`Sentence.charStart`、`Blank.ranges` 全都基于纯文本 offset。所以 HTML→文本的转换**不能**是 `innerText` 一把梭，必须在遍历 DOM 时同步产出「纯文本」和「每个 GLOSSARY span 在纯文本中的 `[start, end)`」。这一步做错，FR-14 的候选词会标到错误的位置上，而且是**静默错位**，很难发现。为它单写一组单元测试。

转换规则：`<br />` → `\n`；`</p>` → `\n\n`；HTML 实体（`&bdquo;` `&ldquo;` `&ndash;` `&rsquo;` 等）要解码成真正的字符 —— 德语引号 `„…"` 会进入 §7.1 的 R-quote 规则，解码错了切句就跟着错。

**已否决的替代方案**：

| 方案 | 否决理由 |
|---|---|
| 本地 Node helper 进程 | 原方案。CORS 实测不存在，helper 解决的是一个不存在的问题；还会带来两个 origin、两份 IndexedDB、以及一个要记得启动的进程 |
| CORS 代理（公共或自建） | 把服务器放进内容通路，正是 §3.1.1 R-1 的唯一红线 |
| 浏览器扩展 | 为一个每周用一次的功能维护扩展的打包与权限流程，不值 |
| Tauri / Electron | 已在 §2 定为 PWA；且现在也没有它能解决而 PWA 不能的问题 |
| 抓 DW 的 GraphQL 端点而非页面内嵌 state | 端点和 query 结构未公开，比内嵌 state 更容易变；内嵌 state 是页面渲染必需的，DW 不会轻易去掉 |

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 浏览器驱逐 IndexedDB | **缓存层：无所谓**（重新下载即可）<br>**标注层：致命** | 分层（§2.3）把风险面从 700 MB 缩小到几百 KB。`persist()` + iOS 必须装主屏幕 + GitHub 自动备份（FR-11.2/11.3）—— 现在保护的只是那个小文件 |
| 换手机 / 设备丢失，几年的 FSRS 状态蒸发 | **致命，且不可重建** | 自动备份异地存放（§2.6.3）；`vocab.json` 每次复习结束就推，不可重建的数据不过夜 |
| 备份静默失败，用完全无察觉 | **致命** —— 比没有备份更糟，因为它给虚假的安全感 | 备份状态常驻可见（FR-11.5）；失败显式报警；离线排队重试（FR-11.6） |
| 数据被写坏后，坏数据覆盖掉好备份 | 高 | git 版本历史可回滚到任意一天；手动导出按日期命名不覆盖（FR-11.7） |
| GitHub 账号失效 / PAT 被撤销 | 中 | 保留手动导出作为不同故障域的第二道保险（FR-11.7/11.8） |
| 恢复路径长期没人走，早已悄悄坏掉 | 中 | 验收必须完整演练一次；每年提示重演（FR-11.11、§2.6.5） |
| 存储配额被音频撑爆 | 中 | 缓存可清空且无损（R-缓存-3）。配额告警时引导清除最旧的 N 课缓存，标注层不受影响 |
| DW 改稿导致补齐后 offset 全错 | 中 | `manuscriptHash` 校验（FR-3.7）。这是**静默数据损坏**类风险，必须在补齐时就拦住，不能等到跟读发现对不上 |
| 切句错误导致整篇索引错乱 | 高 | 强制手工修正 UI（FR-2.3）+ R-lower 启发式 |
| Manuskript 含 Glossar，与音频不对应 | 高 | 段落排除（FR-1.4） |
| 手机上没有音频，复习退化成看文本 | 高 | 音频缺失态显式化（FR-3.3）+ 手动搬运流程写进 README |
| 两端同时复习，FSRS 状态分叉 | 中 | 约定单向搬运（§2.3）+ last-write-wins 合并 + 合并摘要 |
| V1 无 lemma，同词跨课重复建卡 | 中 | surface 匹配提示合并（FR-9.3），接受局限，V2 补批量归并 |
| 标注全部句子太累导致弃用 | 中 | 稀疏打点是**设计**不是妥协；UI 明示「已标注 6 / 112」不制造焦虑 |
| iOS 静音开关导致「没声音」被误判为 bug | 低 | README 提示；必要时换 Web Audio API |
| DW 改版打掉自动抓取 | 中 | 三层降级（FR-13）+ `__APOLLO_STATE__` 快照回归测试让改版先让测试红；**L3 手动路径永不删除** |
| DW 收紧 CORS 头，纯前端方案失效 | 中 | 这是整个 FR-13 的单点依赖。真发生了就退回本地 helper 方案（§7.8 已记录其设计），或退 L3。**因此 adapter 层必须与 UI 解耦**：换成 helper 时只改数据来源，不动导入流程 |
| GLOSSARY span 的 offset 映射静默错位 | 中 | HTML→文本转换单独写测试（§7.8）；候选词在 UI 上高亮显示，错位肉眼即可见 |
| 自动导入被误解为「工具在分发内容」 | 中 | §3.1.1 的 R-1～R-5 写进 README；实现上就是浏览器直连，代码里根本没有服务器 |
| 「一键导入全部 100 期」的诱惑 | 低 | 明确不做（FR-13.10）。既是 R-3 的礼貌约束，也是防止一次性灌进 100 期后一篇都不学 |

---

## 9. 建议实现顺序

V1 一次做完，但按下面顺序写，每步都能跑：

1. 数据层：IndexedDB 两层 schema + `persist()` + 导出/导入合并（先把命根子做稳）
1b. **GitHub 自动备份 + 恢复（FR-11）** —— 紧跟数据层，在积累任何真实数据之前就跑通。等攒了半年再补备份，那半年是裸奔的
2. 导入 + 切句 + 手工修正（②）
3. 音频存取 + 全局播放器单例（③）
4. 时间戳标注（④）
5. **跟读模式**（⑥）← 到这里工具已经比打印文稿好用了，可以先用起来
6. 生词标记 + 挖空（⑤）
7. 听写（⑦）
8. 生词本 + FSRS 复习（⑧）
9. PWA 打包 + 手机端复习界面适配 + 跨设备同步
10. DW adapter + 自动导入（FR-13 / §7.8）
11. Glossar 候选词（FR-14）

理由（同原规格 §8）：界面优先级 **跟读 > 听写 > 复习**。跟读每次都会用，复习要攒够词才有意义。

第 10 步排在后面，是因为它只替 FR-1.2 / FR-1.3 填数据 —— 技术上第 2 步之后随时能做，但它省的是每篇 5 分钟，而前 9 步决定的是工具到底能不能用。**先把地板铺好，再铺地毯。**

不过在探明 CORS 之后（附录 A），第 10 步的成本从「写一个 Node 服务 + 处理两个 origin」掉到「三个 `fetch` + 一次 `JSON.parse`」，大约半天。如果第 2 步做完时手痒，提前做掉也不会亏 —— 它不改动任何已有代码路径。

第 11 步依赖第 6 步（挖空）已经存在，否则候选词无处可去。

---

## 10. 验收清单：跑通一篇 Alltagsdeutsch

- [ ] 从 DW 下载一期 mp3 + 复制 Manuskript，导入成功
- [ ] 自动切句后，手工修正不超过 5 处即可得到正确句子列表
- [ ] 文末 Glossar 被成功排除，不出现在任何练习中
- [ ] 通听一遍，中途关闭浏览器再打开，**无任何网络请求**即可继续播放（缓存命中，R-缓存-1）
- [ ] 标注 6 句想练的句子，其中有一句用微调修正了起点
- [ ] 跟读这 6 句：循环、静默间隔、0.85 倍速都正常；标记其中 2 句为困难；切换到「只练困难句」正常
- [ ] 标记 10 个生词，其中至少 1 个是不连续搭配（如 `hing ... ab`）
- [ ] 听写：故意打 `Hauser` → 判为「转写等价」；故意打 `zuversicht` → 判为「仅大小写错」；故意打错一个词 → 判错并显示 diff
- [ ] 错词自动进生词本，带原句
- [ ] 第二天打开，SRS 队列有卡；卡片正面自动播放句子音频
- [ ] 导出备份 JSON：含 `_warning` 字段，**不含任何音频数据**，体积在几十 KB 量级
- [ ] 粘贴 PAT → 自动显示「已连接：@你的用户名」→ 一键创建私有备份仓库，**全程不需要手填 owner/repo**
- [ ] 试着选一个 public 仓库 → 被拒绝并说明原因；试一个只读 token → 配置阶段就报错，而非等到第一次备份
- [ ] 复习一轮 → 仓库里出现新 commit，`vocab.json` 的 FSRS 状态已更新
- [ ] 断网复习 → 备份进入排队且有提示 → 恢复网络后自动推送成功
- [ ] **恢复演练（不做完不算验收通过）**：换一个浏览器 profile，只填 PAT → 一键恢复 → 标注、生词、FSRS 状态全部齐全 → 课程显示「素材未下载」→ 补齐 → 完成一轮带音频的复习
- [ ] 手机上「添加到主屏幕」，同样只靠 PAT 恢复（**不传任何文件**），完成一轮带音频的复习
- [ ] 桌面上清除这一课的缓存 → 标注、生词、FSRS 状态全部完好 → 重新补齐后时间戳依然对得上（`manuscriptHash` 校验通过）
- [ ] `toShareablePackage` 的单元测试通过（导出物不含任何正文）

---

## 11. 待决问题

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 手机上是否真的要能跟读？如果只复习，音频搬运可以省掉整个流程 | 先按「能跟读」做（音频照搬），实际用两周后再看要不要砍 |
| ~~Q2~~ | ~~一年后音频累计约 700MB，是否需要「归档旧课程」~~ | **已解决**：数据分层（§2.3）后这就是 FR-3.8 的「清除缓存」，对 DW 课程无损，不需要单独的归档概念 |
| Q3 | 是否需要「一个生词对应多个语境句」 | V1 一对一；FR-9.3 的合并操作会丢弃被合并方的 `contextSentence`。若实际很需要，模型改成 `contexts: Array<{ lessonId, sentenceIndex, sentence }>` |
| Q4 | 手机端是否也做听写（输入德语变音符很痛苦） | 已加 ä ö ü ß 快捷按钮（FR-8.7）；先做，不好用再砍 |
| ~~Q5~~ | ~~Manuskript 能不能抓到~~ | **已验证：能。** 在 `window.__APOLLO_STATE__` 的 `Lesson:<id>.manuscript` 字段里，服务端渲染，约 7.8k 字符。见附录 A.3 |
| ~~Q6~~ | ~~DW 是否返回宽松 CORS 头~~ | **已验证：RSS、页面、mp3 三者全部 `Access-Control-Allow-Origin: *`。** 本地 helper 整个方案作废。见附录 A.1 |
| Q7 | 存档期次（400+ 期）RSS 只给 100 条窗口，老期次怎么进来 | 靠 L2 粘贴 URL 或 lesson id。存档列表页 `/de/alltagsdeutsch/s-9214` 尚未验证是否也在 `__APOLLO_STATE__` 里给出完整列表 —— 值得再花 10 分钟看一眼，若给了，L1 就能覆盖全部存档 |
| Q8 | DW 的 Glossar 释义是德语的，对 C1 是优点还是负担 | 先按德德释义用（FR-14.3）。真觉得吃力，V2 的 Claude API 可以在此基础上补中文，而不是从头查词 |

---

## 附：素材来源

| 来源 | 等级 | 说明 |
|---|---|---|
| DW Alltagsdeutsch | C1/C2 | `learngerman.dw.com/de/alltagsdeutsch/s-9214`。400+ 期存档。**实测：RSS 给最近 100 期，但其中多为存档旧期以当周日期重新推送**（附录 A.2），单期时长 6–10 分钟。音频 + Manuskript + Glossar 全部可程序化获取 |
| DW Sprachbar | C1/C2 | `dw.com/de/deutsch-lernen/sprachbar/s-9011`。专讲词场和惯用法 |
| DW Langsam gesprochene Nachrichten | B2 | `learngerman.dw.com/de/langsam-gesprochene-nachrichten/s-60040332`。每天更新，每条 100–200 词，带全文。词汇偏时事，覆盖面窄 |
| Aspekte neu C1 | C1 | 教材音频，Klett 官网部分免费提供 |
| RSS | — | `rss.dw.com/xml/DKpodcast_alltagsdeutsch_de` |

**V2 无文稿素材**（需先做转写）：`Alles gesagt?`、`Hotel Matze`、`Fest & Flauschig`（纯 Umgangssprache）、`Zeit Verbrechen`（真实案件叙事，与 Schirach 同语域）、ARD/ZDF Mediathek（带德语字幕）。

---

## 附录 A：DW 接口实测结果

> 探测时间 **2026-08-30**。样本：Alltagsdeutsch「„Work and Travel" – Geld verdienen und Reisen im Ausland」，lesson id `45334084`。
> 这是 FR-13 / FR-14 / §7.8 的全部事实依据。DW 改版后此附录即失效，需重跑 A.5。

### A.1 CORS（决定性发现）

| 端点 | 结果 |
|---|---|
| `rss.dw.com/xml/DKpodcast_alltagsdeutsch_de` | `Access-Control-Allow-Origin: *` |
| `learngerman.dw.com/de/<slug>/l-<id>` | `Access-Control-Allow-Origin: *` |
| `radiodownloaddw-a.akamaihd.net/...mp3` | `Access-Control-Allow-Origin: *`，另有 `Accept-Ranges: bytes`、`Content-Length` |

**浏览器可以直连三者**，所以不需要后端、代理或本地进程。这是整个 FR-13 得以纯前端实现的唯一原因，也是它的单点依赖（见 §8）。

### A.2 RSS feed

100 个 `<item>`。单条包含：

```xml
<item>
 <guid isPermaLink="false">45334084</guid>
 <pubDate>Tue, 25 Aug 2026 07:36:00 GMT</pubDate>
 <title>„Work and Travel" – Geld verdienen und Reisen im Ausland</title>
 <link>https://learngerman.dw.com/de/work-and-travel-.../l-45334084?maca=de-DKpodcast_alltagsdeutsch_de-2283-xml-mrss</link>
 <description>...两句德语摘要，此处按 §3.1.1 R-5 省略...</description>
 <itunes:duration>06:16</itunes:duration>
 <enclosure url="https://radiodownloaddw-a.akamaihd.net/Events/podcasts/de/2283_.../6CB36D94_2-podcast-2283-45334084.mp3"
            type="audio/mpeg" length="7117421"/>
 <itunes:keywords>..., Alltagsdeutsch, C1</itunes:keywords>
</item>
```

要点：

- `<guid>` = lesson id = `<link>` 里的 `l-<id>` = `__APOLLO_STATE__` 的 `Lesson:<id>`。**用它做主键**（FR-13.8）。
- `<description>` **只是两句摘要，不含 Manuskript**。文稿必须从页面取。
- `<link>` 带 `?maca=` 跟踪参数，不要拿它当稳定标识。
- **`pubDate` 不是首发日期。** 本例 `pubDate` 是 2026-08-25，而页面里的 `firstPublicationDate` 是 **2019-04-02** —— DW 在把存档旧期以当周日期重新推送。这印证了 §7 素材表里「更新已放缓，靠吃存档」的判断，也是 FR-13.3 存在的原因。
- RSS 的 `<enclosure>` URL 与页面里的 `mp3Src` 路径不同（`/podcasts/de/2283_...` vs `/dira/mp3/deutschkurse/...`），但指向同一个文件 id（`6CB36D94_2`）。两个都能下，用哪个都行。

### A.3 页面：`window.__APOLLO_STATE__`

页面 79KB，**服务端渲染**，内联一个约 60KB 的 Apollo GraphQL cache。（页面 HTML 里出现的两处 `Manuskript` 字样只是界面 i18n 文案，不是正文 —— 按关键词找会误判。）

实体键：`Lesson:45334084`、`Audio:78400094`、`Knowledge:*`（本期 13 条）、`Image:*`、`Navigation:*`、`Article:*`。

`Lesson` 关键字段实测值：

| 字段 | 值 |
|---|---|
| `manuscript` | 7824 字符 HTML，**只用到 `<p> <strong> <br /> <span>` 四种标签** |
| `teaser` | 214 字符，与 `manuscript` 开头 `<strong>` 块内容重合 |
| `name` / `namedUrl` / `canonicalUrl` | 标题与稳定 URL |
| `firstPublicationDate` | `2019-04-02T13:00:47.203Z`（真实首发） |
| `knowledges` | 13 个 `__ref`，指向 Glossar 条目 |
| `dkLearningLevel` | `32`（推测为 C1，未验证映射表） |

`Audio` 关键字段：`mp3Src`（直链）、`duration`（**376 秒**，可预填 `audioDuration`）、`formattedDuration`（`06:16`）。

`manuscript` 结构（实测）：

- 开头是一个 `<strong>` 块 = 标题 + teaser，**音频里不朗读** → FR-13.7 排除。
- 结尾**没有** Glossar 段落，正文到最后一句就结束。Glossar 是独立的 `Knowledge` 实体，不在正文里。这比预期好 —— 对 DW 自动导入而言，FR-1.4「批量排除文末 N 句」基本用不上（手动粘贴 PDF 时仍然需要）。
- 生词在正文中**内联标注**：

```html
<span class="editable placeholder" data-fromselection="true"
      data-id="43252624" data-title="Plattform, -en (f.)"
      data-type="GLOSSARY" title="Glosar">Plattformen</span>
```

对应实体：

```json
"Knowledge:43252624": {
  "knowledgeType": "GLOSSARY",
  "name": "Plattform, -en (f.)",
  "text": "<p>...德语释义...</p>"
}
```

即：句中表层形式、词条、复数词尾、性、德语释义、精确字符位置，一次全给。这是 FR-14 的全部依据。

其他实测样本（说明 `data-title` 的格式变化，FR-14.4 要能降级）：

- `Gelegenheitsjob, -s (m.)` — 标准名词，性 + 复数词尾
- `surfen` — 动词，无性无复数
- `Down Under (aus dem Englischen)` — 带来源说明，无性
- `Great Ocean Road (f., nur Singular, aus dem Englischen)` — 性 + 「仅单数」+ 来源

### A.4 尚未验证

- 存档列表页 `/de/alltagsdeutsch/s-9214` 是否也在 `__APOLLO_STATE__` 里给出完整的 400+ 期列表（Q7）
- Sprachbar 与 Langsam gesprochene Nachrichten 的页面是否同构（推测同构，同一套前端）
- `dkLearningLevel` 数值到 CEFR 等级的映射

### A.5 重新验证命令（PowerShell）

> 注意用 `curl.exe` 而不是 `curl` —— 后者在 Windows PowerShell 里是 `Invoke-WebRequest` 的别名，参数不兼容。

```powershell
curl.exe -sI -H "Origin: https://example.app" https://rss.dw.com/xml/DKpodcast_alltagsdeutsch_de | Select-String "access-control"
```

```powershell
curl.exe -sL https://rss.dw.com/xml/DKpodcast_alltagsdeutsch_de | Select-String -Pattern "<enclosure|<guid|<itunes:duration" | Select-Object -First 6
```

```powershell
curl.exe -sL "https://learngerman.dw.com/de/work-and-travel-geld-verdienen-und-reisen-im-ausland/l-45334084" | Select-String -Pattern "__APOLLO_STATE__" -SimpleMatch | Select-Object -First 1
```

---

## 附录 B：GitHub API 实测结果

> 探测时间 **2026-08-30**。这是 §2.6.3 与 FR-11 的事实依据。

### B.1 CORS：API 开放，OAuth 端点封闭

| 端点 | 预检 (OPTIONS) | `Access-Control-Allow-Origin` | 浏览器可用 |
|---|---|---|---|
| `api.github.com/*` | — | `*`（**连 401 响应都带**） | ✅ |
| `github.com/login/device/code` | **404** | 无 | ❌ |
| `github.com/login/oauth/access_token` | **404** | 无 | ❌ |

**这张表决定了 FR-11 的形状**：token 拿到之后所有操作都能在浏览器里做，但**获取 token 的过程不能**。

三条 OAuth 路径全部堵死：

1. **授权码流程** —— 需要 `client_secret` 换 token，秘密不能放在浏览器里
2. **PKCE**（SPA 的标准解法）—— GitHub 至今不支持
3. **Device Flow** —— 本是为「存不住秘密的设备」设计、只需 `client_id`，但两个端点都在 `github.com` 而非 `api.github.com` 上，**预检 404、无任何 CORS 头，浏览器根本发不出请求**

因此 V1 采用 PAT，并把「粘贴之后的一切」全部自动化（FR-11.2 ~ 11.4）。

### B.2 待实现时确认

- token 过期时间的**具体响应头名称**（FR-11.5 依赖它做续期提醒）
- fine-grained PAT 的最长有效期上限，以及是否允许「永不过期」
- `POST /user/repos` 创建的仓库默认分支名（拼接 contents API 路径时要用）

### B.3 重新验证命令（PowerShell）

```powershell
curl.exe -s -o NUL -D - -H "Origin: https://example.app" https://api.github.com/user | Select-String "access-control-allow-origin"
```

```powershell
curl.exe -s -o NUL -D - -X OPTIONS -H "Origin: https://example.app" -H "Access-Control-Request-Method: POST" https://github.com/login/device/code | Select-String "HTTP/|access-control"
```
