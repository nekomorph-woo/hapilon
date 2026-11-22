# 命令行帮助与版本

## 子功能

命令行在不进入 Pi 会话的情况下显示用法和版本。

## 用户怎么进入

在 shell 运行 `hapilon --help` 或 `hapilon --version`。

## 用 shell 验收

在仓库根目录构建后运行 `node dist/cli.js --help` 和 `node dist/cli.js --version`。记录退出码与标准输出。帮助应包含 `--no-safety` 和 `--sandbox`；版本应与 `package.json` 一致。把输出保存在 `.hapilon/verify/` 下的本次证据目录中。

## 易错点

使用 `dist/cli.js`，不要用 PATH 上可能落后的全局安装。这条路径不验证 Pi 的交互界面。
