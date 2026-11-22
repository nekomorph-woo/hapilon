# 模型选择

## 子功能

交互界面能打开模型选择器。启动参数也能绑定一个 provider 与模型。

## 用户怎么进入

在 hapi 界面输入 `/model`。从 shell 启动时也可传 `--provider` 与 `--model`。

## 用 Pi RPC 验收

运行 `.hapilon/agents/skills/verify-hapilon/sensitive-file-confirmation.mjs --doctor`。证据中的 `ready` 应显示 `fixture` 模型和本机回环地址。Doctor 通过 `get_state` 检查 provider、模型和端点。

## 用 hc 验收终端选择器

从仓库根目录创建独立临时目录，在其中建 `home`、`work`、`hapi/agent`。写入 `hapi/agent/models.json`，用本机回环地址和假令牌注册模型，不连接真实模型：

```json
{"providers":{"verify-local":{"baseUrl":"http://127.0.0.1:1/v1","api":"openai-completions","apiKey":"fixture-not-a-key","models":[{"id":"fixture"}]}}}
```

把临时目录的绝对路径存为 `scratch`，再从仓库根目录启动：

```sh
node_bin=$(command -v node)
hc run --bg --json --name verify-model-select --cwd "$scratch/work" --label kind=verify \
  env HOME="$scratch/home" HAPILON_HOME="$scratch/hapi" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  PI_OFFLINE=1 ACP_AUTO_UPDATE=0 CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1 \
  "$node_bin" "$PWD/dist/cli.js" --no-session --no-mcp --no-econ --provider verify-local --model fixture
```

从返回 JSON 取 `address`。用 `hc get "$address" --json` 确认状态为 `live`，上报 `hapilon` 且 `status.state` 为 `idle`。运行 `hc keys "$address" / m o d e l enter`，用 `hc read "$address"` 确认 `fixture [verify-local]` 已高亮。再按 Enter，确认选择器关闭、屏幕显示 `Model: fixture`。保存两次读屏和状态。只清理这次的终端和临时目录。

## 易错点

- `hc send` 会给文本加来源标签；用 `hc keys` 输入 `/model`，否则它会被当成模型消息。
- Doctor 只验证启动参数。单模型终端用例证明能打开选择器并选中条目，不覆盖多模型筛选或切换。
