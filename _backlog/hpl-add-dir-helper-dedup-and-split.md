# hpl-add-dir helper 去重与 index.ts 职责拆分

## 背景

code-review（2026-08-09，feat/afk-trio）Standards 轴报告：`src/extensions/hpl-add-dir/` 三个文件间存在重复 helper 与命名混淆，index.ts 职责过载。

## 目的

消除重复代码与命名歧义，将 index.ts 按职责拆分，符合 CLAUDE.md「合理的模块拆分」与「一个文件一个职责」原则。

## 技术债描述

- **Duplicated Code**：`dirExists` 三份（index.ts / context.ts / suggestions.ts）、`readFileSafe` 两份（context.ts / suggestions.ts）、路径解析两份（resolveDir / resolvePath）——同目录内可互导却各自复制
- **Mysterious Name**：`resolveDir`（路径解析）与 `resolveInputPath`（label→path 匹配）近义易混
- **Divergent Change 风险**：index.ts ~700 行承载 widget / 状态 / 4 命令 / 2 工具 / 生命周期，对比 hpl-panel-viewer 拆 5 文件。可选拆法：widget.ts（setWidget 渲染）、tools.ts（两个 LLM 工具）、commands.ts（四个命令）
- **死字段**（可选）：`AddedDir.addedAt` 与 `DirContext.dir` 只写不读——保留 `addedAt` 因 `add-dir:state` session 结构兼容上游；`DirContext.dir` 可删

## 参考引用

- CLAUDE.md — 编码文件/代码组织、Pi 扩展拆分原则
- code-review report（Standards 轴，2026-08-09）

## 项目中指向的位置

- `src/extensions/hpl-add-dir/index.ts`
- `src/extensions/hpl-add-dir/context.ts`
- `src/extensions/hpl-add-dir/suggestions.ts`
