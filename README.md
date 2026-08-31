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

每次发布版本时，在开发机上打包并附到 GitHub Release。

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

发布前想在本地验证安装链路时，把 npm 的全局目录与缓存重定向到临时沙箱：

```bash
ISOL=~/.hapilon-install-sandbox
rm -rf $ISOL && mkdir -p $ISOL/prefix $ISOL/cache
env NPM_CONFIG_PREFIX=$ISOL/prefix NPM_CONFIG_CACHE=$ISOL/cache \
  npm install -g /tmp/hapilon-<版本>.tgz

# 试运行（node 用开发机的即可，包在沙箱里）
node $ISOL/prefix/lib/node_modules/hapilon/dist/cli.js --version
node $ISOL/prefix/lib/node_modules/hapilon/dist/cli.js doctor

# 验证完清理
rm -rf $ISOL
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

- 源码 `src/`，扩展在 `src/extensions/`（`hpl-*` 自研 + npm 集成，见 `src/npm-extensions.ts` 的接线表）
- 工作流约定见 `CLAUDE.md` 与 `.claude/rules/`
- 任务/决策记录在 GitHub issues（issue-tracker 方式）

### 构建产物入库注意

`dist/` 随仓库分发（服务于 tarball 安装路径）。**提交源码改动时同步 `npm run build` 并提交 dist**，否则 Release tarball 装到的是旧代码。
