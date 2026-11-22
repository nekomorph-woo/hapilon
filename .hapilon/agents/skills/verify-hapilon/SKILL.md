---
name: verify-hapilon
description: 验证本仓库构建的 hapi。改动命令行、终端交互或模型裁决后，选择机械回归、终端观察或真实模型评估并留证；只改内部逻辑且单测能覆盖时不用，发版走 hapilon-release。
---

# 验证 hapi

## Launch

从仓库根目录运行 `npm run build`。按[功能地图](features/README.md)选择入口，不接管用户的 pane。

| 要验证什么 | 用什么 |
| --- | --- |
| 命令行输出和退出码 | 直接运行 `node dist/cli.js`。 |
| 工具调用、确认请求、模型收到的结果 | 用 Pi 的进程间接口 RPC 启动独立 hapi，以本机端点替代模型。 |
| 弹窗布局、焦点和按键 | 用 `hc run` 开独立终端，再用 `hc read` 观察。 |
| 真实模型是否判对 | 用合成样例重放产品实际发送的提示词和输入，逐例对照预期。 |

## Doctor

核对 `node dist/cli.js --version` 与 `package.json` 一致。终端验收先用 `hc ls --json` 确认连接可用，再用 `hc get <本次终端>` 确认启动状态。真实模型评估还要核对具体的 provider 和模型 ID；没有可用登录则记为未验证，不用替身补算。

安全门 RPC 验收的 Doctor 见[敏感文件读取确认](features/sensitive-file-confirmation.md)。它检查就绪状态、模型绑定和 `/gate-auto-mode` 注册。失败时查 `events.jsonl` 的 `harness-error` 和 `stderr`，不改用当前会话补跑。

## Drive

先写用户入口、操作和通过条件。能用现有命令重现，就不用新增脚本。不能机械断言的部分，先固定样例和预期，再记录观察结果；不要为了全绿而替换成脚本能断言的相邻行为。

同一功能可以走多条路径。例如安全门的模型替身回归只证明 `allow` 会免确认，真实模型评估才回答它是否应该给 `allow`。RPC 收到弹窗请求也不能证明用户看到了预期的布局或焦点。

## Evidence

把证据放在 `.hapilon/verify/`。CLI 留命令、退出码和输出；终端留操作和读屏；模型评估留构建版本、模型 ID、输入、预期、实际裁决和分歧。单独标出未验证项。只用假凭证，不把真实密钥、鉴权信息或无关会话内容写进证据。

RPC 脚本打印 `events.jsonl` 路径。看 `case`、`rpc`、`judge-input`、`model-input` 和 `verdict`，分别核对命令、确认、判定模型输入、会话模型收到的工具结果和断言。

## Cleanup

脚本关闭它启动的进程和本地端点，删除本次临时目录。确认最后一条是 `cleaned`，且证据文件仍可读。终端验收只用 `hc kill` 和 `hc rm` 清理本次创建的终端，不按进程名批量结束进程。

## Helpers

[RPC 验收环境](rpc-verification.mjs)负责隔离启动、就绪检查、事件记录和清理。功能脚本负责夹具、模型替身回复和断言。地图落后于真实入口时，用 `/skill:maintain-verification-skill` 更新。
