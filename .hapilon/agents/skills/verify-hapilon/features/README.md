# hapi 功能地图

先写用户入口、操作和通过条件。能用 hapi 或 `hc` 验收时，直接用现有命令。需要重复执行、自动断言时再加脚本，按用途命名。Pi RPC 验收可共用 [`rpc-verification.mjs`](../rpc-verification.mjs) 的隔离环境、事件记录和清理。

| 功能 | 用户入口 | 验证 |
| --- | --- | --- |
| [敏感文件读取确认](sensitive-file-confirmation.md) | hapi 执行 Bash 工具 | RPC 回归验证放行与确认；真实模型评估裁决；终端验证布局与焦点 |
| [模型选择](model-selection.md) | `/model` | RPC Doctor 检查启动时的模型绑定；用 `hc` 验收选择器 |
| [命令行帮助与版本](cli-help-and-version.md) | `hapilon --help`、`hapilon --version` | 运行仓库构建产物并保存输出 |
