# 新会话开工提示

> 复制下面整段，粘贴到新会话即可开工。

---

项目：德语精听训练器（个人自用工具，工作目录 D:\deutsch）

**先读 SPEC.md，再读 README.md。** 需求文档已定稿，包含完整的功能需求、数据模型、技术决策、风险表和验收清单。
附录 A 是 DW 接口的实测结果（A.6 是实现完成后用真实期次做的复验），附录 B 是 GitHub API 的实测结果——
这些是真实探测出来的事实，不要重新假设，也不用重新验证（除非怀疑对方改版了）。

## 现状（2026-08-31）

**§9 实现顺序的 11 步已全部完成**，`main` 上可跑、可构建、189 个单元测试通过。

已经用真实的 Alltagsdeutsch 期次 `45334084` 端到端跑通：RSS → 页面 `__APOLLO_STATE__` → mp3 下载 →
切句（42 句）→ teaser 块自动排除 → 14 条 Glossar 候选词**全部落位正确** → 打点 → 接受候选词 →
听写判级 → FSRS 复习。详见 SPEC.md 附录 A.6。

**唯一的大窟窿：GitHub 备份从来没用真实 PAT 联调过。** 逻辑完成、mock 测试通过，
但一键建仓、写权限校验、token 过期响应头（附录 B.2 未定）、一键恢复（FR-11.13）都还没碰过真实 API。
§10 验收清单里标 ❌ 的全部卡在这一件事上。

## 下一步建议（按价值排序）

1. **拿一个真实 fine-grained PAT 走完 §10 里标 ❌ 的那一串**，尤其是**恢复演练** ——
   文档里写了「不做完不算验收通过」。顺便把附录 B.2 的三个待确认项填掉
   （过期响应头名称、最长有效期、`POST /user/repos` 的默认分支名）。
2. **实际用两周**，然后再回来改。§10 里标 🧪 的几条（跟读循环、多区间挖空）代码路径有测试，
   但没有人真的连着跟读过十分钟，手感问题只有用出来。
3. Q7：存档列表页 `/de/alltagsdeutsch/s-9214` 是否也在 `__APOLLO_STATE__` 里给出完整的 400+ 期列表。
   若给了，L1 就能覆盖全部存档，大约 10 分钟的增量。

明确不要做（文档里已经论证过，不要重开讨论）：

- 不建任何后端、代理或本地 helper 进程（§3.1.1 R-1）
- 不做 GitHub OAuth 登录（附录 B.1 实测：端点无 CORS、不支持 PKCE，纯前端不可行）
- 不做自动强制对齐、自动挖空难度判定、词形还原（都是 V2）
- 不做内容分享或托管功能（§3.1 法律边界）
- 不做中文 → 德语方向的卡片（§7.5）
- 不做「一键导入全部期次」（§3.1.1 R-3）

几个容易踩的坑（前四条是原有的，后四条是实现期踩出来的，都写进了代码注释）：

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

环境：Windows 11 + PowerShell。给我可执行命令时请用 PowerShell 语法（`curl.exe` 而非 `curl`，
`Select-String` 而非 `grep`，`Select-Object -First N` 而非 `head`）。
