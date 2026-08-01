# Prompt Injection 结构性防御

## 背景

4 路 subagent 搜索发现，AI coding agent 的真正威胁不仅来自单条危险命令，还来自结构性 prompt injection 攻击向量：

1. **Subagent 盲区**：Claude Code 的 hooks 对 subagent 执行完全不触发（Ian Paterson 实测）。攻击链可绕过所有规则。
2. **MCP Tool Description 投毒**：恶意 MCP server 在 tool description 中嵌入注入指令，agent 每次启动时加载，所有后续 session 受影响。
3. **Rules File Backdoor (fork 传播)**：`.cursorrules` / `CLAUDE.md` 被投毒后，所有 fork 仓库的开发者自动继承恶意配置。
4. **Memory 系统投毒**：`update_memory` 工具可被利用在持久知识库中写入恶意"记忆"。
5. **隐藏文本注入**：Unicode 零宽字符、双向覆盖标记、HTML 注释中的 `<user_query>` token。

## 目的

在 hapilon 层面建立 prompt injection 的多层防御，弥补纯命令拦截的不足。

## 描述

| 项目 | 内容 |
|------|------|
| 类型 | 待实现 |
| 当前状态 | 未实现。hapilon 仅做命令级拦截（hpl-safety-gate + hpl-protected-paths），无 prompt 层面的注入防御 |
| 预期用途 | 分层防御：(1) 配置文件审计 — 扫描 CLAUDE.md/rules 中的可疑隐藏字符；(2) 输入过滤 — 参考 Ian Paterson 的 canary honeypot 方案；(3) subagent 输出验证 — 弥补 hooks 盲区 |
| 创建时间 | 2026-07-16 |

## 参考引用

- Ian Paterson, "I Built a Honeypot to Catch Prompt Injections in Claude Code" (2026-06)
- AIShellJack (arXiv:2509.22040): 314 个 payload，Cursor auto-approval 83.4% 成功率
- HiddenLayer: Cursor 攻击链 — HTML 注释注入 + $() 绕过 denylist
- Mitiga 假面试仓库: 1 分 51 秒完整攻击链
- IDEsaster (30+ CVE): workspace configuration hijacking
- Pillar Security: Unicode 零宽字符 rules file backdoor
- OWASP ASI06 (Agentic Security): memory system poisoning

## 项目位置

- **待调研**: rules 文件审计 — 扫描 `.claude/` `.cursor/` 配置中的隐藏字符
- **待调研**: canary honeypot — 用低能力模型预扫 agent 输入内容
- **待调研**: subagent 输出验证 — 在 hapilon 层拦截 subagent 危险操作
- **关联文档**: `_foresight.md` §P0.1 安全基础设施
