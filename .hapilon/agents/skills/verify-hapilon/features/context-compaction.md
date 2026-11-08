# 上下文压缩与水位（billion-context-pi）

来源：billion-context-pi（npm-extensions 挂载）。它 cancel 了 pi 原生 compaction，压缩入口是模型自动折叠 + 手动对模型说；水位查看用 `/acp-status`。

## 触发

线 B。在验证终端里：跑 `/acp-status` 看水位；再让模型执行一次小规模压缩（直接对模型说「压缩刚才的探索过程」）后重跑 `/acp-status`。

## 断言

1. `/acp-status` 输出压缩块与水位信息（COMPRESSED BLOCKS 段非空即算有压缩能力）。
2. 压缩动作后 `/acp-status` 水位下降，且产出 block（编号出现）。
3. `/compact` 不出现在命令表（hapiCompactHide 补丁：billion-context 在场时它是死命令，不该露出）。

## 盲区

- 大上下文下的自动折叠阈值行为不在此验收范围，需要真实长会话，成本高，按需触发。
- 压缩质量（摘要丢没丢关键信息）不属于本特征，属模型行为评估。
