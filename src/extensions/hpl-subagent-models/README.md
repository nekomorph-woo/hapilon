# hpl-subagent-models

subagent 派发的模型列表。两个接入点共享同一张列表：`tool_call` 钩子拦 Agent / TaskExecute；`ensure-pi-patch` 注入 workflow host 的全局钩子覆盖 SubagentWorkflow 的 `agent()` 派发（该路径无 tool_call）。两处都只改**未显式指定模型**的派发；调用方显式给了 `model` 时尊重调用方，`resume` 派发不改写。列表不命中（未配置 / 关闭 / 全部配额紧张）时不动参数，回落父 agent 的模型。

## 交互编辑

`/subagent-models`：概览两层现状 → 选编辑目标（全局 / 项目）→ 单次操作（开关扩展、添加模型、设置 thinking、调整顺序、移除模型、清空列表）→ 写回。保存即生效，无需 /reload。概览页附检查提示（/agents → Settings 开 showModel）。

## 配置

全局 `~/.hapilon-dev/subagent-models.json`，项目 `.hapilon/subagent-models.json`（存在即整体替换全局）。缺文件或 `enabled: false` 时扩展不介入。

```json
{
  "enabled": true,
  "models": [
    "openai/gpt-5.2:high",
    "zai-coding-cn/glm-4.7"
  ]
}
```

## 规则

- 配置顺序为准；条目 provider 任一用量窗口 ≥90%（hpl-quota-usage 快照）视为紧张，沉底顺延到后面的条目。
- 全部紧张：不改写，回落父 agent 模型，console.warn 提示。
- `:thinking` 后缀只对 Agent 工具生效（TaskExecute 与 workflow 派发没有该参数直通车；workflow 的思考深度走脚本自己的 `effort` 参数）。
