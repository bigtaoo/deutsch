# 德语精听训练器

个人自用的德语精听工具：把一期 DW Alltagsdeutsch 切成句子、**下载完就自动把音频和文稿对齐**，然后跟读、挖空听写，错词进 FSRS 复习队列。

纯前端 PWA，没有后端。线上地址 **https://d.gamestao.com**。
手机上也可以装原生壳（Capacitor，iOS + Android）—— 同一份代码，权重随包带、装完就离线，见 §五。
完整需求与技术决策见 [SPEC.md](SPEC.md)；下面只写用之前必须知道的事。

---

## 一、安装要求（**不看这段会丢数据**）

学习数据存在浏览器的 IndexedDB 里。它有多结实，取决于你怎么打开这个应用。

- **iOS 必须「添加到主屏幕」后再用。** Safari 对普通网站有「7 天无交互即清除 storage」的策略，已安装的 PWA 豁免。
  **不装到主屏幕 = 数据一定会丢**，只是早晚问题。
  ——**装 TestFlight / App Store 那个原生版的话这条不适用**：App 的数据只在卸载时消失，
  而且模型权重随包带、装完第一次用就离线。出包方式见 §五「原生打包」。
- 首次启动会自动调 `navigator.storage.persist()` 申请持久化配额，结果显示在设置页。没拿到就去设置页手动点一次。
- 设置页同时显示 `navigator.storage.estimate()` 的用量/配额。音频占大头，一年约 700 MB；
  嫌多就去「素材」页清缓存，**清缓存不会动任何标注**（见下）。

**装好之后第一件事是连 GitHub 备份**，不是先导入课程。理由见下一节。

---

## 二、两层数据：一层可以随便丢，一层丢了就没了

| | 缓存层 | 标注层 |
|---|---|---|
| 内容 | 音频、原始文稿、Glossar 元数据 | 时间戳、切句边界、挖空、生词、FSRS 状态、困难标记 |
| 体积 | 大（一期 6–10 MB） | 小（一期几 KB） |
| 丢了会怎样 | 重新下载即可，**无损** | **不可重建**，一年的功夫没了 |
| 跨设备 | 不跨端，各设备自己持有 | 必须同步 |

所以：

- 「素材」页的清除按钮只清缓存层。DW 来源的课程清了随时能一键补齐；手动导入的课程清了要你自己再找回那个 mp3（界面上用不同颜色和二次确认区分这两种）。
- 备份只保护那个几百 KB 的标注层。导出的 `backup-YYYY-MM-DD.json` 里**零字节音频**。

### 备份怎么配

1. 去 GitHub 创建一个 **fine-grained PAT**：权限只给 `Contents: Read and write`，
   Repository access 选 **"All repositories"**。
   - 不要用 classic PAT 的 `repo` scope —— 那等于交出你全部仓库的读写权。
   - 不能选 "Only select repositories"：一键建仓时目标仓库还不存在，选不了一个不存在的东西。
     建好之后可以回 GitHub 把 token 收紧到只选那一个仓库，token 字符串不变。
2. 把 token 粘进设置页 → 自动显示「已连接：@你的用户名」。
3. 点「一键创建私有仓库」。不需要手填 owner/repo，也不需要离开应用。
4. 第二台设备：在已连接的设备上生成配对二维码，新设备扫一下就完成连接 + 选仓库。
   **二维码里就是明文 token，谁扫到谁就有读写权** —— 别截图发人，生成后 90 秒自动隐藏。

备份状态常驻在首页顶部：上次成功时间、待推送项数、token 剩余有效期。
静默失败的备份比没有备份更危险，所以它不是「出事才亮的灯」。

### 换设备 / 数据没了怎么办

设置页 →「从仓库恢复」→ 粘 token（或扫码）→ 一键恢复。
恢复回来的是标注层，课程会显示「素材未下载」，去「来源」页一键补齐音频即可。
手动导入的课程无从自动补齐，要重新选本地文件（应用会按时长校验，对不上会警告时间戳可能失效）。

**每年走一次恢复演练。** 应用会提醒。工具在变，恢复路径会悄悄坏掉，而你只会在真需要它的那天发现。

---

## 三、怎么用

```
① 导入   从 DW 自动导入，或粘贴文稿 + 选本地 mp3
    ↓
② 切句   自动切分 → 扫一遍 → 合并/拆分误切 → 排除非朗读段落
    ↓
③ 通听   完整听一遍，文本默认折叠
    ↓
④ 对齐   下载课程时已经自动跑完了 → 只看一眼标出来的低置信句
         （手工打点界面已经删掉，只剩「重新对齐」）
    ↓
⑤ 学词   点词标记生词 → 自动挖空 + 进生词本
    ↓
⑥ 跟读   逐句循环 + 静默间隔 + 变速；跟不上的按 D 标困难
    ↓
⑦ 听写   对挖空句作答，四级判定；答错自动进复习队列
    ↓
⑧ 复习   手机上刷 FSRS 队列：听句子 + 看挖空句
```

②③④⑤ 顺序可打乱；⑥⑦ 依赖 ④；⑧ 依赖 ⑤ 或 ⑦。

几件值得知道的事：

- **下载完就自动对齐，不用点任何按钮。** 音频一到位（DW 导入、手动导入、补齐素材、重新绑定音频）
  就排队自动对齐，进度常驻在**应用底部**那条进度条上 —— 它要跑几分钟，所以你可以切去别的页面，
  甚至去复习，回来看一眼就行。想停就点那条上的「停止」。
- **对齐给的是「待校对」，不是「完成」。** 它在你本机跑 CTC 强制对齐（音频不出设备），
  然后把置信度明显偏低的几句在课程页头部报出来。实测一期真实素材是 5 句值得听一遍。
  会漂的地方是固定的那几类：台标音乐、播音员交替、英语借词（`„Working Holiday Visum"`）、
  数字（`zwischen 18 und 30` 里的数词对齐时被丢掉了）。
- **手工打点界面已经删掉了**（「标注」tab 一起没了）。某一句真的对偏了，只能整课「重新对齐」，
  或者在桌面上跑一次 —— 句级时间戳跟着备份同步回来。老数据里手打过的点**不会**被重跑覆盖。
- **首次使用要下载一次约 187 MB 的模型**，之后离线可用；原生壳里权重随包带，装完第一次用就离线。
  不想自动跑就去设置页关掉那个开关（课程页头部的「自动对齐」按钮永远可用）。
- **覆盖率是稀疏还是满，取决于素材本身。** 课程页头部的「已对齐 N / M 句」不是待办清单 ——
  排除句（标题、teaser、Glossar）本来就不进对齐。
- **没有时间戳的句子不能挖空。** 挖了也没有音频可听，听写和带音频的卡都无从谈起。
  界面会拦住你并给一键「自动对齐这一课」。
- **手机上对齐跑不动的话，它会自己说出来。** 见 §五「手机上对齐被系统杀掉时」。
- **切句规则不可能全对。** `Intl.Segmenter` 对 `z. B.` 一定会断错，所以合并/拆分是主路径的一部分，不是高级功能。
  引号里跨句的整段引语会被当成一句（规则如此），跟读时嫌长就手动拆。
- 快捷键：跟读页 `Space` 重播 · `←→` 换句 · `D` 标困难 · `+/-` 变速；
  复习页 `Space` 显示答案 · `1234` 评分。

---

## 四、内容从哪来：BYOC（Bring Your Own Content）

**这个工具不托管、不传输、不经手任何版权内容。** 音频和文稿是你的浏览器直接从 DW 取的，只存在你自己的设备上。

自动导入不改变这一点。红线写在这里，实现上也确实没有别的选择（因为根本没有后端）：

| 规则 | 说明 |
|---|---|
| **R-1 请求只能从用户设备发出** | 就是浏览器里的一次 `fetch()`：你的浏览器、你的 IP、直连 DW。**代码库里不得出现任何我们运营的中转/代理服务，也不引入公共 CORS 代理** —— 一旦有服务器代抓，就变成我们在复制和传输，性质完全不同。这是唯一的硬红线 |
| **R-2 不绕过任何付费墙或技术保护措施** | DW 没有 DRM，本来也不需要绕；这条对将来任何新来源都适用 |
| **R-3 抓取要礼貌** | 串行请求、间隔 ≥ 1s、**不提供「一键导入全部期次」** |
| **R-4 抓下来的内容性质不变** | 仍受版权、仍只存本地、永不进可分享包 |
| **R-5 代码可开源，内容零份** | 仓库、构建产物、测试固件里**不含任何一句 Manuskript 或一个音频文件**。测试用的德语句子全是自造的 |

**自动对齐的模型权重不属于内容。** 它是一份公开的声学模型二进制（q4f16 那份 187.6 MiB，int8 那份 302.6 MiB），
不是学习素材，所以不受 R-1 约束 —— 判断依据是**音频与文稿从不离开设备**，对齐全程在本机的
WASM/WebGPU 里跑。权重要么随打包版带上，要么首次使用时从 Hugging Face 取一次。

**不做任何分享功能。** 全量备份 `backup-*.json` 含正文，顶层带 `_warning` 提醒；
可分享包（`toShareablePackage`，V1 只有函数没有 UI）只含时间戳和挖空位置，不含任何正文，思路等同字幕轴文件。

---

## 五、开发

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run test:run
```

```bash
npm run build
```

推到 `main` 且 CI 通过后由 GitHub Actions 自动发布到 Cloudflare Workers。

图标与启动图（PWA 的 + 两套原生工程的）都是脚本画的，改了配色重新跑一次，产物入库：

```bash
npm run icons
```

图案（两点变音符 + 正弦波）的几何参数在 `scripts/generate-icons.mjs` 顶部的 `ART` 里，按 1024 设计稿坐标写；波的起伏数得保持奇数且 ≥ 5，理由见 [SPEC.md](SPEC.md) §7.10。

**原生 App 的名字按系统语言取**：中文系统「精听」，其余「Hörtraining」。改名字改这几处，`capacitor.config.ts` 里的 `appName` 不是其中之一（它只在建工程时用过一次）：

- iOS：`ios/App/App/{zh-Hans,de,en}.lproj/InfoPlist.strings`（新增语言还要动 `project.pbxproj`）
- Android：`android/app/src/main/res/values/strings.xml`（兜底）与 `values-zh/strings.xml`
- 网页版：`index.html` 的 `<title>` 与 `vite.config.ts` 里的 manifest —— 这两个**不能**按语言分设

### 原生打包（Capacitor）

iOS 和 Android 两套原生工程都在库里（`ios/` `android/`），壳里跑的是同一份 web 产物。
设计与六条实现约束见 [SPEC.md](SPEC.md) §7.10。

**出包不需要本机有 Mac 或 Android Studio，走 CI。**

iOS —— 推一个 `ios-v*` tag，`release-ios.yml` 会出 IPA 并自动上传 App Store Connect：

```bash
git tag ios-v0.1.0; git push origin ios-v0.1.0
```

上传成功不等于能装，中间还有三道（2026-09-01 首次发布实测）：

1. ASC 处理十几分钟，`processingState` 变 `VALID`。
2. 出口合规 —— `ios/App/App/Info.plist` 里有 `ITSAppUsesNonExemptEncryption=false`，
   自动过；没有这一项的话每个 build 都要手动答一遍加密问卷。
3. **必须先建内部测试组**（ASC → TestFlight → Internal Testing）并把自己加进去。
   **一个组都没有时 build 不会出现在任何人的 TestFlight App 里。**
   外部测试组第一次还要过一次 TestFlight 审核。

第一次跑之前要在仓库 Settings → Secrets 里配好九个签名相关的 secret，
清单和说明在 `.github/workflows/release-ios.yml` 头部。
**包不小**：IPA 381MB、iPhone 上装机 553.6MB（其中 490MB 是对齐权重），
超过蜂窝下载门槛，装的时候要 Wi-Fi。

**手机上对齐被系统杀掉时**：重开应用，顶部会有一条黄条说明上次死在哪一步、用的哪套后端 ——
这条信息来自边跑边落盘的黑匣子（`src/align/journal.ts`），设置页「对齐后端（FR-15 诊断）」里留最近几次。
下一次会自动换一档更保守的后端（`webgpu/q4f16` → `wasm/int8`）；两档都被杀过就停掉自动对齐，
这时正确的做法是在桌面上对齐 —— 句级时间戳属于标注层，会跟着备份同步回手机，跟读和听写照样能用。
设置页那个「清除记录」按钮同时也把降档恢复成第 1 档（换了设备或换了包之后用）。

Android —— 推一个 `android-v*` tag，`release-android.yml` 出一个签名 APK 放在 run 的 Artifacts 里，
下载直接侧载。**不上 Play Store**（单 APK 100MB 的限制带着 490MiB 权重必然超，而这是自用工具）。
需要四个 keystore 相关的 secret，生成命令在那个 workflow 头部。
**那份 keystore 自己也要备份** —— 换 keystore 等于换应用身份，已装的版本只能卸了重装，数据会没。

两条流水线都会先跑 `npm run stage:align`（带缓存）把 200MB 权重放进 `public/models/`，
所以装完第一次用就完全离线。手动 Run 时可以关掉那个开关，出一个只验壳的小包。

本机想看看原生工程（需要 Xcode / Android Studio）：

```bash
npm run cap:sync:ios
```

```bash
npm run cap:open:ios
```

`cap:sync:*` 里已经含了 `npm run build:native`（= `vite build --mode native`，
与线上版只差一件事：**不装 Service Worker**，理由见 SPEC §7.10 约束 2）。
只想单独把权重放进 `public/models/`：

```bash
npm run stage:align
```

（ORT 的 wasm 不用管 —— 它走 Vite 的 `?url`，构建时自动进 `dist/assets/`。）

### 已知的坑（都在代码注释里，这里只列个索引）

- 全程复用同一个 `<audio>` 元素（iOS 手势链约束）。任何地方都不要 `new Audio()`。
- HTML → 纯文本转换必须同步维护 offset 映射，否则 Glossar 候选词会**静默错位**。见 `src/sources/dw/htmlToText.ts`。
- 排序去重用 `firstPublicationDate` 而不是 `pubDate` —— DW 在把 2019 年的旧期以当周日期重推。
- 改 Lesson 一律走 `useLessonStore.patchLesson`，不要拿组件闭包里的 lesson 直接 save ——
  同一帧里连来两次修改时，后一次会拿着旧快照把前一次静默抹掉。
- iOS 的静音开关会让 `<audio>` 没声音。如果「点了没反应」，先看看侧边那个拨杆。
  **原生版没有这个问题** —— `AppDelegate` 把音频会话设成了 `.playback`。
- **Web Audio API 在 Web Worker 里不存在。** 对齐必须在 Worker 里跑（否则界面冻住几分钟），
  所以解码只能留在主线程，波形再 transfer 进去。见 `src/align/decode.ts`。
- **主线程不要 import `src/align/runtime.ts` 或 `emissions.ts`。** 它们连着 transformers.js +
  onnxruntime-web，一 import 主包就从 497KB 涨到 1MB。纯配置在 `src/align/config.ts`。
- transformers.js **默认从 jsdelivr CDN 拉 ORT 的 wasm**，不覆盖 `wasmPaths` 断网就起不来。
  见 `src/align/runtime.ts`。
- Cloudflare 的 SPA fallback 会给缺失路径返回 **200 + index.html**，所以探测「本地有没有模型」
  不能只看 `res.ok` —— 要 GET 那份 `config.json` 并真的 parse 一遍（原生壳里 HEAD 和响应头都不保证）。
- **`a[download]` 在 WKWebView 里不存在**，点下去什么都不会发生、也不报错。所有「存个文件给用户」
  都必须走 `src/lib/download.ts`，不要在组件里自己 `a.click()`。
- **原生壳里判平台只从 `src/platform/native.ts` 拿**，那里的函数是 async 的 ——
  `@capacitor/core` 静态 import 会进首屏包（498KB → 509KB）。
- **iOS 的 WKWebView 现在是有 WebGPU 的**（2026-09-01 真机实测：设置页诊断显示 `webgpu / q4f16`，
  加载的是那份 187.6 MiB 权重）。之前 README 写「一定是单线程 WASM + int8」是猜的，猜错了。
  `SharedArrayBuffer` 仍然拿不到（没有 COOP/COEP 头），所以 WASM 那一档确实是单线程。
- **权重不要一次性整取。** Capacitor 的 iOS scheme handler 对非媒体扩展名走 `Data(contentsOf:)`，
  把整份 187MB 读进原生进程的堆；transformers.js 那边还会**再把它抄一份进 Cache API**。
  加上 JS 缓冲和 ORT 自己的拷贝，峰值接近 1GB —— 实测表现是进度条走到
  「181 MB / 187.6 MB」之后**整个应用被系统杀掉**，没有任何报错。
  修法在 `src/align/rangedFetch.ts`：冒充缓存命中、按 8MB 分片取（Capacitor 的 Range 分支走
  `FileHandle.seek`），并关掉那次无谓的缓存回写。
- **判断服务端支不支持 Range，不能只看状态码 206。** Vite 的 dev server 会回
  `206 + Content-Range: bytes 0-196703175/196703176` —— 认状态码就会让每个分片都拖回整份文件。
  要比对「回来的区间是不是真的就是我要的那一个字节」。
- **进程被系统杀掉时 JS 跑不了任何收尾代码**，所以对齐的每个阶段都同步写一条 localStorage
  面包屑（`src/align/journal.ts`）。下次启动看到「上次那条记录还是 running」就等于「上次是被杀的」，
  设置页「对齐后端」里能看到最近几次的阶段、字节、后端与耗时。
