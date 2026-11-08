# team 编排（pane 派发与收敛）

来源：hpl-orchestra。team 配置在 `~/.hapilon-dev/teams/`，role.model 支持 `tier:<name>[<index>]`。

## 触发

线 B。在验证终端里跑一个最小 team：单 role、单 pane、一个能秒回的任务（如「回复 ok」）。观察 pane 派发与结果回收。

## 断言

1. team 启动命令不报「herdr 二进制不存在」类错误。
2. 子 pane 被创建且任务送达（`hc ls` 能看到新 pane）。
3. 任务结果回收回主会话。

## 已知缺口（先于验收存在）

hpl-orchestra 指向 TUI 版 `herdr` 二进制，本环境只有 herdr-core + `hc`。真实用户路径上 team 派发大概率直接失败。验收此特征时若命中缺口，结论记「功能在 herdr-app 环境不可用」，把缺口和复现命令写进证据，不修流程本身——修复属于 hapilon 功能开发，另开任务。

## 盲区

role.model 的 tier 回落逻辑需要多 role team 才能覆盖，首轮验收不包含。
