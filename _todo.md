# TODO 清单

> 当前任务：P0 安全基础设施增强 — 写保护分层 + 会话白名单

---

## [~] TODO-5：危险命令拦截扩展 (safety-gate.ts)

### 目标

创建一个 Pi 内置扩展，通过 `pi.on("tool_call", ...)` 拦截 bash 工具中的危险命令，按风险等级采用不同策略：高危直接阻止，中危弹确认框。

### 实现要点

| 项目 | 内容 |
|------|------|
| 扩展文件 | `src/extensions/safety-gate.ts` |
| 拦截机制 | `pi.on("tool_call", ...)` 拦截 `bash` 工具调用 |
| 高危命令（block） | `rm -rf /`、`sudo rm`、`mkfs.*`、`dd of=/dev/*`、`:(){ :\|:& };:`、`chmod 777 /`、`chown -R /`、`> /dev/sda` |
| 中危命令（confirm） | `rm -rf`（非根）、`git push --force`、`git push --force-with-lease`、`curl ... \| sh`、`chmod 777`（非根）、`git reset --hard`（有远程）、`docker rm -f`、`eval` |
| Shell 技巧检测（block） | 命令中包含 `` ` ``、`$(`、`<( `、`>( ` — 可疑的命令注入/绕过 |
| 确认框 | 使用 `ctx.ui.confirm("message", { title: "⚠️ 危险操作" })` |
| 绕过开关 | 支持 `--no-safety` CLI 标志跳过所有安全检查 |

### 验收标准

- [x] 高危命令（如 `sudo rm -rf /`）被直接阻止，Agent 收到 block reason
- [x] 中危命令（如 `rm -rf ./node_modules`）弹出确认框，用户可选择 Allow/Deny
- [x] Shell 注入技巧被检测并阻止
- [x] 正常 bash 命令不受影响
- [x] `--no-safety` 标志可绕过所有安全检查
- [x] hapilon 启动时自动加载
- [x] 单元测试覆盖 213 例

---

## [~] TODO-6：文件路径保护扩展 (protected-paths.ts)

### 目标

创建一个 Pi 内置扩展，拦截 write/edit 工具对敏感路径的写入操作，保护关键文件不被误修改。

### 验收标准

- [x] 对 `.env` 等文件的 write/edit 被直接阻止
- [x] 对 `~/.ssh/id_rsa` 的 read 弹出确认框
- [x] 对普通文件不受影响
- [x] `--no-safety` 标志绕过所有路径保护
- [x] symlink 解析防护
- [x] 单元测试覆盖 30 写保护 + 7 读保护模式

---

## [~] TODO-7：启动安全提示

### 验收标准

- [x] 首次 `hapilon` 启动显示安全声明
- [x] 再次启动不重复显示
- [x] `-p` 静默模式不显示
- [x] `--no-safety` 时也展示告知性提示
- [x] `config.json` 中 `safetyNoticeShown` 持久化

---

## [ ] TODO-8：写保护分层 + /allow 会话白名单

### 目标

将 protected-paths.ts 的写保护从统一 block 改为分层策略（高危 block + 中危 confirm），并新增 `/allow` 命令提供会话级临时写白名单，**读写均生效**。

### 实现要点

| 项目 | 内容 |
|------|------|
| 分层策略 | `WRITE_PROTECTED` 拆为 `WRITE_BLOCK`（~12 类硬阻止）+ `WRITE_CONFIRM`（~6 类弹确认） |
| 硬 block | SSH 密钥/目录、`~/.aws/*`、凭证精确路径、证书后缀、`.git/config`、`.git/hooks/*` |
| confirm（写） | `.env*` 系列、9 种锁文件、`.github/workflows/*`、`.gitlab-ci.yml`、`.gitmodules`、`*.kubeconfig` |
| /allow 命令 | `pi.registerCommand("safety-allow", ...)` 三子命令 |
| 白名单存储 | 模块级 `Set<string>`，存解析后的绝对路径，session 结束时自动清除 |
| 白名单覆盖 | **读写均生效** — 写保护跳过 block/confirm，读保护跳过 confirm |
| 命令接口 | `/allow <path>` 加白名单、`/allow --list` 列出、`/allow --clear` 清空 |
| handler 检查顺序 | 白名单 → block → confirm（写）/ confirm（读） |

### 验收标准

- [ ] `classifyPath` 返回 `"block"` / `"confirm"` / `"allow"` 三级（写保护不再一律 block）
- [ ] `.env` 写入弹出确认框（非 block），批准后可写入
- [ ] `~/.ssh/id_rsa` 写入仍然硬 block
- [ ] `/allow .env` 后 `.env` 写操作静默放行（不弹确认）
- [ ] `/allow ~/.ssh/id_rsa` 后仍可覆盖 block 路径（用户显式操作）
- [ ] `/allow` 对读保护也生效：白名单路径 read 不再弹确认
- [ ] `/allow --list` 列出当前白名单
- [ ] `/allow --clear` 清空白名单
- [ ] 白名单仅当前 session 有效，重启 hapilon 后失效
- [ ] 非交互模式下 confirm 写降级为 block（安全侧）
- [ ] 单元测试覆盖分层 block/confirm、白名单读写生效、白名单 CRUD
