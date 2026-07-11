# Hapilon 实施任务清单

> 基于 [Hapilon-PRD-v1.1.md](./Hapilon-PRD-v1.1.md) 提取

---

## [~] TODO-001：Hapilon 最小试验版本（v0.1.0-alpha）

### 来源

PRD 第 15 章「最小可运行版本：Hapilon 0.0.1」（第 2584~2932 行）

### 目标

构建 hapilon 的**最小试验版本**，可以：

1. 在终端输入 `hapilon` 命令启动
2. 首先在控制台打印 `hapilon_v0.1.0_alpha`
3. 然后启动 pi-coding-agent 0.80.6 的 TUI 交互式控制台
4. 保留 Pi 原版 TUI 体验（stdio inherit）

### 实现要点

| 项目 | 内容 |
|------|------|
| 项目技术栈 | TypeScript + Node.js |
| 包管理 | npm（单包仓库） |
| Pi 版本 | `@earendil-works/pi-coding-agent@0.80.6` |
| 入口命令 | `hapilon`（package.json bin） |
| 启动方式 | spawn Node 子进程，stdio inherit |
| 版本显示 | 启动时打印 `hapilon_v0.1.0_alpha` 到 stdout |

### 参考 PRD 目录结构

```
hapilon/
├── package.json        # pi 依赖 + hapilon bin
├── tsconfig.json
├── .gitignore
├── src/
│   ├── cli.ts          # 入口：打印版本 → spawn pi
│   └── extension.ts    # Hapilon Extension（可选 MVP）
└── resources/
    └── skills/
        └── wokii-start/
            └── SKILL.md
```

### 验收标准

- [ ] `hapilon` 命令可运行，控制台输出 `hapilon_v0.1.0_alpha`
- [ ] 之后成功启动 pi-coding-agent TUI
- [ ] Pi TUI 交互正常（输入、Ctrl+C、resize）
- [ ] 不要求全局安装 pi
- [ ] 使用 Hapilon 锁定的 Pi 版本（0.80.6）

### 实现方案

见 Plan Mode 输出。
