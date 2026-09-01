# 新会话开工提示

> 复制下面整段，粘贴到新会话即可开工。

---

项目：德语精听训练器（个人自用工具，工作目录 D:\deutsch）

**先读 SPEC.md，再读 README.md。** 需求文档已定稿，包含完整的功能需求、数据模型、技术决策、风险表和验收清单。
附录 A 是 DW 接口的实测结果（A.6 是实现完成后用真实期次做的复验），附录 B 是 GitHub API 的实测结果——
这些是真实探测出来的事实，不要重新假设，也不用重新验证（除非怀疑对方改版了）。

## 现状（2026-09-01）

**§9 实现顺序的 11 步已全部完成**，`main` 上可跑、可构建、254 个单元测试通过。

已经用真实的 Alltagsdeutsch 期次 `45334084` 端到端跑通：RSS → 页面 `__APOLLO_STATE__` → mp3 下载 →
切句（42 句）→ teaser 块自动排除 → 14 条 Glossar 候选词**全部落位正确** → 打点 → 接受候选词 →
听写判级 → FSRS 复习。详见 SPEC.md 附录 A.6。

**FR-15 自动对齐已完成**（在 §9 的 11 步之外新增，见 SPEC.md §0 第 17 条、FR-15、§7.9）：
浏览器内跑 CTC 强制对齐（MMS-FA + 自己实现的 Viterbi），从「已切好的句子 + 音频」直接算出
句级与词级时间戳。已在同一期真实素材上验过：45 秒写入 38 句 + 744 个词级时间戳，
标出 5 句待校对，词级边界抽查合理。代码在 `src/align/`。

**手工标注已整节删除（2026-09-01，SPEC §0 变更 20）**：「标注」tab 连同 `Enter` 打点、
±0.1s 微调、清除时间戳一起去掉了。时间戳只有一个来源 —— 音频一到位（DW 导入、手动导入、
补齐素材、重新绑定音频）就排队自动对齐，**不阻塞导入**，进度常驻在应用底部那条
`AlignBar`（`src/components/AlignBar.tsx` + `src/state/useAlignStore.ts`）。
课程页头部的 `AlignStatus` 显示「已对齐 N / M 句 + 低置信句数」并给「重新对齐」。
FR-4 只剩 FR-4.4（区间推断规则）。老数据里手打过的点不会被重跑覆盖。

**同一批做的还有 FR-15.9~15.12（都是为了让手机上跑得完）**：
`src/align/journal.ts` 黑匣子（每阶段同步写 localStorage，进程被系统杀掉后下次启动能自报现场）、
后端阶梯 + 崩溃降档（`webgpu/q4f16` → `wasm/int8`，两档都崩过就停掉自动对齐）、
`src/align/rangedFetch.ts` 按 8MB 分片取随包权重并关掉 transformers.js 的缓存回写。
起因是一次真机事故，见下面「iOS 上那次崩溃」。

**§7.10 原生壳已接入**（Capacitor 8，iOS + Android 两套工程入库）：
壳里跑同一份 `npm run build:native` 产物，业务代码只多了一个 `src/platform/native.ts`
加一处原生代码（`AppDelegate.swift` 把 `AVAudioSession` 设成 `.playback`，顺手修掉了
「iOS 静音开关让 `<audio>` 没声音」那条老坑）。对齐权重随包带（实测 490.2 MiB）。
出包走 CI：推 `ios-v*` tag → 出 IPA 并自动上传 App Store Connect；推 `android-v*` tag → 出签名 APK。

**iOS 流水线已跑通并装机（2026-09-01）**：`ios-v0.1.0` → run 33515038917，5m45s 一次通过，
`UPLOAD SUCCEEDED`，build 1.0(1) 进 TestFlight 装到 iPhone。实测 IPA 381MB、装机 553.6MB。
签名材料全套是这次重签的（旧的丢了，见下面的教训），台账在本机 `D:\cloud\ios\`
（Google Drive 同步）：`apple-account.md` 是账号级值，`new-app-checklist.md` 是无 Mac 的完整流程，
`apps/deutsch.md` 是这个 App 的专属值与状态。**要动 iOS 发布先读那个目录。**
**Android 那条仍未跑过**（tag `android-v*` 一次都没推）。

**iOS 上那次崩溃（2026-09-01，已修但未在真机复验）**：TestFlight 版导入一课后自动对齐，
进度走到「加载对齐模型 181 MB / 187.6 MB」，**整个应用直接消失**（jetsam，JS 侧抓不到）。
根因是峰值内存：同一份 187.6 MiB 权重同时存在五份 —— Capacitor 的 iOS scheme handler 对非媒体
扩展名走 `Data(contentsOf:)` 整份读进原生进程、WebKit 再搬一份、transformers.js 拼一份
`Uint8Array`、**它还会把这 187MB 再抄一份进 Cache API**（一份已在安装包里的文件）、
最后 ORT 拷进 WASM/GPU。第四份正好发生在进度条走到最后那一刻。
修法见 `src/align/rangedFetch.ts` 顶部那段事故分析。
**顺带纠正一条文档断言**：WKWebView **是有 WebGPU 的**（真机诊断页显示 `webgpu / q4f16`），
SPEC §7.10 与旧 README 里「iOS 一定是单线程 WASM + int8」是猜的，猜错了。

**一条教训**：GitHub Actions Secret 只写不可读，`funny` 那套签名数值就是这么丢的
（流水线好使、TestFlight 上过线，但值找不回来，只能整套重签）。
**流程有文档 ≠ 数值有存档**，两件事要分开保管。

**大窟窿一：GitHub 备份从来没用真实 PAT 联调过。** 逻辑完成、mock 测试通过，
但一键建仓、写权限校验、token 过期响应头（附录 B.2 未定）、一键恢复（FR-11.13）都还没碰过真实 API。
§10 验收清单里标 ❌ 的全部卡在这一件事上。

## 下一步建议（按价值排序）

1. **拿一个真实 fine-grained PAT 走完 §10 里标 ❌ 的那一串**，尤其是**恢复演练** ——
   文档里写了「不做完不算验收通过」。顺便把附录 B.2 的三个待确认项填掉
   （过期响应头名称、最长有效期、`POST /user/repos` 的默认分支名）。
2. **实际用两周**，然后再回来改。§10 里标 🧪 的几条（跟读循环、多区间挖空）代码路径有测试，
   但没有人真的连着跟读过十分钟，手感问题只有用出来。
3. **在真机上跑一课，然后读「设置 → 对齐后端」。包已经出好了**：`ios-v0.1.1` →
   run 33525120295，5m25s 一次通过，`UPLOAD SUCCEEDED`，**0.1.1 构建号 2**，IPA 380.8 MiB。
   （这个包不含 App 名字本地化与新图标那批改动 —— 它们是在这个 tag 之后才提交的，
   下次出包才会带上。）
   这是那次崩溃修复的唯一验收：
   诊断页那一行写「分片取权重」= 修复生效；万一还是被杀，顶部黄条会说死在哪一步、哪套后端、
   多少字节 —— 这次不会再是黑箱。本机没有 Mac，所以只能靠设备自己回答。
   同一次装机还要确认另外两件：① 导出备份能不能落到「文件」App；
   ② 顶部安全区在真机刘海下对不对；顺便记一下真机上一课实际跑多久。
   **桌面壳（Electron）仍未做，也不急** —— 桌面就是浏览器。
4. **砍权重 —— 但要等第 3 步先出结论。** 装机 553.6MB 里 490MB 是对齐权重
   （`q4f16` 187.6MiB + `int8` 302.6MiB 两份都带）。现在已知 iOS 走 WebGPU/`q4f16`，
   所以该砍的是 `int8` —— **但它同时是崩溃降档阶梯的第 2 档**（`src/align/config.ts` 的
   `PLAN_LADDER`）。砍了就等于「`q4f16` 一崩就彻底没有退路」。
   所以顺序是：先确认 `q4f16` 在真机上稳定跑完几课，再改 `scripts/stage-align-assets.mjs`
   （支持只带一份）+ `release-ios.yml`，装机降到约 366MB。
   **砍错的后果是自动对齐直接不可用，所以先跑稳再砍。**
5. Q7：存档列表页 `/de/alltagsdeutsch/s-9214` 是否也在 `__APOLLO_STATE__` 里给出完整的 400+ 期列表。
   若给了，L1 就能覆盖全部存档，大约 10 分钟的增量。

明确不要做（文档里已经论证过，不要重开讨论）：

- 不建任何后端、代理或本地 helper 进程（§3.1.1 R-1）
- 不做 GitHub OAuth 登录（附录 B.1 实测：端点无 CORS、不支持 PKCE，纯前端不可行）
- ~~不做自动强制对齐~~ —— **这条已作废，FR-15 做了**（用户 2026-08-31 明确要求集成进应用）。
  自动挖空难度判定、词形还原仍是 V2
- 不做内容分享或托管功能（§3.1 法律边界）
- 不做中文 → 德语方向的卡片（§7.5）
- 不做「一键导入全部期次」（§3.1.1 R-3）

几个容易踩的坑（前四条来自文档，其余都是实现期踩出来的；FR-15 与那次 iOS 崩溃各贡献了一批。全部写进了代码注释）：

- 全程复用同一个 `<audio>` 元素（iOS 手势链约束，§3.2）
- HTML → 纯文本转换必须同步维护 offset 映射，否则 Glossar 候选词会静默错位（§7.8）
- 排序去重用 `firstPublicationDate` 而不是 `pubDate`（DW 在重推旧期，附录 A.2）
- `Intl.Segmenter` 对 `z. B.` 一定会断错，切句强制要有手工修正 UI（FR-2.3、§7.1）
- **改 Lesson 一律走 `useLessonStore.patchLesson`**，不要拿组件闭包里的 lesson 直接 `saveLesson` ——
  连按 Enter 打点时后一次会把前一次静默抹掉。`saveLesson` 也必须**先 `set` 再 `await putLesson`**
- `Sentence.index` 一律等于数组下标，**排除不重排号**；合并/拆分才重排，且必须拿 `indexMap`
  同步 `VocabEntry.sentenceIndex`（SPEC §0 第 16 条）
- 跨句的整段引语会被 R-quote 合并成一句（最长见过 437 字符）。这是规则的正确后果，不是 bug；
  跟读嫌长就手工拆（附录 A.6）
- fine-grained PAT 创建时 Repository access 要选 "All repositories"，不是 "Only select repositories" ——
  一键建仓时目标仓库还不存在，选不了（FR-11.1）
- **FR-15 之前手打的时间戳没有 `timingSource` 字段**，所以「是不是人工的」必须判
  「`=== 'manual'` **或** 有 startTime 但 timingSource 缺失」。只判前者会让一次自动打点
  静默覆盖掉几十分钟手工活（`src/align/apply.ts` 的 `isManual`）
- **Web Audio API 在 Web Worker 里不存在**（`AudioContext`/`OfflineAudioContext` 只在主线程）。
  对齐必须在 Worker 里跑，所以解码留主线程、波形 transfer 进去
- **主线程不要 import `src/align/runtime.ts` 或 `emissions.ts`** —— 它们连着 transformers.js +
  onnxruntime-web，一 import 主包就从 497KB 涨到 1MB。纯配置在 `src/align/config.ts`
- transformers.js **默认从 jsdelivr CDN 拉 ORT 的 wasm**，不覆盖 `wasmPaths` 断网就起不来。
  现在走 Vite `?url`（`onnxruntime-web/ort-wasm-simd-threaded[.asyncify].{wasm,mjs}`）。
  **不要**改回复制到 `public/ort/` —— dist 里会出现两份同样的 23MB wasm
- Cloudflare 的 SPA fallback 给缺失路径返回 **200 + index.html**，所以探测本地模型
  不能只看 `res.ok` —— 要 GET 那份 `config.json` 并真的 parse 一遍。曾经是 HEAD + 验 content-type，
  原生壳里 dist 不由 HTTP 服务器托管，HEAD 和响应头都不保证（§7.10）
- 待校对阈值必须是**相对本课中位数**的。绝对阈值随模型漂：实测中位数 -1.11，
  按感觉写的 -0.6 会把 37/38 句全标黄
- **不要一次性整取权重。** Capacitor 的 iOS handler 对非媒体扩展名走 `Data(contentsOf:)`，
  加上 transformers.js 那次无谓的缓存回写，峰值接近 1GB，真机表现是应用被系统直接杀掉。
  走 `src/align/rangedFetch.ts` 的 8MB 分片（Capacitor 的 Range 分支用 `FileHandle.seek`）
- **判断服务端支不支持 Range 不能只看 206。** Vite dev server 会回
  `206 + Content-Range: bytes 0-196703175/196703176`（整份），只认状态码会让每片都拖回整份文件。
  要比对「回来的区间是不是真的就是我要的那一个字节」
- **进程被系统杀掉时 JS 跑不了任何收尾代码**，所以每个阶段都同步写一条 localStorage 面包屑
  （`src/align/journal.ts`）。localStorage 在 Worker 里不存在 —— 这就是后端选择挪到主线程的原因
- **`detectCrash()` 有副作用（把 running 记录归档），所以 `useAlignStore.init()` 必须真的只跑一次。**
  StrictMode 在开发模式下把 effect 调两遍，第二遍会用 null 把「上次被杀掉了」那条黄条覆盖掉 ——
  实测就是这样丢的，记录归档正常而界面上什么都没有

接原生壳（§7.10）踩出来的五条：

- **`base` 千万不要改成 `'./'`。** 上面那句「打包要配 base: './'」只对 **Electron 的 `file://`**
  成立；Capacitor 有真正的 URL 根（iOS `capacitor://localhost/`、Android `https://localhost/`），
  绝对路径原样就对。这条已经在 SPEC Q9 里改正
- **原生构建必须去掉 Service Worker**（`vite build --mode native`）。`autoUpdate` 的 SW 一旦缓存了
  旧壳的 index.html，`cap sync` 换掉 dist 也照样吃旧的，而原生壳里没有地址栏可以清它
- **`a[download]` 在 WKWebView 里静默失效** —— 不报错、不下载。存文件一律走 `src/lib/download.ts`
- **iOS 的 AppIcon 不能带 alpha 通道**（看的是通道在不在，不是有没有透明像素）。
  Xcode 本地构建完全不报错，第一次上传 App Store 才炸
- **Capacitor 8 的 iOS 走 SPM 不是 CocoaPods**，所以 xcodebuild 用 `-project` 而不是 `-workspace`、
  不跑 `pod install`；模板也不带共享 scheme（自动生成的那份在 gitignore 掉的 `xcuserdata/` 里），
  所以 `App.xcscheme` 手工写了一份入库。funny 停在 Capacitor 6，那边的 workflow 不能照抄

环境：Windows 11 + PowerShell。给我可执行命令时请用 PowerShell 语法（`curl.exe` 而非 `curl`，
`Select-String` 而非 `grep`，`Select-Object -First N` 而非 `head`）。
