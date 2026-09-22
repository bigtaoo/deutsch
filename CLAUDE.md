# 德语精听训练器 — 会话规则

个人自用的德语精听训练器（Web + iOS/Android 原生壳 + 自建同步后端）。

**先读 [`SPEC.md`](SPEC.md)，再读 [`README.md`](README.md)；接手一个新会话读 [`KICKOFF.md`](KICKOFF.md)。**
本文件只放会话规则，不放项目现状 —— 现状在 KICKOFF.md，需求与形状在 SPEC.md。

## 语言

- **对用户说话**：中文。
- **写进仓库的一切**：文档、代码注释、commit message —— 中文（与 funny 项目相反，那边仓库内一律英文，别把那边的习惯带过来）。

## 改界面之前

**先读 SPEC.md §12「界面规范」，别从 FR 编号里推形状。** 导航、底部单浮层、状态三档、
排版四级、颜色令牌与深色都定在那里；FR-1~17 只定功能，不定形状。

## 验证

```
npm run typecheck              # 只查根 tsconfig 这一份 project references —— 不包含 server/
npm run test:run               # 前端单测
npm --prefix server run typecheck  # 同步后端自己的 tsc，根目录那条 typecheck 查不到这里
npm --prefix server test       # 同步后端单测
npm run build                  # 动了资源/构建配置时必跑：类型过了不等于构建过了
npm run test:e2e               # Playwright，自己 vite build + preview，约 1 分钟
```

五条都是 CI 门禁（`ci.yml` 三个 job：前端 typecheck+test+build 一起、`server` 单独 typecheck+test、`e2e`
单独一个 job），任一红就不该推 —— push `main` 就是上线。**根目录的 `npm run typecheck` 和
`server` 那份 `tsc` 是两套完全独立的 project——server 改了 `Config` 之类的公共类型，
根目录 typecheck 过了不代表 server 也过了**（变更 48 在这里真的红过一次：CI 上
`sync backend` job 报 `Property 'ai' is missing`，而本地只跑了 `npm --prefix server test`
没跑它自己的 `typecheck`，vitest 不做完整类型检查，两个手写 `Config` 字面量的测试文件漏检）。

**动了界面、路由、导入/备份/复习任一条路径，`test:e2e` 必跑。** 它守的是前三条守不住的
那一类：类型过了、单测过了、构建也过了，但打开是白屏 —— 单测跑在 jsdom 里，那里没有真实的
IndexedDB 持久化、没有音频解码、没有 `<input type=file>`、也没有「刷新页面」这回事。
第一次跑要先 `npx playwright install chromium`。

界面改动另外走一遍 §10 验收清单里「界面」那一段（含那条 grep 判据）。
§10 新增的「自动化测试」一段列的是**已经不用人再走一遍**的事 —— 加了用例就往那里记一条。

## 结束任务（用户说「结束任务」时，完整走一遍）

1. **记录信息**：把这次会话产生的、文档里还没有的事实写回项目文档 ——
   `SPEC.md` §0 变更表 / 对应 FR 章节 / §10 验收清单，以及 `KICKOFF.md` 的「现状」与「下一步建议」。
   形状类（交互形式）的决定**当场**写进 SPEC，只留在对话里等于没定。
2. **更新记忆**：`MEMORY.md` + 对应的记忆文件。文档记项目本身，记忆记「该怎么和我协作」，两者不重复但要互相印证。
3. **提交代码**：先跑上面那三条验证，再 commit；提交信息如实概括这次做了什么。
4. **推送**：**push `main` 就是上线** —— CI 绿之后 `deploy` 发 Cloudflare、`deploy-server` 发 VPS。
   所以推之前确认这一版真的想上线；不确定就把命令给用户，让他自己推。
   功能大改走独立分支（如 `ui/redesign-section-12`），合并回 `main` 之前同理。

## 其它

- 工作目录：仓库根（本机 `D:\deutsch`）；环境是 Windows 11 + PowerShell。
- **给用户的可执行命令一律用 PowerShell 语法**（`curl.exe` 而非 `curl`、`Select-String` 而非 `grep`、
  `Select-Object -First N` 而非 `head`）—— 他点 Run 执行的就是 PowerShell，bash 命令会全部失败。
- 在 worktree 里做界面改动**验不了 UI**：`preview_start` 的 cwd 钉在 `D:\deutsch`，
  起出来的 dev server 服务的是共享检出的代码。
