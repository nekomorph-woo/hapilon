# Shell 编码绕过检测 — base64/hex/IFS 逃逸

## 背景

社区安全工具 bashguard 有 13 条 evasion 规则覆盖编码绕过。我们的 hpl-safety-gate 当前使用纯正则匹配，无法检测以下逃逸模式：

- `echo "cm0gLXJmIC8=" | base64 -d | sh` — base64 编码绕过
- `echo 726d202d7266202f | xxd -r -p | sh` — hex 编码绕过
- IFS 操纵：`IFS=:; command${IFS}rm -rf /`
- shell-in-shell：`bash -c "rm -rf /"`
- ROT13 / Unicode 替换

## 目的

阻止 Agent 通过编码/混淆绕过命令黑名单。

## 描述

| 项目 | 内容 |
|------|------|
| 类型 | 待实现 |
| 当前状态 | hpl-safety-gate 仅用纯正则，无语义解析 |
| 预期用途 | 在 classifyCommand 前增加一层逃逸检测，检测到 base64/hex 管道到 shell 时以及 IFS/shell-in-shell 时直接 block |
| 创建时间 | 2026-07-16 |

## 参考引用

- bashguard evasion.* 13 条规则
- dcg heredoc 跨语言内联脚本检测
- pi-permission-layers shell tricks 检测 ($()、反引号、<()、>() — 我们已经覆盖）

## 项目位置

- **待修改**: `src/extensions/hpl-safety-gate/rules.ts` — 新增 EVASION_PATTERNS
- **待修改**: `src/extensions/hpl-safety-gate/classifier.ts` — classifyCommand 优先检查逃逸
- **参考**: `src/extensions/hpl-safety-gate/rules.ts` — 现有的 SHELL_INJECTION_PATTERNS
