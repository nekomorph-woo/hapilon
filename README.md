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

## Windows Terminal 换行键

Windows Terminal 经 ConPTY 传输按键，Enter 与 Shift+Enter 送出同一个 `\r`，Ctrl+J 也被上报为 Enter（WT 已知问题 #6912 / #18852）——所以 `Shift+Enter`/`Ctrl+J` 在 Windows 上都会直接发送。两条可行路径：

- **零配置**：输入 `\` 再按 Enter（内置兜底，任何终端都可用）
- **推荐**：给 Windows Terminal 加一条 sendInput 动作（设置 → 打开 JSON 文件，加到 `actions` 数组里，改完完全退出重启终端）

```json
{
  "actions": [
    {
      "command": { "action": "sendInput", "input": "\u001b[13;2u" },
      "keys": "shift+enter"
    }
  ]
}
```

WSL 里同样适用（sendInput 原样透传序列）。若 hapilon 跑在 herdr pane 内而该 pane 又展平了序列，回退到 `\` + Enter。

## 升级

```bash
npm install -g https://github.com/nekomorph-woo/hapilon/releases/download/v<新版本>/hapilon-<新版本号>.tgz
```

覆盖安装即可，`~/.hapilon/` 配置原样保留。版本号见 `package.json` 的 `version` 字段。

## 主题与 pi 补丁

内置 `hapilon-dark` / `hapilon-light` 两套主题（绿系 accent，与 artifact 交付物的设计宪法同族）。没选过主题时，默认种子为 `hapilon-light/hapilon-dark` 配对语法——跟随终端明暗自动切换；`/settings` 里可随时换。

代码块底色来自 `mdCodeBlockBg` 颜色 token，而上游 pi-tui 的 markdown 渲染没有代码块背景通道（颜色 token 只有前景）。hapilon 因此在安装时（postinstall）与每次启动时对 pi 包做**幂等字符串补丁**（`src/patch/ensure-pi-patch.ts`）：新增 `mdCodeBlockBg` 背景通道，并隐藏代码块围栏。补丁可重复执行，已打过即只读判标记。

补丁锚点按 `pi-coding-agent` 0.85.1 的代码字符串写死。pi 大版本重构后锚点会失配——此时 hapilon 启动会打印 `⚠ pi 已升级，代码块背景补丁未应用` 警告并**优雅降级**：主题仍然生效，围栏与底色同色故视觉隐形，只是失去背景色块，其余功能完全不受影响。修复方式是对照新版 pi 源码更新 `src/patch/ensure-pi-patch.ts` 的锚点表，重新发版。

> 开发环境提示：本仓库 `npm ci` 需要 `--legacy-peer-deps`。`@zhushanwen/pi-ask-user` 的 peer 声明 `pi@^0.84.1` 落后于根依赖，npm 会 ERESOLVE 报错——属上游待升问题，不是本地配置错误。

## 危险命令防护

bash 工具调用先过安全门（`hpl-safety-gate`）分类为 block / confirm / allow，另有敏感路径保护与可选 OS 沙箱。

分类只看「真正的命令」，不误伤搜索词：

- **引号内容不参与匹配**——`grep -n "shutdown" file`、`git commit -m "fix git push"` 正常放行
- **只读命令整体跳过**（grep/rg/find/ls/cat/ps/jq…）——`rg -n "chmod 777"` 不弹窗；破坏性用法（`find -exec rm`、`find -delete`）仍由目标规则拦住
- **命令替换递归判定**——`S=$(ls -t dir | head -1)` 放行，`echo $(shutdown -h now)` 与 `rm -rf $(echo /)` 拦截；`sh -c "…"` 与 `eval "…"` 的脚本载荷同样递归检查
- **SQL 关键字只对数据库客户端生效**——`psql -c "DROP TABLE t"` 弹确认，`grep -c "DROP TABLE" schema.sql` 放行

## herdr 集成

在 herdr pane 内运行时，hapilon **以自己的身份 `hapi`** 向 herdr 上报（herdr 官方自定义集成协议）：

- **身份**：pane 在 `herdr agent list` / 侧边栏里是 `hapi`，不再是 `pi`
- **状态**：从进程内部上报，不再靠屏幕抓取——`working` / `idle` / `blocked`（后者来自 pi 的阻塞式 UI prompt 事件，比屏幕匹配可靠）
- **不再加载 herdr 的 pi 集成**：否则 herdr 会按 pi 的恢复命令处理，服务器重启时用 `pi --resume` 拉起裸 pi，hapilon 的能力（系统提示、安全门、角色、补丁）全丢。需要旧行为时设 `HAPILON_HERDR_PI_INTEGRATION=1`

因此需要知晓的 herdr 现状：

| 命令 | 对 hapi 可用性 |
| --- | --- |
| `herdr agent get/list/read/wait/rename/focus/attach/explain` | ✅ 可用 |
| `herdr pane send-text` / `pane send-keys` | ✅ 可用（派发与清空走这里） |
| `herdr agent prompt` / `agent send-keys` | ❌ 以 `agent_not_ready` 拒绝——herdr 只对原生识别的 agent 类型开放；hapilon 的自动派发已改为 pane 级输入 |
| 服务器重启自动恢复 pane | ❌ 新 agent 类型的启动/恢复命令编在 herdr 二进制里，需上游支持 |

## 发版打包流程（开发机）

一条命令发版：

```bash
./scripts/release.sh <patch|minor> "<一句话内容>"
./scripts/release.sh --notes <文件> patch "..."   # 自定义 Release 说明全文（首发/重大版本）
./scripts/release.sh --dry-run patch "..."   # 只打印将执行的命令
```

自动完成：版本号升级 → 依赖精确锁定检查（`^`/`~` 范围直接拒绝）→ build + 全量测试门禁（不绿即中止回滚）→ commit（含 dist）→ 附注 tag → push（HTTPS 失败自动回退 ssh）→ `npm pack` → **全新安装冒烟验证**（隔离环境真装一遍：版本号 + 补丁钩子）→ `gh release create` 附 tarball → 清理。

冒烟验证是 v0.4.0 事故的产物：依赖范围在用户全新安装时会漂移到未验证版本、运行时 pi-tui 嵌套副本未打补丁——包能装但能力失效。任何检查不过都不上 Release。

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
