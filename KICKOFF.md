# 新会话开工提示

> 复制下面整段，粘贴到新会话即可开工。

---

项目：德语精听训练器（个人自用工具，工作目录 D:\deutsch）

**先读 SPEC.md。** 需求文档已定稿，包含完整的功能需求、数据模型、技术决策、风险表和验收清单。附录 A 是 DW 接口的实测结果，附录 B 是 GitHub API 的实测结果——这些是真实探测出来的事实，不要重新假设，也不用重新验证（除非怀疑对方改版了）。

## 现状（2026-08-31）

§9 实现顺序的第 1 步、第 1b 步已完成并推到 `main`、部署上线：

- 项目脚手架、IndexedDB 两层 schema、导出/导入/合并（§2.4 规则）——有单元测试
- GitHub PAT 连接、一键建仓、写权限校验、离线队列、token 过期监控——逻辑完成 + mock 测试通过，**但还没用真实 PAT 联调过**，细节见 `src/github/auth.ts` 里关于过期响应头字段名（附录 B.2 未定）的注释
- 额外加的（原规格没有，实现中发现有价值就加了，已写回 SPEC.md FR-11.18）：设备配对二维码——已连接的设备生成二维码，新设备扫码自动连接+选仓库，不用手动敲 token 字符串
- CI/CD：GitHub Actions，push 到 `main` 且 CI 通过后自动发布到 Cloudflare Workers 静态资源，线上地址 **https://d.gamestao.com**（仓库 `bigtaoo/deutsch`）

**现在开工第 2 步**：导入 + 切句 + 手工修正（§4 用户动线的②，FR-1、FR-2）。

明确不要做（文档里已经论证过，不要重开讨论）：

- 不建任何后端、代理或本地 helper 进程（§3.1.1 R-1）
- 不做 GitHub OAuth 登录（附录 B.1 实测：端点无 CORS、不支持 PKCE，纯前端不可行）
- 不做自动强制对齐、自动挖空难度判定、词形还原（都是 V2）
- 不做内容分享或托管功能（§3.1 法律边界）
- 不做中文 → 德语方向的卡片（§7.5）

几个容易踩的坑，文档里都有细节：

- 全程复用同一个 `<audio>` 元素（iOS 手势链约束，§3.2）
- HTML → 纯文本转换必须同步维护 offset 映射，否则 Glossar 候选词会静默错位（§7.8）
- 排序去重用 `firstPublicationDate` 而不是 `pubDate`（DW 在重推旧期，附录 A.2）
- `Intl.Segmenter` 对 `z. B.` 一定会断错，切句强制要有手工修正 UI，别指望规则能覆盖全部（FR-2.3、§7.1）
- fine-grained PAT 创建时 Repository access 要选 "All repositories"，不是 "Only select repositories"——一键建仓时目标仓库还不存在，选不了（FR-11.1）

先给实现计划，不要直接开始写代码。

环境：Windows 11 + PowerShell。给我可执行命令时请用 PowerShell 语法（`curl.exe` 而非 `curl`，`Select-String` 而非 `grep`，`Select-Object -First N` 而非 `head`）。
