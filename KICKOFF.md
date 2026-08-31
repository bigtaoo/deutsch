# 新会话开工提示

> 复制下面整段，粘贴到新会话即可开工。

---

项目：德语精听训练器（个人自用工具，工作目录 D:\deutsch）

**先读 SPEC.md，再读 README.md。** 需求文档已定稿，包含完整的功能需求、数据模型、技术决策、风险表和验收清单。
附录 A 是 DW 接口的实测结果（A.6 是实现完成后用真实期次做的复验），附录 B 是 GitHub API 的实测结果——
这些是真实探测出来的事实，不要重新假设，也不用重新验证（除非怀疑对方改版了）。

## 现状（2026-08-31）

**§9 实现顺序的 11 步已全部完成**，`main` 上可跑、可构建、254 个单元测试通过。

已经用真实的 Alltagsdeutsch 期次 `45334084` 端到端跑通：RSS → 页面 `__APOLLO_STATE__` → mp3 下载 →
切句（42 句）→ teaser 块自动排除 → 14 条 Glossar 候选词**全部落位正确** → 打点 → 接受候选词 →
听写判级 → FSRS 复习。详见 SPEC.md 附录 A.6。

**FR-15 自动打点已完成**（在 §9 的 11 步之外新增，见 SPEC.md §0 第 17 条、FR-15、§7.9）：
浏览器内跑 CTC 强制对齐（MMS-FA + 自己实现的 Viterbi），从「已切好的句子 + 音频」直接算出
句级与词级时间戳。已在同一期真实素材上验过：45 秒写入 38 句 + 744 个词级时间戳，
标出 5 句待校对，词级边界抽查合理。代码在 `src/align/`。

**唯一的大窟窿：GitHub 备份从来没用真实 PAT 联调过。** 逻辑完成、mock 测试通过，
但一键建仓、写权限校验、token 过期响应头（附录 B.2 未定）、一键恢复（FR-11.13）都还没碰过真实 API。
§10 验收清单里标 ❌ 的全部卡在这一件事上。

## 下一步建议（按价值排序）

1. **拿一个真实 fine-grained PAT 走完 §10 里标 ❌ 的那一串**，尤其是**恢复演练** ——
   文档里写了「不做完不算验收通过」。顺便把附录 B.2 的三个待确认项填掉
   （过期响应头名称、最长有效期、`POST /user/repos` 的默认分支名）。
2. **实际用两周**，然后再回来改。§10 里标 🧪 的几条（跟读循环、多区间挖空）代码路径有测试，
   但没有人真的连着跟读过十分钟，手感问题只有用出来。
3. **打包成原生应用**（用户已决定要做，见 SPEC Q9）。桌面用 Electron；但**Electron 不支持手机**，
   而「手机上也要能自动打点」是明确要求，所以手机要用 Capacitor 或 Tauri v2。
   打包前先跑 `npm run stage:align` 把 200MB 权重放进 `public/models/`，
   并给 vite 配 `base: './'`（`?url` 产出的是绝对路径，`file://` 下会断）。
4. Q7：存档列表页 `/de/alltagsdeutsch/s-9214` 是否也在 `__APOLLO_STATE__` 里给出完整的 400+ 期列表。
   若给了，L1 就能覆盖全部存档，大约 10 分钟的增量。

明确不要做（文档里已经论证过，不要重开讨论）：

- 不建任何后端、代理或本地 helper 进程（§3.1.1 R-1）
- 不做 GitHub OAuth 登录（附录 B.1 实测：端点无 CORS、不支持 PKCE，纯前端不可行）
- ~~不做自动强制对齐~~ —— **这条已作废，FR-15 做了**（用户 2026-08-31 明确要求集成进应用）。
  自动挖空难度判定、词形还原仍是 V2
- 不做内容分享或托管功能（§3.1 法律边界）
- 不做中文 → 德语方向的卡片（§7.5）
- 不做「一键导入全部期次」（§3.1.1 R-3）

几个容易踩的坑（前四条来自文档，其余都是实现期踩出来的；最后六条来自 FR-15。全部写进了代码注释）：

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
  不能只看 `res.ok`，要验 content-type 是 JSON
- 待校对阈值必须是**相对本课中位数**的。绝对阈值随模型漂：实测中位数 -1.11，
  按感觉写的 -0.6 会把 37/38 句全标黄

环境：Windows 11 + PowerShell。给我可执行命令时请用 PowerShell 语法（`curl.exe` 而非 `curl`，
`Select-String` 而非 `grep`，`Select-Object -First N` 而非 `head`）。
