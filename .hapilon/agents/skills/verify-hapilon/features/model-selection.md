# 模型选择

## 子功能

交互界面能打开模型选择器。启动参数也能绑定一个 provider 与模型。

## 用户怎么进入

在 hapi 界面输入 `/model`。从 shell 启动时也可传 `--provider` 与 `--model`。

## 用 Pi RPC 验收

运行 `.hapilon/agents/skills/verify-hapilon/sensitive-file-confirmation.mjs --doctor`。证据中的 `ready` 应显示 `fixture` 模型和本机回环地址。Doctor 通过 `get_state` 检查 provider、模型和端点。

## 易错点

Doctor 只覆盖启动参数绑定，不覆盖 `/model` 的筛选、焦点或选择动作。选择器尚未有验收脚本，不能用 RPC Doctor 的结果判它通过。
