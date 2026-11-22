# hapi 功能地图

验收脚本用功能名命名，例如 `sensitive-file-confirmation.mjs`。新增脚本时，在这里补上用户入口、验证命令和证据位置。不要用 `verify.mjs` 这类看不出功能的名字。

| 功能 | 用户入口 | 验证 |
| --- | --- | --- |
| [敏感文件读取确认](sensitive-file-confirmation.md) | hapi 执行 Bash 工具 | 专用脚本，记录确认和模型输入 |
| [模型选择](model-selection.md) | `/model` | RPC Doctor 检查模型绑定；选择界面另验 |
| [命令行帮助与版本](cli-help-and-version.md) | `hapilon --help`、`hapilon --version` | 运行仓库构建产物并保存输出 |
