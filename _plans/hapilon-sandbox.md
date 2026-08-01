# hapilon --sandbox — OS 沙箱集成计划

## Context

当前 hapilon 的安全层只有应用级拦截（hpl-safety-gate + protected-paths），缺少 OS 内核级兜底。集成 `@anthropic-ai/sandbox-runtime`（Claude Code /sandbox 后台，Apache-2.0），在 macOS 上用 Seatbelt、Linux 上用 bubblewrap，为 Pi 子进程提供内核级隔离。

## 核心原则

1. **最小改动**：只在 cli.ts spawn 前插入 SandboxManager，不侵入扩展逻辑
2. **平台降级**：macOS 优先（零安装），Linux 需装 bubblewrap，Windows 打印提示
3. **独立于现有安全层**：`--sandbox` 和 `--no-safety` 正交

## 文件变更

| 文件 | 变更 |
|------|------|
| `package.json` | 新增依赖 `@anthropic-ai/sandbox-runtime` |
| `src/cli.ts` | 新增 `--sandbox` flag + 平台检测 + SandboxManager 包裹 |
| `src/help.ts` | 新增 `--sandbox` 帮助说明 |

## 实现步骤

### Step 1：安装依赖

```bash
npm install @anthropic-ai/sandbox-runtime
```

→ verify: `npm ls @anthropic-ai/sandbox-runtime`

### Step 2：在 cli.ts 添加 --sandbox 检测和沙箱初始化

**集成点**：`spawn(pi)` 调用之前。

```typescript
// cli.ts，spawn pi 之前
const noSandbox = hasFlag(args, "--no-sandbox"); // 预留，暂不需要

if (hasFlag(args, "--sandbox")) {
  const platform = process.platform; // 'darwin' | 'linux' | 'win32'
  
  if (platform === 'win32') {
    console.warn("⚠ --sandbox 暂不支持 Windows。使用命令+文件策略保护。");
  } else {
    // 动态 import，不影响正常启动速度
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    
    await SandboxManager.initialize({
      filesystem: {
        denyRead: ["~/.ssh", "~/.aws", "~/.netrc"],
        allowWrite: [".", "/tmp"],
        denyWrite: [".env", ".git/config"],
      },
      network: {
        allowedDomains: ["*"],
      },
    });
    
    // 包裹 spawn 命令
    const cmdStr = [process.execPath, piCli, ...extensionFlags, ...piArgs]
      .map(a => a.includes(" ") ? `"${a}"` : a).join(" ");
    const sandboxedCmd = await SandboxManager.wrapWithSandbox(cmdStr);
    
    const child = spawn(sandboxedCmd, { shell: true, stdio: "inherit", cwd: process.cwd(), env: {...} });
    // ... 事件处理同上
    return; // 提前返回，不走下面的 spawn
  }
}

// 原有的 spawn 逻辑不变
const child = spawn(process.execPath, [piCli, ...extensionFlags, ...piArgs], {...});
```

**注意**：SandboxManager 的 `wrapWithSandbox` 返回的是一个 shell 命令字符串（如 `sandbox-exec -f ... node ...`），所以 spawn 的参数格式变了——从 `spawn(cmd, args[])` 变成 `spawn(cmdStr, { shell: true })`。

**平台检测**：
- `darwin` → Seatbelt（系统内置）
- `linux` → bubblewrap（打印提示：需预装 bubblewrap/socat/ripgrep）
- `win32` → 打印提示降级

→ verify: macOS 上 `hapilon --sandbox` 启动，`cat ~/.ssh/id_rsa` 返回 Operation not permitted

### Step 3：更新 help.ts

```typescript
// help.ts，选项区域新增
  --sandbox     OS 内核级沙箱隔离（macOS/Linux）
```

→ verify: `hapilon help` 显示 `--sandbox` 说明

### Step 4：构建验证

```bash
npm run build
ls node_modules/@anthropic-ai/sandbox-runtime  # 确认依赖存在
```

→ verify: 构建通过

## 关键风险

| 风险 | 缓解 |
|------|------|
| sandbox-runtime 是 Beta Research Preview，API 可能变 | 锁定版本号，升级时回归测试 |
| Linux 用户未装 bubblewrap → 沙箱无法启动 | 启动时检测 bwrap 是否存在，不存在则打印安装提示并退出 |
| macOS 上 sandbox-exec 可能被 Apple 移除 | 目前 macOS 15 仍可用，关注 WWDC 动态 |
| spawn 参数格式变化可能引入 bug | 仅 --sandbox 时走新路径，默认路径不变 |

## 验收标准

- [ ] `npm install @anthropic-ai/sandbox-runtime` 成功
- [ ] `hapilon --sandbox` macOS 上 Seatbelt 沙箱启动
- [ ] 沙箱内 Agent 尝试读 `~/.ssh/` → Operation not permitted
- [ ] 沙箱内 Agent 正常读写项目目录文件
- [ ] `hapilon`（不加 --sandbox）行为不变
- [ ] `hapilon --sandbox --no-safety` 两 flag 独立工作
- [ ] Linux 上 `hapilon --sandbox` 用 bubblewrap（需预装依赖）
- [ ] Windows 上 `hapilon --sandbox` 打印提示并降级
- [ ] `hapilon help` 显示 `--sandbox` 说明
