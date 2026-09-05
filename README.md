# HAPi

以 [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) 为运行内核的终端 Coding Agent。`hapilon` 与 `hapi` 双命令入口，行为完全一致。

## 安装

前置：Node.js ≥ 22.19。

从 GitHub Release 安装 tarball：

```bash
npm install -g https://github.com/nekomorph-woo/hapilon/releases/download/v<X.Y.Z>/hapilon-<版本>.tgz
```

首次使用：

```bash
hapilon setup    # 交互式配置 provider（API key、模型）
hapilon doctor   # 环境体检
hapilon          # 或 hapi —— 进入 TUI
```

用户数据（provider 配置、sessions、扩展配置）都在 `~/.hapilon/`，与安装目录分离——多台机器各自独立，升级 hapilon 不影响配置。

> 为什么是 tarball 而不是 `npm install -g github:nekomorph-woo/hapilon`？npm 对 git 依赖的 `prepare` 是强沙箱（目标机无 devDeps、无 npx 重入、无嵌套 install，无法构建 dist），且 git 依赖实时解析在 express 5 嵌套依赖树上存在 npm reify bug。tarball 是构建完成的完整快照，两条坑都绕开。

## 升级

```bash
npm install -g https://github.com/nekomorph-woo/hapilon/releases/download/v<新版本>/hapilon-<新版本号>.tgz
```

覆盖安装即可，`~/.hapilon/` 配置原样保留。版本号见 `package.json` 的 `version` 字段。

## 发版打包流程（开发机）

一条命令发版：

```bash
./scripts/release.sh <patch|minor> "<一句话内容>"
./scripts/release.sh --dry-run patch "..."   # 只打印将执行的命令
```

自动完成：版本号升级 → build + 全量测试门禁（不绿即中止回滚）→ commit（含 dist）→ 附注 tag → push（HTTPS 失败自动回退 ssh）→ `npm pack` → `gh release create` 附 tarball → 清理。

版本语义（0.x 阶段）：patch（`0.x.y`）= 修复与小调整；minor（`0.x`）= 一批新能力收敛。

### 手动流程（等价）

```bash
npm run build && npm test                      # 1. 构建并全量测试（必须绿）
npm pack --pack-destination /tmp               # 2. 打 tarball → /tmp/hapilon-<版本>.tgz
git tag -a v<X.Y.Z> -m "v<X.Y.Z>" && git push origin v<X.Y.Z>   # 3. tag + push
gh release create v<X.Y.Z> /tmp/hapilon-<版本>.tgz --generate-notes --title "v<X.Y.Z>"   # 4. Release 附 tarball
```

包内容 = `files: ["dist"]` 白名单 + package.json。不含源码、测试与 node_modules；依赖在目标机安装时由 npm 从 registry 拉取。

### 沙箱验证（可选，不动开发机环境）

发布前验证「tarball → 安装 → 运行」链路，npm 全局目录、缓存、HOME 全部重定向到临时沙箱：

```bash
./scripts/sandbox-verify.sh          # 打包 + 沙箱安装 + 双 bin/版本/doctor 验证 + 清理
./scripts/sandbox-verify.sh --keep   # 保留沙箱目录供检查
```

## 常用命令

| 命令 | 用途 |
|---|---|
| `hapilon` / `hapi` | 进入 TUI（同文件双入口） |
| `hapilon setup` | 交互式初始化配置 |
| `hapilon doctor` | 环境体检 |
| `hapilon --version` / `-v` | 查看 hapilon 版本 |
| `hapilon mcp add <name> stdio\|http ...` | 添加 MCP server（写 `~/.hapilon/agent/mcp.json`） |
| `hapilon mcp list` / `remove <name>` | 列出 / 移除 MCP server |
| `hapilon config show` | 查看配置 |

TUI 内常用 slash command：`/econ`（bash 输出压缩开关）、`/simplify`（事后代码清理：check → 人工裁决 → apply）、`/ponytail lite|full|ultra|off`（极简编码强度）、`/context`（上下文面板）。

## 开发

```bash
npm install
npm run dev        # build + 启动
npm run typecheck
npm test           # 全量（build 后跑 dist 测试）
```

- 源码 `src/`，扩展在 `src/extensions/`（`hpl-*` 自研 + npm 集成，见 `src/npm-extensions.ts` 的接线表）
- 任务/决策记录在 GitHub issues

### 开发版隔离运行（devhapi）

开发中的 hapilon 与正式安装版数据隔离：`scripts/setup-dev-alias.sh` 向 shell rc 幂等写入 `devhapi` 别名，数据目录指向 `~/.hapilon-dev`，不影响正式版的 `~/.hapilon`：

```bash
npm install && npm run build   # 换机器克隆后先构建
./scripts/setup-dev-alias.sh   # 写入别名（幂等，重复执行只更新）
source ~/.zshrc                # 或重开终端
devhapi setup && devhapi doctor
```

可选参数：`--alias <名>`、`--home <数据目录>`、`--rc <文件>`、`--remove` 移除。

### 构建产物入库注意

`dist/` 随仓库分发（服务于 tarball 安装路径）。**提交源码改动时同步 `npm run build` 并提交 dist**，否则 Release tarball 装到的是旧代码。
