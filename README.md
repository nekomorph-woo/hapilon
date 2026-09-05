# hapilon

以 [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) 为运行内核的通用终端 Coding Agent。`hapilon` 与 `hapi` 双命令入口，行为完全一致。

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

> 为什么是 tarball 而不是 `npm install -g github:nekomorph-woo/hapilon`？npm 对 git 依赖的 `prepare` 是强沙箱（目标机无 devDeps、无 npx 重入、无嵌套 install，无法构建 dist），且 git 依赖实时解析在 express 5 嵌套依赖树上存在 npm reify bug。tarball 是构建完成的完整快照，两条坑都绕开。实测依据见下文「发版打包流程」。

## 发版打包流程

以下流程已脚本化（`scripts/release.sh`，细节见 `docs/distribution-sop.md`）：

```bash
./scripts/release.sh <patch|minor> "<一句话内容>"
```

自动完成：版本号升级 → build + 全量测试门禁（不绿即中止回滚）→ commit（含 dist）→ 附注 tag → push（HTTPS 失败自动回退 ssh）→ `npm pack` → `gh release create` 附 tarball → 清理。加 `--dry-run` 只打印将执行的命令。

手动流程（等价）：

### 1. 构建并测试

```bash
npm run build
npm test          # 全量测试必须绿
```

`dist/` 已入库（构建产物随仓库分发），确认提交的 dist 与 src 一致——改过源码必须重新 build 再提交。

### 2. 打 tarball

```bash
npm pack --pack-destination /tmp
# → /tmp/hapilon-<版本>.tgz（按 package.json 的 version 命名）
```

包内容 = `files: ["dist"]` 白名单 + package.json。不含源码与 node_modules；依赖在目标机安装时由 npm 从 registry 拉取。

### 3. 打 tag 并建 Release 附上 tarball

```bash
git tag v<X.Y.Z>
git push origin v<X.Y.Z>

gh release create v<X.Y.Z> /tmp/hapilon-<版本>.tgz --generate-notes --title "v<X.Y.Z>"
```

### 4. 升级（其他电脑）

```bash
npm install -g https://github.com/nekomorph-woo/hapilon/releases/download/v<X.Y.Z>/hapilon-<版本>.tgz
```

版本号在 `package.json` 的 `version` 字段；tarball 文件名必须与之同步。

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

### 开发版隔离运行（devhapi）

开发中的 hapilon 与正式安装版数据隔离：`scripts/setup-dev-alias.sh` 向 shell rc 幂等写入 `devhapi` 别名，数据目录指向 `~/.hapilon-dev`，不影响正式版的 `~/.hapilon`：

```bash
npm install && npm run build   # 换机器克隆后先构建
./scripts/setup-dev-alias.sh   # 写入别名（幂等，重复执行只更新）
source ~/.zshrc                # 或重开终端
devhapi setup && devhapi doctor
```

可选参数：`--alias <名>`、`--home <数据目录>`、`--rc <文件>`、`--remove` 移除。

- 源码 `src/`，扩展在 `src/extensions/`（`hpl-*` 自研 + npm 集成，见 `src/npm-extensions.ts` 的接线表）
- 工作流约定见 `CLAUDE.md` 与 `.claude/rules/`
- 任务/决策记录在 GitHub issues（issue-tracker 方式）

### 构建产物入库注意

`dist/` 随仓库分发（服务于 tarball 安装路径）。**提交源码改动时同步 `npm run build` 并提交 dist**，否则 Release tarball 装到的是旧代码。
