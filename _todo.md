# TODO 清单

> 当前任务：P0 安全基础设施

---

## [ ] TODO-5：危险命令拦截扩展 (safety-gate.ts)

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

### 混合策略

```
高危 ──→ block（返回 { block: true, reason: "..." }）
中危 ──→ ctx.ui.confirm() 弹确认框
安全 ──→ 直接放行
```

### 验收标准

- [ ] 高危命令（如 `sudo rm -rf /`）被直接阻止，Agent 收到 block reason
- [ ] 中危命令（如 `rm -rf ./node_modules`）弹出确认框，用户可选择 Allow/Deny
- [ ] Shell 注入技巧（`` `cmd` ``、`$(cmd)`、`eval`）被检测并阻止
- [ ] 正常 bash 命令（`ls`、`npm test`、`git status`）不受影响
- [ ] `--no-safety` 标志可绕过所有安全检查
- [ ] hapilon 启动时自动加载（通过 `discoverExtensions()`）
- [ ] 单元测试覆盖：高危阻止、中危确认、正常放行、shell 技巧检测、绕过开关
- [ ] 阻止时返回清晰的 reason 信息，不静默阻止

---

## [ ] TODO-6：文件路径保护扩展 (protected-paths.ts)

### 目标

创建一个 Pi 内置扩展，拦截 write/edit 工具对敏感路径的写入操作，保护关键文件不被误修改。

### 实现要点

| 项目 | 内容 |
|------|------|
| 扩展文件 | `src/extensions/protected-paths.ts` |
| 拦截机制 | `pi.on("tool_call", ...)` 拦截 `write` 和 `edit` 工具调用 |
| 写保护路径（block） | `.env`、`.env.local`、`.env.production`、`package-lock.json`、`yarn.lock`、`pnpm-lock.yaml`、`.git/config`、`.git/hooks/*`、`*.pem`、`*.key`、`id_rsa*`、`~/.ssh/*`、`~/.aws/*` |
| 读保护路径（confirm） | `~/.ssh/*`、`~/.aws/credentials`、`~/.config/gcloud/*`（避免 Agent 偷看密钥） |
| 确认框 | 写操作 → block；读敏感文件 → confirm |
| 绕过开关 | `--no-safety` 标志可绕过 |

### 验收标准

- [ ] 对 `.env` 文件的 write/edit 被直接阻止
- [ ] 对 `~/.ssh/id_rsa` 的 read 弹出确认框
- [ ] 对普通文件（`src/app.ts`、`README.md`）的 write/edit 不受影响
- [ ] `--no-safety` 标志绕过所有路径保护
- [ ] hapilon 启动时自动加载（通过 `discoverExtensions()`）
- [ ] 单元测试覆盖：写保护阻止、读保护确认、正常文件放行、路径匹配规则、绕过开关
- [ ] 阻止时返回清晰的 reason 信息

---

## [ ] TODO-7：启动安全提示

### 目标

hapilon 首次启动时向用户展示安全声明，告知哪些操作会被拦截、如何绕过。

### 实现要点

| 项目 | 内容 |
|------|------|
| 触发条件 | 首次启动 hapilon 时（通过 `~/.hapilon/config.json` 中的 flag 判断） |
| 提示内容 | hapilon 内置安全扩展已激活：危险命令拦截 + 文件路径保护 |
| 绕过说明 | `--no-safety` 可临时关闭所有安全检查 |
| 持久标记 | 首次展示后写入标记，不再重复提示 |
| 静默模式 | `-p`/`--print` 模式不显示安全声明 |

### 验收标准

- [ ] 全新安装后首次 `hapilon` 启动显示安全声明
- [ ] 再次启动 hapilon 不重复显示
- [ ] `hapilon -p "..."` 静默模式下不显示
- [ ] 安全声明内容清晰、简洁（2-3 行），列出被保护的内容
- [ ] 安全声明包含绕过方式说明
