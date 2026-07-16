# TODO 清单

> 当前任务：项目级安全配置 + /allow 持久化信任

---

## [ ] TODO-9：项目级 .hapilon/ 配置目录

### 目标

参考 Claude Code 的 `.claude/` 项目级目录，为 hapilon 创建项目级 `.hapilon/` 配置目录，存放项目专属安全配置。类似 Claude Code 的 `settings.local.json`——只在当前项目维度生效，不存在于用户目录 `~/.hapilon/`。

### 实现要点

| 项目 | 内容 |
|------|------|
| 目录位置 | 项目根目录下的 `.hapilon/`（如 `/project/.hapilon/`） |
| 对标参考 | Claude Code `.claude/settings.json`（提交）+ `.claude/settings.local.json`（不提交） |
| 文件结构 | `config.json`（提交，团队共享）+ `config.local.json`（不提交，个人本地覆盖） |
| 同名覆盖 | 项目级 `config.json` 覆盖用户级 `~/.hapilon/config.json` 同名配置；项目级 `config.local.json` 覆盖项目级 `config.json` 同名配置 |
| allow 数据 | 存储在 `config.local.json` 中，不单独建 `allow.json` |
| .gitignore | `.hapilon/config.local.json` 加入 `.gitignore`，`config.json` 可提交 |

### 验收标准

- [ ] 项目根目录下存在 `.hapilon/` 目录
- [ ] `hapilon` 在任意项目目录启动时，自动检测该项目的 `.hapilon/`
- [ ] `.hapilon/` 配置与 `~/.hapilon/` 不冲突（项目级覆盖用户级）
- [ ] `.gitignore` 默认忽略 `.hapilon/`（或提供说明让用户决定）

---

## [ ] TODO-10：/allow 持久化信任 — session 级 + 项目级（命令+路径维度）

### 目标

增强 confirm 弹框，除了"同意一次"和"拒绝"，新增"当前 session 不再询问"和"本项目不再询问"。信任维度从单纯的路径，扩展为**命令 + 路径**——比如 `/allow` 记录的不只是 `.env` 这个文件，而是"write .env"这个行为。

### 实现要点

| 项目 | 内容 |
|------|------|
| confirm 弹框选项 | Allow Once / Deny / Allow Session（不再询问）/ Allow Project（不再询问） |
| 信任维度 | **命令 + 路径**（如 `write:.env`、`bash:rm -rf node_modules`）而非仅路径 |
| session 级信任 | 内存中 `Map<string, Set<string>>`，存 command → allowedPaths，session 结束清除。目前 `/allow` 的白名单升级至此 |
| 项目级信任 | 持久化到 `.hapilon/config.local.json` 的 `allow` 字段 |
| 存储格式 | `config.local.json` → `{ "allow": { "write": [".env"], "bash": ["rm -rf node_modules"] } }` |
| 安全约束 | 项目级 trust 仅对 **confirm** 生效（中危），对 **block**（高危）永远不生效——block 路径需要每次显式 `/allow` |
| 用户不可见 | 项目级 trust 只能通过 confirm 弹框选择"本项目不再询问"来写入，没有手动编辑命令 |

### 触发场景

**A. tool_call 拦截 confirm 时自动弹出（4 选项）**

```
Agent 执行 write .env
  → safety-gate 或 protected-paths 拦截到 confirm 判决
  → 自动调用 ctx.ui.select() 弹出 4 选项
  → 用户选择后执行对应策略
```

**B. 用户主动 /allow（直接加白，不弹框）**

```
/allow .env          → 加入 session 白名单，静默完成
/allow --list        → 列出 session + 项目级白名单
/allow --clear       → 清空 session 白名单，不影响项目级
```

> **注意**：Pi 的 `ctx.ui.confirm()` 只支持二元（true/false），4 选项需要用
> `ctx.ui.select(title: string, options: string[])`，返回用户选中的选项字符串。

### 交互示例

```
⚠️ 写入确认

Agent 正在尝试写入受保护文件：

> .env

类型：中危路径
命令：write

[Allow Once]  [Allow this Session]  [Allow this Project]  [Deny]
```

| 选项 | 效果 | 存储位置 |
|------|------|----------|
| Allow Once | 仅本次放行 | 不存储 |
| Allow this Session | 当前 session 内同一命令+路径不再询问 | 内存 Map |
| Allow this Project | 持久化，后续所有 session 不再询问 | `.hapilon/config.local.json` |
| Deny | 拒绝本次 | 不存储 |

### 验收标准

- [ ] `ctx.ui.select()` 替代 `ctx.ui.confirm()` 实现 4 选项弹框
- [ ] **自动弹框**：tool_call 拦截 confirm 时自动弹出 4 选项
- [ ] **手动 /allow**：直接加入 session 白名单，不弹框
- [ ] Allow Session 后，当前 session 内同一命令+路径不再询问
- [ ] Allow Project 后，持久化到 `.hapilon/config.local.json`，后续 session 不再询问
- [ ] Block 路径不受项目级 trust 影响——必须每次 `/allow` 显式放行
- [ ] `.hapilon/config.local.json` 格式正确：`{ "allow": { "<toolName>": ["<pattern>", ...] } }`
- [ ] 命令和路径两个维度独立匹配——write .env 被信任不意味着 read .env 也被信任
- [ ] `/allow --list` 显示当前 session + 项目级全部白名单
- [ ] `/allow --clear` 清空 session 级，不影响项目级
- [ ] 非交互模式下项目级 trust 仍生效，session 级不生效（无 session 概念）
- [ ] 单元测试覆盖 4 选项行为、双触发场景、session/项目级持久化、命令+路径维度匹配
