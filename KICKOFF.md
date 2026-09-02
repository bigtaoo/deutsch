# 新会话开工提示

> 复制下面整段，粘贴到新会话即可开工。

---

项目：德语精听训练器（个人自用工具，工作目录 D:\deutsch）

**先读 SPEC.md，再读 README.md。** 需求文档已定稿，包含完整的功能需求、数据模型、技术决策、风险表和验收清单。
附录 A 是 DW 接口的实测结果（A.6 是实现完成后用真实期次做的复验），附录 B 是 GitHub API 的实测结果——
这些是真实探测出来的事实，不要重新假设，也不用重新验证（除非怀疑对方改版了）。

## 现状（2026-09-02）

**§9 实现顺序的 11 步已全部完成**，`main` 上可跑、可构建、**447 个前端测试通过**
（`server/` 那套 27 个另算，见下面同步那一节；其中 `src/pages/ReviewPage.test.tsx` 是第一个**组件**测试 ——
复习页的时序行为只有把纯函数装起来才测得到）。

已经用真实的 Alltagsdeutsch 期次 `45334084` 端到端跑通：RSS → 页面 `__APOLLO_STATE__` → mp3 下载 →
切句（45 句；当时开头 3 句被当 teaser 自动排掉了，现在不排了，见变更 24）→ 14 条 Glossar 候选词**全部落位正确** → 打点 → 接受候选词 →
听写判级 → FSRS 复习。详见 SPEC.md 附录 A.6。

**FR-15 自动对齐已完成**（在 §9 的 11 步之外新增，见 SPEC.md §0 第 17 条、FR-15、§7.9）：
浏览器内跑 CTC 强制对齐（MMS-FA + 自己实现的 Viterbi），从「已切好的句子 + 音频」直接算出
句级与词级时间戳。已在同一期真实素材上验过：45 秒写入 38 句 + 744 个词级时间戳，
标出 5 句待校对，词级边界抽查合理。代码在 `src/align/`。

**FR-16 内置词典 + FR-17 预置词库 + FR-13.12 回填最近几期已完成**（2026-09-02，见 SPEC.md
§0 第 23 条、FR-16、FR-17、§7.11）。解决的是「笔记还不多时怎么练」：

- **词典随包带**，`npm run build:dict` 从 WikDict + 一份口语词频表编译出 15.3 万词条 +
  30 万条词形索引 + 1.7 万预置词，产物 35 MB、切 256 个桶（查一个词只解析约 105KB）。
  **产物入库、1GB 的源文件不入库** —— 换来 CI 完全不必碰它。
- 顺手修掉了 FR-9.3 记着的那条已知局限：去重从 surface 升级到**词元**，
  `laufen` 与 `gelaufen` 现在归到同一个键。这是词形索引的免费副产品。
- **预置卡的正面只有声音、没有文字**（FR-17.7）。给了文字它就变成「看词回忆意思」，
  而这个应用存在的理由是听觉识别。声音优先用 Wiktionary 的真人录音（加词时就预取，
  所以断网也能复习），没有的退 TTS，卡面标出是哪一种。
- **档位是口语词频名次，不是 CEFR 等级**，界面上也这么写。原因见 FR-17.2：
  官方 Goethe 词表只有 A1/A2/B1 且有版权，B2/C1/C2 压根没有官方表。
- **FR-13.12 回填**是另一半：预置词库的孤立词发音练不到连读，旧刊的 Glossar 才是
  带真语料的那一批。R-3 没有被绕过 —— 它禁的是「一键导入全部 100 期」那个形状，
  实现里有硬上限、没有「全部」、只取已拉到的 RSS 列表、复用 `politely()`。

**复习形式改成「听音四选一」，评分改成系统自动算**（2026-09-02，SPEC §0 变更 29，
FR-10.2/10.3/10.4 重写 + 新增 FR-10.8–10.11、FR-16.8/16.9、FR-17.3/17.4 重写）。

上一批（变更 23）落地时复习页是照 FR-10 原文做的 **Anki 形状**（显示答案 + 四档自评）——
而「百词斩形式」这个结论那次**只在对话里说过、没写进 SPEC**，所以实现时按原文做了。
这次先改文档再改代码。改掉的三件事：

- **正面只有声音**，进页面自动播一次、点大圆按钮重播，不给任何文字（连课程卡的挖空原句也不给：
  给了文字就能靠语法猜出来，那就不是听力题了）。2×2 选项 + 一个「没听清 / 不认识」。
  答对 → 顶部闪 600ms 的 `✓ der Vorhang` → 自动下一张；答错才亮正确项和完整卡背。
- **评分不问用户**（`src/srs/grade.ts`）：选错/不认识 → Again，答对 ≥4s → Hard，
  <4s → Good，<1.5s 且这张卡历史无错 → Easy。「忘了/勉强/记得/太简单」连同间隔预览一起删了。
  **Easy 那个「历史无错」的条件不能去掉** —— 四选一有 25% 瞎猜命中率，只看用时的话
  乱点正好点对会被判成 Easy，一次幸运能把不会的卡推到一个月以后。
- **预置词库从「加 10/25/50 个词」改成「报名一整档」**，卡片由复习页按 `newPerDay` 每天惰性激活。
  报名只写一条设置（`enrolledBands`），**不新增 store、不动 DB_VERSION** ——
  「哪些还没学」= 档内词表减去生词本已有词，是纯派生量。整档 3000 个词一次建卡要 60 次
  MediaWiki 往返和 100MB 以上录音，那条路走不通。**与变更 28（设置也同步）合起来白拿一个好处**：
  报名跟着设置同步，桌面上报名、手机上就开始发卡，而「发到第几个」不需要同步 ——
  它从生词本推出来，而生词本本来就同步。

配套的两处词典改动（都在 `npm run build:dict` 里，**产物已重新生成入库，35.0 → 38.6 MiB**）：

- **FR-16.9 例句**：WikDict 没有例句表，所以这是这条管线第一次需要**第五个数据源** ——
  de.wiktionary 正文的 `{{Beispiele}}` 段，走 API 按 50 个标题一批、347 批抓完，
  原始 wikitext 缓存在 `.cache/dict/beispiele.json`（缓存清洗前的原文，调规则不必重抓）。
  实测 **16499/17313（95%）** 有可用例句。选句规则：无 `<ref>` 引注优先、15–140 字符、取最短两条。
- **FR-16.8 干扰项**：每个牌组词预存最多 6 个 IPA 最近邻。**第一版按「档内找」，实测被推翻**：
  第 4 档只有 30% 的词凑得到三个邻居 —— 3000 词里没有足够多的最小音对。放开到全牌组
  1.7 万词之后 **81% 够三个**（`heilen → heulen / teilen / weilen / eilen`）。
  那条限制本来就立不住：用户不知道选项属于哪一档，辨形题问的是「你听到的是哪个词」。

**验到哪一步了**：447 个前端测试 + typecheck + `npm run build` 全过，**并且在桌面浏览器上
按 430px 宽点过一轮真流程** —— 报名第 4 档（3000 词）只建 10 张卡、10 个全拿到真人录音、
面板显示「已激活 10 / 剩余 2990」；四个选项是 `vorab / Vorrang / Vorhang / Vorgang`
这类真音近词；答对闪「✓ der Vorhang 下次 6 分钟后」并自动跳；答错（`liegen` / `wiegen` 那对）
亮出正确项 + IPA + 释义 + 两条例句。**剩下的是 iPhone 真机**（见「下一步建议」第 0 条）。

那一轮还顺手改掉两处只有真尺寸下才看得见的问题（提交 `fix: 复习页选项列数按题型分…`）：
430px 下四个选项本来是单列（`sm:grid-cols-2` 要 640px 才生效），现在辨形题恒 2×2、
辨义题窄屏单列；卡面改成撑满剩余高度并居中，否则播放键和底部选项之间空掉半屏。

**这批与同步那批是同一天并行的两摊活**，合并时撞了三处：变更表编号（我这条改成 29）、
`ReviewPage.tsx` 里的 `backupVocabNow` → `syncVocabNow`、以及 `Settings` 接口两边各加了字段。
**在 worktree 里做界面改动验不了 UI**：`preview_start` 的 cwd 钉在 `D:\deutsch`，
在那里起出来的 dev server 服务的是共享检出的代码（判据：去取一个只存在于 worktree 的文件，
回来的是 SPA fallback 的 HTML）。所以那阶段的替代手段是组件测试（`ReviewPage.test.tsx` 就是为此写的），
真界面等合并回 `main` 之后才验得了。

**词典/预置词库那三样都只在浏览器里验过**（真人录音抽 10 个词 10/10 命中、178KB；查词/词形还原/
署名那一屏都看过），**没有在 iPhone 上验过**。iOS 上有一处已知会退化：覆盖率最高的
`De-*.ogg` 是 Ogg Vorbis，WKWebView 放不了 —— 代码会挑 Lingua Libre 的 wav，
挑不到就退 TTS。真机上真实的真人音比例只能等设备回答。

**FR-13.7 那条自动排除被实测推翻，通听改成逐词高亮（2026-09-02，SPEC §0 变更 24）**：

- **DW 的标题和导语在音频里是被念出来的**（Alltagsdeutsch 45334084，一字不差），
  而附录 A.3 一直写着「音频里不朗读」，于是导入时开头 3 句被整块排掉。
  这不是「少练三句」的问题：排除句不进对齐目标（`target.ts` 的第一条硬规则），
  开头几十秒真实存在的声音因此无处安放，只能被挤给第一句正文。
  **自动导入现在一句都不排除**，`teaserBlock` 判定与 `excludeTeaserBlock` 已删除。
  「切句」页多了「开头 N 句 → 恢复 / 排除」这个批量控件 —— **旧课里已经排掉的那几句，
  点一次「恢复」再点页头「重新对齐」就回来了**（这是这个控件存在的主要理由）。
- **通听改成逐词高亮**（`src/lesson/karaoke.ts` + 重写的 `ListenTab.tsx`）：
  当前句浅底、正在读的那个词加深底，当前行自动滚到视野中间（滚一下滚轮就停止跟随），
  **点任意一个词从那里开始播**。数据是 FR-15 一直在算、却只有听写在用的那份词级时间戳
  （一课约 800 条），零额外代价。
  两个坑记着：① 渲染单位必须用 `tokens.ts` 的 tokenize（与挖空同坐标），
  不能用词级时间戳自己那套罗马化词 —— 否则 `Work-and-Travel` 碎成三块各自闪、
  数字和引号整个消失；② FR-5.2 的「不做伪同步」没有让步：只有**两侧都有真时间戳**时
  才把中间被罗马化丢掉的数字补上（`bridged`），一句词级时间戳全缺时宁可只做句级高亮。

**分层标准换了（2026-09-02，SPEC §0 变更 27）—— 这条会影响以后每一个新字段的归属**：

> 缓存层**只装音频和原始文稿**，其余一切都备份且同步。那两样的凭据不是「可重建」，
> 而是**标注层记着它们的下载地址**（`Lesson.audioSrc` = mp3 直链，`source.sourceUrl` = 文稿页面）。
> 新字段该放哪层，先答一个事实问题：**它有地址吗？** 答不出就放标注层。

据此这一批搬了两样：`LessonCache.glossary` → `Lesson.glossary`（候选词「还没接受哪些」是跨设备的待办），
以及新增 `Lesson.audioSrc`。FR-3.5 补齐时优先用页面上新抓到的直链（CDN 地址会变），
页面里没有就退到记着的那个（页面也可能改版下架）。
**候选词这一份写了迁移**（`src/db/migrate.ts`，启动读库时跑一次，幂等，搬完排一次同步）——
词级时间戳那次没写是因为「重新对齐」能拿回来，而候选词只有「重抓页面」一条路，
且它带着待办，不该静默消失。手工重切那条路上也要搬（`carryGlossary`）。
**设置也同步了**（2026-09-02，SPEC §0 变更 28）：新增 `settings` 文档 + `Settings.updatedAt` +
`mergeSettings`（整体 last-write-wins）+ 5s 去抖 + 恢复时一并拉回。原来「跟机器走」那个理由站不住 ——
真正跟机器走的是「这台设备跑不动对齐」，而它记在黑匣子（localStorage）里、与 `autoAlignOnImport` 无关，
所以手机把那个开关同步成 true 也照样自己停（FR-15.10）。
**顺带补了一个缺口**：备份文件里一直带着 `settings`，而导入这条路从来不读它 ——
「换设备恢复」以前会把设置默默留在默认值上。

**词级时间戳搬进了标注层（2026-09-02，SPEC §0 变更 26）**：
`LessonCache.wordTimings` → `Sentence.words`（新类型 `WordSpan`）。
起因是用户那句「所有用户的信息都是需要备份的」—— 原来的分层判断用的是
「有音频+文稿就能重算」，但那句话漏了「**在哪台设备上**」：手机跑不动对齐模型，
在那台设备上它压根重建不出来，于是「桌面预处理、手机学习」只兑现了一半。
备份/同步/合并/导出**一行没改**（它跟着 `Lesson` 走，同步又是按课分片的）。
存进句子而不是整课一个数组，是因为它和 `blanks` 同为句内 offset ——
合并、拆分、重新切句三处都要跟着平移/分家/搬迁，**漏一处就是静默错位**（三处都补了）。
老库里那份 `wordTimings` 不迁移：缓存层可以随时丢，而开头三句不再排除之后
每一课本来就要重新对齐一次，重跑就写满了。

**手工标注已整节删除（2026-09-01，SPEC §0 变更 20）**：「标注」tab 连同 `Enter` 打点、
±0.1s 微调、清除时间戳一起去掉了。时间戳只有一个来源 —— 音频一到位（DW 导入、手动导入、
补齐素材、重新绑定音频）就排队自动对齐，**不阻塞导入**，进度常驻在应用底部那条
`AlignBar`（`src/components/AlignBar.tsx` + `src/state/useAlignStore.ts`）。
课程页头部的 `AlignStatus` 显示「已对齐 N / M 句 + 低置信句数」并给「重新对齐」。
FR-4 只剩 FR-4.4（区间推断规则）。老数据里手打过的点不会被重跑覆盖。

**同一批做的还有 FR-15.9~15.12（都是为了让手机上跑得完）**：
`src/align/journal.ts` 黑匣子（每阶段同步写 localStorage，进程被系统杀掉后下次启动能自报现场）、
后端阶梯 + 崩溃降档（`webgpu/q4f16` → `wasm/q4`，两档都崩过就停掉自动对齐）、
`src/align/rangedFetch.ts` 按 8MB 分片取随包权重并关掉 transformers.js 的缓存回写。
起因是一次真机事故，见下面「iOS 上那次崩溃」。

**FR-15 的两个 bug（2026-09-02 实测查出来并修掉，SPEC §0 变更 21/22）**：

- **第 2 档以前是必死的。** `wasm/int8`（302.6 MiB）在 WASM 上**加载即让进程被系统杀掉**，
  桌面 32GB 的 Chrome 也一样，JS 侧一行报错都没有 —— 也就是说「没有 WebGPU 的浏览器」
  以前根本跑不了自动对齐，不是文档写的「慢一个量级」。换成 `wasm/q4`（230.3 MiB）后跑得通
  （25 秒音频 36 秒，约 1.4× 实时）。随包权重 490.2 → **417.9 MiB**。
  连带补上降档的漏洞：Worker 被杀而主线程还活着时以前记成 `error`、不进 `crashed` 计数，
  于是 `nextPlanStep()` 压根不降档，同一档被**无限重试**。现在那一类记 `crashed`。
- **滑窗漂移。** 一课自动对齐后 31/45 句被标低置信，查下来不是阈值问题：同一份 emissions，
  滑窗跑出中位数 −2.99、整段对齐跑出 −1.17。逐窗漂移 −1052 → +684 帧，15 窗里有 3 窗喂进去的
  token 装不进窗口，最后把 904 个字符挤进 19.7 秒（45~53 字符/秒，物理上念不出来）。
  根因是窗口只有 30 秒，**比 Alltagsdeutsch 的长句（实测 437/475/625 字符）还短**，
  而窗内 token 数只能靠全局平均速率估。改成 **120 秒**，三课实测与整段对齐在「最差单句」上
  完全持平，代价只有回溯缓冲 0.7MB → 11MB（整段要 143~387MB）。

**同时切出一道缝**（FR-15.13，`src/align/emissionMatrix.ts`）：帧级 log-prob 矩阵现在是一个
自足、可序列化、不带任何运行时依赖的中间产物。`音频 → 矩阵` 那一半要 300M 权重 + GPU
（全部的时间和内存都在那儿）且**压根不看文稿**；`矩阵 + 文稿 → 时间戳` 那一半是纯 JS、几秒。
所以前一半可以整块换地方跑（原生插件 / 远端）而后一半一行不改，且远端那条路上
**德语正文一个字都不出设备**。Worker 现在收两种入口（`input: 'audio' | 'emissions'`）。

**§7.10 原生壳已接入**（Capacitor 8，iOS + Android 两套工程入库）：
壳里跑同一份 `npm run build:native` 产物，业务代码只多了一个 `src/platform/native.ts`
加一处原生代码（`AppDelegate.swift` 把 `AVAudioSession` 设成 `.playback`，顺手修掉了
「iOS 静音开关让 `<audio>` 没声音」那条老坑）。对齐权重随包带（实测 490.2 MiB）。
出包走 CI：推 `ios-v*` tag → 出 IPA 并自动上传 App Store Connect；推 `android-v*` tag → 出签名 APK。
（权重后来降到 417.9 MiB，见上面 FR-15 那两个 bug。）

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

**2026-09-02 的坏消息：那次修复不足以让 iPhone 跑得动。** 他的 iPhone 13 上黑匣子记下来的是
**两档都在「加载对齐模型」这一步被系统杀掉**（第一次 `webgpu/q4f16`、降档后 `wasm/int8`，
各约 1 秒）。而 `q4f16`（187.6 MiB）已经是这个模型**最小的一个变体**
（其余 212 / 230 / 302 / 602 / 1204 MiB），**所以降档在手机上救不了** ——
WebView 的 WebContent 进程 jetsam 线远低于原生进程，而 ORT-web 至少要 JS 堆一份 + wasm 堆/GPU 一份。
应用现在的兜底行为是对的（两档都崩过就停掉自动对齐，并说「去桌面对齐，句级时间戳会跟着备份回来」）。
真要在手机上跑，只有两条路，**那道缝（FR-15.13）就是为它们准备的**：
① 换一个小一个数量级的模型（HF 上没有现成的小体积德语 CTC ONNX，得自己 `optimum-cli` 导，
例如从 `facebook/wav2vec2-base-10k-voxpopuli-ft-de` 出发，95M 参数 q4f16 约 60 MiB）；
② 把 emissions 那一半挪出 WebView（Capacitor 插件走 onnxruntime-objc / CoreML，
原生能 `mmap` 那份 .onnx，峰值从「约 3 倍模型体积」掉到「约 1 倍」）。
**服务器那条已经评估过并否掉了** —— 不是因为违反 R-1（R-1 管获取通路，mp3 仍是浏览器直连抓的），
而是 CC-BY-NC + Cloudflare Workers 跑不了（得上 VPS，那笔永久部署依赖）。
要做的话正确切法是「只上行 mp3、只下行矩阵」。
**2026-09-02 补充：这条否决理由的一半已经没了** —— 同步后端就在那台 VPS 上，
「永久部署依赖」这笔账已经付过。剩下的理由还站得住，但换了性质：现在的问题是
**上行 mp3 就等于让服务器经手音频**，那是 R-1 真正在管的东西（SPEC §3.1.1 里
「同步后端与 R-1 的关系」那段专门划了这条线：存你自己的东西可以，代你去拿内容不行；
而上行 mp3 落在两者中间，要单独论证）。加上 7.9GB 内存里 mssql 已经占了一大块，
一个 CTC 模型常驻不进去。

**一条教训**：GitHub Actions Secret 只写不可读，`funny` 那套签名数值就是这么丢的
（流水线好使、TestFlight 上过线，但值找不回来，只能整套重签）。
**流程有文档 ≠ 数值有存档**，两件事要分开保管。

**大窟窿一（2026-09-02 换了形状，不是补上了）：备份链路从来没端到端跑通过。**

原来的窟窿是「GitHub 备份没用真实 PAT 联调过」。用户 2026-09-02 说「GitHub 那套感觉还是麻烦」，
于是整条路换成**自建后端 + Google 登录**：`src/github/` 九个文件 + 配对二维码 + `jsqr`/`qrcode`
两个依赖全部删除，换成 `server/`（Node + Hono + SQLite，跑在 `wnet-server` 那台 VPS 上）
和 `src/sync/`。合并规则、离线队列、状态常驻可见、手动导出四样一字未改（SPEC §0 变更 25）。

**已经跑通的**：容器在 VPS 上起来了（`~/deutsch-sync`，`docker compose ps` 可见），
`/v1/healthz` 从 Caddy 容器里能通，拿一张伪造 ID token 去登录会被 Google 的 JWKS 挡成 401
（也就是说出网验签这条路是活的）。服务端 27 个测试、前端 21 个同步测试全绿。

**当天下午全部接通了**：DNS（灰云 A 记录）、Google 的 Web + iOS 两个客户端、白名单
`tao.wang.go@gmail.com`、Caddy 的 site block，证书已从正式 Let's Encrypt 签下。
`https://sync.gamestao.com/v1/healthz` 通、无令牌访问回 401、CORS 只放行 `d.gamestao.com`。
**前后端也都进了 CI**：push main → CI 绿 → `deploy` 发 Cloudflare、`deploy-server` 发 VPS，
两个 job 首次跑通（10s / 44s），线上主包里能 grep 到注入的客户端 ID。

**唯一还没做的是「真的用 Google 登录跑一遍」以及 §10 那串验收（含恢复演练）** ——
那需要在弹窗里输密码，只能由用户做。步骤、排错、验收清单全在 **`deploy/README.md`**。

Android 那个 OAuth 客户端**还没建**：`android-v*` 流水线一次没推过、签名 keystore
还不存在（本机也没 JDK 算 SHA-1）。等真要出 Android 包时再建，那个 ID 不进代码。

**应用壳自动更新（2026-09-02，SPEC §0 变更 30）**：起因是他说「浏览器刷新后没有谷歌登录」。
**线上两边都是最新的** —— CI 绿、`deploy` 与 `deploy-server` 两个 job 都成功、
Variables 三个构建期变量都在、线上主包里 grep 得到 Web 客户端 ID 和「用 Google 登录」、
`sync.gamestao.com/v1/healthz` 回 `{"ok":true,"users":0,"docs":0}`。
在干净会话的浏览器里打开 `#/settings`，登录按钮正常显示。**问题在客户端缓存**：
§7.6 的 `navigateFallback: '/index.html'` 让导航请求由 Service Worker 从预缓存直出，
所以 deploy 之后那一次刷新拿到的**必然**是旧 SW 手里的旧 index.html，要刷第二次才吃到新壳。
**这个症状与「没部署成功」长得一模一样**，这次是把 CI、Variables、线上产物全查一遍才排除掉的。
修法见 `src/platform/pwa.ts`：注册从插件注入的 `registerSW.js` 换成虚拟模块 `virtual:pwa-register`
（`autoUpdate` 下它监听新 SW 的 `activated`+`isUpdate` 自己 reload），另加每小时 / 回前台 / 刚联网三处探测，
以及唯一自己写的那点逻辑「不在打字的当口刷」。原生构建同时从「不加载这个插件」改成 `disable: native`。
**在 `npm run preview` 上实测过两条路**：空闲时来更新 → 3 秒内自己 reload（`navigation.type === "reload"`、
`sessionStorage` 标记存活，证明是同一个标签页）；光标在输入框里时 → 新 SW 已 activated 但 3.5 秒后不刷，
`blur()` 之后立刻刷且保留 hash 路由。原生产物主 chunk 哈希与改动前完全一致，那段代码被整块摇掉。
**注意一个一次性的坎**：这个修复本身要靠一次部署才上线，而浏览器里缓存的是**没有**它的那一版 ——
所以还得手动刷最后一次（或 Ctrl+Shift+R）拿到带自动更新的构建，**从那之后**才是自动的。
`.claude/launch.json` 因此加了个 `preview` 配置：`vite dev` 下 `devOptions.enabled: false`，
SW 压根不装，这类行为只能在 preview 上验。

**iOS 0.2.0 已上传 TestFlight（2026-09-02，run 33661964392）**：6m51s，`UPLOAD SUCCEEDED`，
构建号 4，IPA 400MB。距 `ios-v0.1.1` 隔 22 个提交、五摊活（新图标与按系统语言分设的 App 名、
内置词典 + 预置词库、四选一复习、同步换自建后端 + Google 登录、逐词高亮与分层标准）。
**这是第一个带同步的 iOS 包**，也是第一个带新图标和本地化 App 名的包。
**第一次 archive 挂了**（exit 65）：命令行上的 `PROVISIONING_PROFILE_SPECIFIER` 会套到每一个
target，包括 Google 登录插件带进来的那一大片 SPM 包，而它们不支持描述文件。修法与形状写在
SPEC §7.10 与 `.github/workflows/release-ios.yml` 的 archive 步注释里。
**重跑走的是 `workflow_dispatch`（`--ref main`）而不是新 tag** —— `ios-v0.2.0` 那个 tag 打在了
修复之前的提交上，**它现在指向一个建不出来的版本**，还没处理（要删远端 tag，等他定）。
上传成功之后还有两道不在 CI 里：ASC 处理十几分钟转 `VALID`（出口合规自动过），
以及内部测试组必须存在（0.1.0 那次已建，这次不用再建）。

## 下一步建议（按价值排序）

0. **新复习流程还差 iPhone 真机那一关**（桌面浏览器已经点过一轮，见上面）。三件事只有真机能答：
   ① **iOS 的自动播放手势链** —— 新交互是「点选项即判分」，与原来的「点显示答案」不同，
   而 §3.2 那条约束（只有用户手势链上的 `<audio>` 能开始播放）在新流程下要重测：
   自动播那一次仍然可能被拒，此时必须还能点大圆按钮救回来。
   ② **2×2 在 375px 的真机上按起来顺不顺手**（桌面按 430px 量过，2×2 落在拇指区、
   答错态不用滚动；375px 与真手指还没验），以及辨义题的释义在那个宽度下读不读得下去。
   ③ **报名第 4 档之后连着用三天**，确认每天真的只发 `newPerDay` 张、且课上标的词占额度。
   （单测覆盖了这条规则，但「跨天」这件事只有真的过一夜才算验过。）
1. **真的用 Google 登录跑一遍，然后走完 §10 里标 ❌ 的那一串**，尤其是**恢复演练** ——
   文档里写了「不做完不算验收通过」。链路本身已经全部接通（DNS、两个客户端 ID、Caddy、CI，
   见上面「大窟窿一」），**三件配置都不用做了**；剩下的只有登录这一下和跨设备恢复，
   而登录要在弹窗里输密码，只能他做。判据很直接：`sync.gamestao.com/v1/healthz` 现在还是
   `users:0`，登录成功它就不是 0 了。排错与验收清单在 `deploy/README.md`。
   附录 B.2 那三个 GitHub 待确认项**不用填了**，它们随 PAT 一起作废。
2. **实际用两周**，然后再回来改。§10 里标 🧪 的几条（跟读循环、多区间挖空）代码路径有测试，
   但没有人真的连着跟读过十分钟，手感问题只有用出来。
3. **在真机上跑一课，然后读「设置 → 对齐后端」。包已经出好了**：**0.2.0 构建号 4** →
   run 33661964392，6m51s，`UPLOAD SUCCEEDED`，IPA 400MB。
   （这个包**带上了**新图标、本地化 App 名、词典、四选一复习和同步 —— 0.1.1 那个包
   一样都没有。所以真机上要确认的事这一次是一批，不是一件。）
   这是那次崩溃修复的唯一验收：
   诊断页那一行写「分片取权重」= 修复生效；万一还是被杀，顶部黄条会说死在哪一步、哪套后端、
   多少字节 —— 这次不会再是黑箱。本机没有 Mac，所以只能靠设备自己回答。
   同一次装机还要确认另外两件：① 导出备份能不能落到「文件」App；
   ② 顶部安全区在真机刘海下对不对；顺便记一下真机上一课实际跑多久。
   **桌面壳（Electron）仍未做，也不急** —— 桌面就是浏览器。
4. **手机端自动对齐要么换小模型、要么走原生插件 —— 这是 FR-15 剩下的唯一大件。**
   iPhone 13 两档都被杀，降档救不了（见上面「iOS 上那次崩溃」的 2026-09-02 补充）。
   缝已经切好（`src/align/emissionMatrix.ts`），两条路都从那儿接，且**两条路的下游完全一样**，
   所以先做哪条都不浪费。我倾向先试换模型：它同时解决手机和 WASM 兜底两头，
   改的是配置（`config.ts` 顶部写了换法：modelId / vocabSize / blankId + romanize 退化成恒等）
   而不是架构。**换模型之后 `REVIEW_MARGIN` 必须重标一次** —— 整条置信度分布会整体平移。
5. **砍权重 —— 优先级已经降到第 4 步之后。** `pickPlan()` 两条路只走一条，
   原生壳只在一种 WebView 里跑，另一份是纯死重（现在两份共 417.9 MiB）。已知 iOS 走 `q4f16`，
   所以该砍的是第 2 档那份（`q4` 230.3 MiB），装机能降到约 250MB。
   **但在第 4 步落地之前，这是在给一个手机上跑不起来的功能省体积** —— 顺序不要颠倒。
6. **在 iPhone 上确认预置卡到底有没有真人音**（见上）。设置页「词典」那一节会显示发音缓存
   条数与体积，以及系统有没有德语嗓音 —— 如果真机上几乎全是合成音，那就说明
   Lingua Libre 的 wav 覆盖率不够，届时要么接受合成音，要么在构建期把 ogg 转码
   （但那要引入 ffmpeg，与 §7.6「不为一次性构建产物装依赖」冲突，得单独权衡）。
7. Q7：存档列表页 `/de/alltagsdeutsch/s-9214` 是否也在 `__APOLLO_STATE__` 里给出完整的 400+ 期列表。
   若给了，L1 就能覆盖全部存档，大约 10 分钟的增量。

明确不要做（文档里已经论证过，不要重开讨论）：

- ~~不建任何后端、代理或本地 helper 进程~~ —— **2026-09-02 部分作废**：同步后端建了（`server/`）。
  R-1 管的是**内容获取通路**，抓 DW 仍然只从设备直连、无代理；同步后端在通路下游，
  只存用户自己那份私人复制。这条界线写进了 SPEC §3.1.1 的「同步后端与 R-1 的关系」。
  **仍然不做的是：代抓内容的代理、公共 CORS 代理、本地 helper 进程。**
- ~~不做 GitHub OAuth 登录~~ —— 整条 GitHub 路已删（SPEC §0 变更 25）。登录改用 Google，
  验签在自己的后端做，附录 B.1 那条「纯前端拿不到 token」的限制不再相关
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
- **同步后端第一次起来会报 `ERR_SQLITE_ERROR: unable to open database file`**：`./data` 是 docker
  头一次挂载时建的，属 root，而容器里跑的是非 root 用户。这台机器上 `sudo` 要密码，
  所以借一个 root 容器改属主：`docker run --rm -v "$PWD/data:/data" busybox chown -R 1001:1001 /data`。
  compose 里的 `user: "${SYNC_UID}:${SYNC_GID}"` 从同目录 `.env` 插值
- **`sync.gamestao.com` 的 DNS 必须是灰云（仅 DNS）**。橙云代理下 Caddy 拿不到 ACME 挑战，
  证书永远签不下来，症状是浏览器报 SSL 错而服务器日志里只有重试
- **「deploy 之后刷新还是旧版」不是部署失败**，是 Service Worker 从预缓存直出导航请求
  （`navigateFallback`），第一次刷新拿到的必然是旧壳。查这类症状**先看线上产物**
  （`curl` 拿 index.html 里那个 `index-*.js` 再 grep 里面的字符串），不要先怀疑 CI。
  变更 30 之后这件事自动了，但**原生壳与任何关掉 SW 的构建上这条推理仍然有效**
- **验 Service Worker 的行为只能用 `npm run preview`**：`vite dev` 下 `devOptions.enabled: false`，
  SW 压根不装。`.claude/launch.json` 里有个 `preview` 配置就是为此
- **Google 的 `webClientId` 在 Android 上填的也是 Web 那个客户端 ID**，不是 Android 客户端 ID。
  Android 客户端只在 Google 控制台登记（包名 + 签名 SHA-1），不进代码；填错的报错是
  `[28444] Developer console is not set up correctly`
- **仓库根 vitest 要排掉 `server/**` 和 `.claude/**`**：前者在 jsdom 里跑会让 jose 不认
  jsdom 的 `Uint8Array`（报密钥类型错），后者是 git worktree，会把同一批测试跑第二遍
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
  按感觉写的 -0.6 会把 37/38 句全标黄。**而且标定之前先确认产生这条分布的代码是对的** ——
  那次量到的「最差 -3.50」其实是滑窗漂移的症状，却被当成素材的性质写进了标定注释；
  窗口修好后分布收窄，那个 0.8 的余量就够不着尾巴了（三课报 4/0/0），只好重标为 0.5。
  找 bug 的判据要用**物理上不可能的量**：这次指认出问题的不是置信度，是「一句 45~53 字符/秒」
  （德语朗读实测 12~15 字符/秒）
- **别拿 `int8` 当 WASM 的兜底**（302.6 MiB，加载即被杀，桌面 32GB 也一样）。门槛就是体积：
  ORT 的 wasm 堆里同时有三份左右（JS 缓冲 + protobuf 解析 + 权重张量），230MB 过得去、300MB 过不去。
  4-bit 那两份都跑得通（q4 230.3 / bnb4 212.2 MiB）
- **滑窗的窗口必须装得下最长的那句话还有余。** 窗内 token 数只能靠全局平均速率估，
  窗口一短，估计误差就与「一整句」同量级，而滑窗单调不回退于是一路累积。
  这条不变量钉在 `windowed.test.ts` 里（`LONGEST_SENTENCE_CHARS` / `SLOWEST_CHARS_PER_SECOND`）。
  **这个失败造不出可信的单测** —— 试过合成矩阵，匀速漂 0、加速率摆动仍漂 0（合成后验太确定），
  把正确 token 概率压到 0.25 才在 30 秒窗漂出 144 帧而 120 秒窗仍是 0，量级差太远。
  失败过程记在那个测试文件的注释里，不用再试一遍
- **「排除」这个默认值只能站在「音频里真的没有」那一边。** 把念过的句子排掉是在音频里挖空洞
  （对齐器必须把那段声音塞给邻句）；把没念的句子留着，最坏也只是那一句自己拿到低置信度并被标出来。
  两个方向的代价不对称，所以自动导入现在一句都不排（SPEC §0 变更 24）
- **`src/align/emissionMatrix.ts` 不许 import `@huggingface/transformers`。** 那是 emissions 与
  viterbi 之间那道缝的定义文件（FR-15.13），主线程、单测、将来的线缆编解码器都只需要它的类型
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
