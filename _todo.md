# TODO 清单

> 当前任务：hapilon setup OAuth 引导体验

---

## [~] TODO-11：hapilon setup — OAuth provider 引导

### 目标

`hapilon setup` 在交互式配置结束后，主动引导用户了解可用的 OAuth provider（xAI/Grok、Codex、Claude Pro、GitHub Copilot），告知如何在 hapilon TUI 中完成 OAuth 登录，不要让用户困在 API key 输入流程里。

### 实现要点

| 项目 | 内容 |
|------|------|
| 修改文件 | `src/setup.ts` — setupInteractive() 和 setupQuick() 末尾 |
| 触发时机 | API key 配置流程结束后，打印 OAuth 引导区块 |
| 引导内容 | 列出 Pi 内置支持的 OAuth provider 及 /login 命令 |
| Pi 内置 OAuth | xAI (Grok 4.5)、Codex、Claude Pro、GitHub Copilot |
| 登录方式 | 进入 hapilon TUI → `/login <provider>` → device-code / Web PKCE OAuth → 浏览器授权 |
| token 存储 | 自动写入 `~/.hapilon/agent/auth.json`，与 API key 模式共存 |
| 快速模式 | `hapilon setup --quick` 也输出 OAuth 引导（不能跳过） |

### 验收标准

- [ ] `hapilon setup` 交互式流程结束时，打印 OAuth provider 列表和 `/login` 使用说明
- [ ] `hapilon setup --quick` 也输出 OAuth 引导
- [ ] 引导内容区分：API key 配完了 → 顺带告知还有 OAuth 方式
- [ ] 当前可用的 OAuth provider 从 Pi 运行时检测（而非硬编码过时列表）
- [ ] 引导文案简洁（不超过 10 行），用"ℹ OAuth 方式登录"标识
