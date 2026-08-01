# OS 沙箱方案 — 跨平台 Coding Agent 隔离

> 一句话概括：OS 沙箱在操作系统层面给 AI Agent 画一个圈——圈内能碰，圈外看不见也改不了。hapilon 面向 macOS / Linux / Windows 三平台，需要了解每个平台可用的隔离方案。

## 核心概念

### 什么是 OS 沙箱

不是 Docker 容器、不是虚拟机、不是应用层拦截——是**操作系统内核**直接限制进程能访问什么。Agent 进程想读 `~/.ssh/`？内核直接返回 "permission denied"，Agent 绕不过去。

### 为什么 coding agent 需要它

```text
安全层次（深层防御）：

第 1 层：命令拦截     ← hpl-safety-gate（我们已有）   正则匹配，漏一条就出事
第 2 层：文件保护     ← protected-paths（我们已有） hook 拦截，只覆盖 write/edit/read
第 3 层：OS 沙箱      ← 本次主题                   内核强制，不可能绕过
第 4 层：容器/虚拟机   ← Docker/microVM            完全隔离，但有性能开销
```

hpl-safety-gate 和 protected-paths 的局限：它们是**规则匹配**——漏写一条规则就多一个洞。OS 沙箱是**默认拒绝 + 显式允许**——所有路径默认不可访问，只有明确列出的才放行。

---

## 三平台隔离技术总览

| 平台 | 内核隔离技术 | 成熟度 | 是否需要安装 | 备注 |
|------|-------------|--------|-------------|------|
| **macOS** | Seatbelt (sandbox-exec) | ⭐⭐⭐ | 系统内置 | Apple 标记 deprecated，但仍在用 |
| **Linux** | Landlock / bubblewrap | ⭐⭐⭐⭐⭐ | 内核 5.13+ 内置 / 需安装 | 最成熟 |
| **Windows** | Windows Sandbox / 完整性级别 / AppContainer | ⭐⭐ | Win 10/11 Pro+ 内置 | 生态最弱 |

### macOS — Seatbelt (sandbox-exec)

Apple 的内核级沙箱。用 Scheme 语言写 `.sb` 配置文件，声明进程能读写哪些路径。

```
优势：
  ✅ 系统内置，零安装
  ✅ 内核强制，不可绕过
  ✅ 子进程自动继承沙箱规则

劣势：
  ❌ Apple 官方标记 deprecated（但 macOS 15 仍可用）
  ❌ Scheme 语法的 .sb 文件学习曲线陡峭
  ❌ 不支持细粒度网络控制
  ❌ 未来 macOS 版本可能移除
```

**代表工具**：`scode`、`nono`、`fence`、`anthropic-sandbox-runtime`

**基本用法**（手工）：
```bash
sandbox-exec -f profile.sb hapilon
```

### Linux — Landlock + bubblewrap

Linux 生态最丰富，两个主力：

| 技术 | 原理 | 优势 |
|------|------|------|
| **Landlock** | 内核 5.13+ 内置的安全模块，无特权即可使用 | 零依赖、不可逆、子进程继承 |
| **bubblewrap (bwrap)** | 用 Linux namespace 隔离进程 | 更成熟、支持更细粒度控制 |

```
优势：
  ✅ Landlock 内核内置，无需 root
  ✅ bubblewrap 几乎所有发行版都有包
  ✅ 生态最成熟（landrun/nono/fence/...）
  ✅ 细粒度网络控制（namespace + proxy）

劣势：
  ❌ Landlock 需要内核 >= 5.13（Ubuntu 22.04+）
  ❌ bubblewrap 需额外安装
  ❌ 不同发行版行为可能有差异
```

**代表工具**：`nono`、`fence`、`landrun`、`bubblewrap`

**基本用法**（手工）：
```bash
bwrap --bind /workspace --dev /dev --proc /proc hapilon
```

### Windows — Windows Sandbox / 其他

Windows 是三个平台里最弱的：

```
方案 A：Windows Sandbox（Win 10/11 Pro/Enterprise）
  ✅ 内置、轻量 VM 级隔离
  ❌ 需要 Pro 版，Home 版没有
  ❌ 每次启动都是全新环境（默认无状态）
  ❌ 文件共享需配置

方案 B：AppContainer / 完整性级别
  ✅ 系统内置
  ❌ API 复杂，极少有 AI 沙箱工具用这个
  ❌ 没有现成的命令行包装器

方案 C：WSL2 + Linux 沙箱
  ✅ 如果 hapilon 在 WSL2 中运行，直接用 Linux 方案
  ❌ 需要用户安装 WSL2
```

**现实**：绝大多数 Windows AI 沙箱工具依赖 WSL2 运行 Linux 版。原生 Windows 沙箱方案基本不存在。

---

## 现有 Coding Agent 沙箱工具对比

### 跨平台（推荐关注）

| 工具 | Stars | macOS | Linux | Windows | 方式 | 特色 |
|------|-------|-------|-------|---------|------|------|
| **anthropic-sandbox-runtime** | 4388 | Seatbelt | bubblewrap | ❌ | OS 原语 | Claude Code /sandbox 后台 |
| **nono** | 2643 | Seatbelt | Landlock | WSL2 计划中 | OS 原语 | 凭证注入代理、审计日志、最强独立方案 |
| **fence** | 794 | Seatbelt | bubblewrap | ❌ | OS 原语 | 命令 deny 规则、SSH 过滤、模板继承 |
| **scode** | ~300 | Seatbelt | bubblewrap | ❌ | 单 bash 脚本 | 最轻量、零依赖、35+ 凭证路径预设 |
| **yolobox** | 603 | Docker | Docker | Docker | 容器 | 开箱即用 `yolobox claude` |

### macOS 专有

| 工具 | 特色 |
|------|------|
| **Agent Safehouse** | 预配置 Seatbelt 方案，开箱即用 |
| **SandVault** | 独立 macOS 用户账户 + sandbox-exec 双重隔离 |
| **Chamber** | 用 Tart 启动临时 macOS VM |

### Linux 专有

| 工具 | 特色 |
|------|------|
| **landrun** | Landlock 先驱（已停滞，但已验证技术路线） |
| **sandlock** | Landlock + seccomp-bpf + seccomp 用户通知 |
| **Firejail** | 成熟的 Linux 桌面/应用沙箱 |

### Windows 选项

| 工具 | 特色 |
|------|------|
| **Windows Sandbox** | 内置，Win Pro+ |
| **WSL2 + Linux 沙箱** | 务实地看，这是目前最好的 Windows 方案 |
| **Docker Desktop** | 跨平台容器方案 |

---

## 与本项目的关系

### hapilon 的定位

hapilon 是 Pi Coding Agent 的 CLI wrapper。当前安全层：

```text
hapilon CLI
  → spawn pi 子进程（stdio: inherit）
  → 注入扩展（hpl-safety-gate + protected-paths）
  → pi 以用户完整权限运行
```

沙箱会在**更外层**包裹整个 hapilon 进程。hapilon 不需要自己实现——应该对接现有工具。

### 推荐策略

```
阶段 1（当前）：用户自己用 fence/nono/scode 包裹 hapilon
  → hapilon 零改动，用户在 .bashrc 里 alias hapilon='fence -t code -- hapilon'

阶段 2（后续）：hapilon 内置沙箱感知
  → hapilon --sandbox 自动检测平台，对接最佳沙箱后端
  → macOS: Seatbelt, Linux: Landlock/bubblewrap, Windows: WSL2
```

### 相关文档

- `_foresight.md`（已归档 → `_foresight/2-os-sandbox-solutions.md`）— P0.1 安全基础设施
- `Hapilon-PRD-v1.1.md` §9.16 — 权限与安全
- `src/extensions/hpl-safety-gate/` — 命令拦截（内层防御）
- `src/extensions/protected-paths/` — 文件保护（中层防御）

---

## 入门路线图

1. **理解概念**：OS 沙箱 vs 容器 vs 应用层拦截的区别
2. **在你的 macOS 上试用 fence**：`brew install fencesandbox/tap/fence && fence -t code -- hapilon`
3. **对比体验**：在沙箱内故意访问 `~/.ssh/`，观察被拦截
4. **阅读 _foresight.md 归档**：了解之前的安全设计决策
5. **决定时机**：当 hapilon 开始被用在多项目/多 provider 场景时，再考虑内置沙箱

---

## 常见陷阱

1. **sandbox-exec deprecated ≠ 不能用**：Apple 标记了但 macOS 15 仍正常工作。关注替代方案（AppContainer?），但当前可用
2. **Windows 原生沙箱几乎不存在**：行业共识是用 WSL2 运行 Linux 版沙箱。不要花时间找 Windows 原生方案
3. **沙箱 ≠ 万能**：沙箱防止 Agent 访问系统文件，但不防止 Agent 在项目目录里搞破坏。三层防御缺一不可
4. **凭证注入问题**：沙箱内 Agent 不能读 `~/.ssh/` 但需要调 API——怎么安全传递 API key？nono 的凭证代理是参考方案
5. **性能开销**：OS 原语（Seatbelt/Landlock）零开销，容器（Docker）有启动延迟，VM 有内存开销

---

## 参考资源

- [Ry Walker: Local AI Agent Sandboxes Compared](https://rywalker.com/research/local-agent-sandboxes) — 8 工具详细对比
- [awesome-AI-sandbox](https://github.com/webcoyote/awesome-AI-sandbox) — 100+ 沙箱工具清单
- [scode: A Seatbelt for AI Coding](https://binds.ch/blog/scode-sandbox-for-ai-coding-tools) — 最轻量的跨工具沙箱
- [nono](https://github.com/nono) — 凭证注入代理 + Landlock/Seatbelt
- [anthropic-sandbox-runtime](https://github.com/anthropics/sandbox-runtime) — Claude Code /sandbox 后台
