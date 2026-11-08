# hpl-herdr 状态上报（agent 身份与状态）

来源：hpl-herdr 扩展。hapi 进程向宿主上报身份与状态，让 herdr-core 把 pane 识别为 agent 并跟踪 working/idle 与 turn 计数。

## 触发

线 A + 线 B 混合。本特征的特殊性：验证者自己就跑在被验证的通道上。

## 断言

1. 验证终端 `hc get <t> --json`：`"agent":"hapilon"`，`cwd` 指向 hapilon 仓库；就绪信号是 `reported:true` + `status.state`（`hc run` 返回值里的 `agent` 只是 argv 猜测，不可作就绪依据）。
2. `hc send` 派活后 status 转为 working；turn 计数在 turn 完成 时 +1，进行中保持旧值——中间态断言看 status，不看 turn。
3. `hc wait <t>` 返回后 status 回 idle。
4. 非交互命令（如 `hc exec`）不产生终端与 agent 条目（`hc ls --json` 前后对比；外壳是 `{hidden_finished, terminals}`）。
5. `hc send` 送达的文本在读屏里带来源包裹 `<hc from="<发起终端>">…</hc>`，断言时区分包裹与被验方输出。

采样技巧：send 不带 `--wait`，紧接 `hc get` 可捕 working 中间态；要一次拿收敛与产物就用 `--wait`。

## 盲区

- 上报的中间态（如状态切换的毫秒级时序）读不到，只验终态。
- 本会话自身的 pane 也上报状态：验收时 `hc ls` 会看到自己，别把自己的终端当成验证对象。
