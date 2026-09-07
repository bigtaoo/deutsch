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
npm run typecheck
npm run test:run     # 前端 478 个；server/ 那套 52 个要在 server/ 里另跑
npm run build        # 动了资源/构建配置时必跑：类型过了不等于构建过了
```

界面改动另外走一遍 §10 验收清单里「界面」那一段（含那条 grep 判据）。

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
