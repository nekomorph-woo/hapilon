# TODO-9/10 统一实现计划：项目级 .hapilon/ 配置 + /allow 持久化信任

## Context

当前 hapilon 的安全配置和数据流通如下：

```
~/.hapilon/config.json  ──→  config-io.ts::readHapilonConfig()
                                └── injectDefaultArgs() → spawn pi

hpl-protected-paths/
  confirm.ts    → ctx.ui.confirm()  二元 (yes/no)
  whitelist.ts  → Set<string>       仅路径维度，session 级内存
  index.ts      → tool_call 钩子 + /allow 命令

hpl-safety-gate/
  index.ts      → ctx.ui.confirm()  内联二元，无信任机制
```

存在两个结构性问题：
1. **无项目级配置**：所有配置都在 `~/.hapilon/` 下，无法实现团队共享或个人项目覆盖。
2. **信任维度不足**：whitelist 只是 `Set<string>`（路径），缺少命令维度；且全为 session 级，每次启动丢失。

TODO-9（项目级配置目录）是 TODO-10（持久化信任）的存储基础设施，两者必须统一设计。

## 核心原则

1. **存储分层，查询统一**：session 信任在内存，项目信任在文件，但通过统一的 `trust-store.ts` 查询，调用方不需要关心数据在哪。
2. **安全降级不可逆**：项目级 trust 仅对 confirm（中危）生效；block（高危）必须 session 级显式 `/allow` 且需**高危二次确认**（`requestHighRiskConfirm`，2 选项：Allow this Session / Deny），不可通过项目配置永久绕过。已落地（2026-08-01，issue #10）。
3. **最小改动面**：`classifyPath()` / `classifyCommand()` 等纯函数不改签名；confirm 弹框升级为 4 选项但调用方接口变化最小化。
4. **纯函数可测**：文件 I/O 和处理逻辑分离，所有核心逻辑可脱离 ExtensionContext mock 独立测试。

## 架构决策

### 决策 1：whitelist.ts 升级 vs 新建 trust-store.ts

**方案 A（选择）**：新建 `trust-store.ts`，保留 `whitelist.ts` 仅用于 `/allow` 命令兼容。

`whitelist.ts` 保留现有 `Set<string>` API，但内部转为代理到 `trust-store.ts`（通过 `addPathAllow`，对所有工具同时加信任）。`trust-store.ts` 用 `Map<string, Set<string>>` 存储 command+path 双维度信任，同时支持 session 和 project 两个层级。

**方案 B（不选）**：直接修改 `whitelist.ts` 升级为 `Map<string, Set<string>>`。

**取舍理由**：
- `whitelist.ts` 被 `/allow` 命令和测试直接使用，修改签名会形成大型变更
- `/allow` 命令的用户语义是"信任这个路径的所有操作"，用 `addPathAllow` 更自然
- `trust-store.ts` 是全新模块，职责清晰，session + project 两级信任统一管理
- 方案 A 使得两个扩展（hpl-safety-gate 和 hpl-protected-paths）都能独立使用信任存储，不依赖 hpl-protected-paths 的模块

### 决策 2：confirm.ts 放在哪里供 hpl-safety-gate 共享

**方案 A（选择）**：`confirm.ts` 保留在 `hpl-protected-paths/` 目录，hpl-safety-gate 通过 `../hpl-protected-paths/confirm.js` 路径导入。

**方案 B（不选）**：将 `confirm.ts` 提升到 `src/extensions/confirm.ts` 作为共享模块。

**取舍理由**：
- `src/extensions/` 下的 `.js` 文件会被 `discoverExtensions()` 扫描为独立扩展（需要是 `export default function(pi)` 格式），`confirm.ts` 不符合这个契约
- 放在子模块 (`hpl-protected-paths/`) 下不受扫描规则影响
- 跨扩展导入用相对路径是标准做法（Node.js ESM 模块解析）

### 决策 3：项目级配置的加载时机

**方案 A（选择）**：在 `cli.ts` 默认启动路径（spawn pi 之前）检测项目 `.hapilon/` 并初始化信任存储。

```typescript
// cli.ts 默认启动路径，spawn 之前
const projectCwd = process.cwd();
initProjectTrust(projectCwd);
```

**方案 B（不选）**：在扩展的 `pi.on("session_start")` 事件中延迟加载。

**取舍理由**：
- trust-store 是 Node.js 进程级模块（非 Pi 扩展内部状态），需要在两个扩展之间共享
- 如果延迟到 session_start 才加载，可能在第一个 tool_call 时项目级信任尚未就绪
- cli.ts 启动时 `process.cwd()` 就是项目目录，此时加载是最早且最可靠的时机
- Pi 扩展的 session 级别状态无法跨扩展共享

### 决策 4：ConfirmResult 类型设计

**方案 A（选择）**：在 `approved` 状态上附加 `scope` 字段。

```typescript
export type ConfirmResult =
  | { status: "approved"; scope: "once" | "session" | "project" }
  | { status: "rejected" }
  | { status: "unavailable" }
  | { status: "error"; message: string };
```

**方案 B（不选）**：拆分为独立状态值 `approved_once | approved_session | approved_project`。

**取舍理由**：
- 方案 A 保持了 `status === "approved"` 的向后兼容性
- 将 scope 作为独立字段，未来如有 `approved_forever` 等新选项只需扩展 scope 联合类型
- 方案 B 虽然更"类型安全"但要求所有现有 `status === "approved"` 检查处都更新

### 决策 5：`.hapilon/` 目录是否自动加入 `.gitignore`

**方案 A（选择）**：`writeProjectLocalConfig()` 首次写入时，如果项目存在 `.gitignore` 但不包含 `.hapilon/config.local.json`，通过 console.warn 提示用户手动添加。

**方案 B（不选）**：自动修改项目的 `.gitignore` 文件。

**取舍理由**：
- 自动修改用户文件是隐性操作，不符合"手术式修改"原则
- `.gitignore` 格式多变（已有注释、分组），自动追加可能破坏格式
- 提示用户手动添加让用户意识到这个文件不被提交，增强安全意识
- 方案 A 遵循 Fail Fast 原则：不静默修改用户文件

## 文件变更清单

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/project-config.ts` | 项目级 `.hapilon/` 目录检测、config.json / config.local.json 读写、三级配置合并 |
| `src/extensions/trust-store.ts` | 统一信任存储：`Map<toolName, Set<target>>` 双层级 (session/project)；export `isTrusted` / `addTrust` / `addPathAllow` / `clearSessionTrust` / `listTrust` / `isSessionTrusted` / `initProjectTrust` |
| `src/test/unit/project-config.test.ts` | 项目配置读写、合并优先级、信任序列化/反序列化测试 |
| `src/test/unit/trust-store.test.ts` | 信任存储双维度：命令+路径匹配、session 隔离、project 持久化、block 不受 project 影响 |

### 修改文件

| 文件 | 变更内容 |
|------|----------|
| `src/extensions/hpl-protected-paths/confirm.ts` | `requestConfirm()` 重写：`ctx.ui.confirm()` → `ctx.ui.select()` 4 选项；ConfirmResult 新增 scope 字段 |
| `src/extensions/hpl-protected-paths/whitelist.ts` | 内部转发到 trust-store.ts 的 `addPathAllow`；保持旧 API 签名兼容性 |
| `src/extensions/hpl-protected-paths/index.ts` | tool_call 钩子接入 trust-store：confirm 前置检查信任 → 无信任则弹 4 选项 → 根据 scope 写入 trust；`/allow` 命令改用 trust-store |
| `src/extensions/hpl-safety-gate/index.ts` | bash confirm 接入 trust-store：confirm 前置检查信任 → 无信任则弹 4 选项 → 根据 scope 写入 trust |
| `src/cli.ts` | 默认启动路径新增 `initProjectTrust(process.cwd())` 调用；导入 project-config.ts |
| `src/test/unit/hpl-protected-paths.test.ts` | 更新白名单测试适配 Map 结构；新增信任维度测试 |
| `src/test/unit/hpl-safety-gate.test.ts` | 新增 bash 信任判定测试 |

## 数据流架构

### 配置加载优先级

```
readMergedConfig(cwd)
  │
  ├─ 1. 读取 ~/.hapilon/config.json          (用户级基线)
  │
  ├─ 2. 检测 <cwd>/.hapilon/config.json      (存在则 merge 覆盖)
  │      └── project.config.json 的同名字段覆盖 user 基线
  │
  └─ 3. 检测 <cwd>/.hapilon/config.local.json (存在则 merge 覆盖)
         └── project.config.local.json 的同名字段覆盖以上所有
```

### 信任存储生命周期

```
cli.ts 启动
  │
  └─ initProjectTrust(process.cwd())
      └─ project-config.ts::loadProjectTrust(cwd)
          └─ 读取 .hapilon/config.local.json → { allow: { write: [...], bash: [...] } }
          └─ 反序列化为 Map<toolName, Set<target>>
          └─ 存入 trust-store.ts 的 projectTrust

tool_call 拦截时:
  │
  ├─ 1. classifyPath / classifyCommand → 得到 verdict
  │
  ├─ 2. verdict === "block"
  │      └─ isSessionTrusted(toolName, target) → true → 放行
  │      └─ false → { block: true }                         (project trust 不生效!)
  │
  └─ 3. verdict === "confirm"
         ├─ isTrusted(toolName, target) → true → 放行       (session 或 project 任一)
         └─ false → requestConfirm() 弹 4 选项
              ├─ "Allow Once"    → 放行，不存
              ├─ "Deny"          → { block: true }
              ├─ "Allow Session" → addTrust(tool, target, "session") → 放行
              └─ "Allow Project" → addTrust(tool, target, "project") → 放行
                                      └─ project-config::saveProjectTrust()

/allow 命令:
  └─ addPathAllow(path, cwd) → 对所有工具名加 session 信任
```

### `confirm.ts` 新的请求流程

```
requestConfirm(ctx, title, msg)
  │
  ├─ ctx.hasUI === false → { status: "unavailable" }
  │
  ├─ ctx.ui.select(title, [
  │     "Allow Once",
  │     "Allow this Session",
  │     "Allow this Project",
  │     "Deny"
  │   ])
  │
  └─ 结果映射:
       "Allow Once"          → { status: "approved", scope: "once" }
       "Allow this Session"  → { status: "approved", scope: "session" }
       "Allow this Project"  → { status: "approved", scope: "project" }
       "Deny"                → { status: "rejected" }
       undefined (ESC/取消)   → { status: "rejected" }
       catch err             → { status: "error", message }
```

## 实现步骤

### 阶段 1：基础设施 — 项目配置模块

**step 1.1**：创建 `src/project-config.ts`

模块内容：
- `resolveProjectHapilonDir(cwd)` — 检测 `<cwd>/.hapilon/` 是否存在，返回路径或 null
- `ensureProjectHapilonDir(cwd)` — 创建 `<cwd>/.hapilon/` 目录（权限 0755，项目目录不像 ~/.hapilon 那样需要 0700）
- `readProjectConfig(cwd)` — 读取 `<cwd>/.hapilon/config.json`，返回 `ProjectConfig`（类型复用 `HapilonConfig`）
- `readProjectLocalConfig(cwd)` — 读取 `<cwd>/.hapilon/config.local.json`，返回 `ProjectLocalConfig`
- `writeProjectLocalConfig(cwd, config)` — 写入（首次写入时检测 .gitignore）
- `readMergedConfig(cwd)` — 三级合并（local > project > user）
- `loadProjectTrust(cwd)` — 从 `config.local.json` 的 `allow` 字段反序列化为 `Map<string, Set<string>>`
- `saveProjectTrust(cwd, trust)` — 将 `Map<string, Set<string>>` 序列化写入 `config.local.json`

类型定义：
```typescript
interface ProjectLocalConfig {
  allow?: Record<string, string[]>;
}

interface MergedConfig extends HapilonConfig {
  allow?: Record<string, string[]>;
}
```

→ verify: `npx ts-node --eval "require('./src/project-config.ts')"` 无导入错误

**step 1.2**：编写 `src/test/unit/project-config.test.ts`

测试覆盖：
- `resolveProjectHapilonDir`: 目录存在/不存在
- `ensureProjectHapilonDir`: 创建目录/已存在不报错
- `readProjectConfig`: 文件不存在返回 `{}`/正常 JSON 解析/畸形 JSON warn
- `readProjectLocalConfig`: 同上 + allow 字段解析
- `writeProjectLocalConfig`: 写入后回读一致/覆盖已有/写入时自动 mkdir
- `readMergedConfig`: 三级覆盖链验证（local > project > user）
- `loadProjectTrust` / `saveProjectTrust`: 往返一致性
- ISO 临时目录模式（`mkdtempSync`），`after` 清理

→ verify: `npm run test:unit` 新增测试全部通过

### 阶段 2：信任存储模块

**step 2.1**：创建 `src/extensions/trust-store.ts`

模块内容：
- 内部状态：`sessionTrust: Map<string, Set<string>>` + `projectTrust: Map<string, Set<string>>`
- `initProjectTrust(cwd)` — 调用 `project-config.ts::loadProjectTrust` 初始化 `projectTrust`
- `isTrusted(toolName, target)` — session 或 project 任一命中即 true
- `isSessionTrusted(toolName, target)` — 仅 session 命中
- `addTrust(toolName, target, scope)` — scope="project" 时调 `saveProjectTrust`
- `addPathAllow(targetPath, cwd)` — 对所有工具名 (write/edit/read/bash) 加 session 信任
- `removeSessionTrust(toolName, target)` — 从 session 中移除
- `clearSessionTrust()` — 清空 session
- `listTrust()` — 返回 `{ session: [...], project: [...] }`

→ verify: 模块可被 `ts-node` 加载无错误

**step 2.2**：编写 `src/test/unit/trust-store.test.ts`

测试覆盖：
- 初始化后 project trust 可查询
- `isTrusted`: session 命中 → true / project 命中 → true / 双不命中 → false
- `isSessionTrusted`: session 命中 → true / project 命中 → false（block 隔离验证）
- `addTrust("session")` → session 可查，project 不可查
- `addTrust("project")` → project 可查，`saveProjectTrust` 被调用
- `addPathAllow` → 所有工具名的对应 entry 都被添加
- `clearSessionTrust` → session 清空，project 不受影响
- 命令+路径维度匹配：`write:.env` trusted 不意味着 `read:.env` trusted
- 多个工具名的同一路径独立存储

→ verify: `npm run test:unit` 新增测试全部通过

### 阶段 3：confirm.ts 升级

**step 3.1**：重写 `src/extensions/hpl-protected-paths/confirm.ts`

变更内容：
- `ConfirmResult` 类型新增 `scope` 字段
- `requestConfirm()` 内部用 `ctx.ui.select()` 替代 `ctx.ui.confirm()`
- 4 个选项的 label 映射到 ConfirmResult
- 保留 `unavailable` / `error` 状态逻辑
- 删除旧 `ctx.ui.confirm` 调用

→ verify: 类型检查通过；`src/extensions/hpl-protected-paths/index.ts` 和 `src/extensions/hpl-safety-gate/index.ts` 中对 `requestConfirm` 的调用不报类型错误

### 阶段 4：扩展接入 trust-store

**step 4.1**：更新 `src/extensions/hpl-protected-paths/whitelist.ts`

变更内容：
- 内部不再维护独立的 `Set<string>`
- `addAllow` / `isAllowed` / `clearAllow` / `listAllow` 等旧 API 转为代理到 `trust-store.ts` 的 `addPathAllow` / `isTrusted` 等
- 保持旧函数签名不变（向后兼容测试和 `/allow` 命令）

→ verify: `npm run test:unit -- --test-name-pattern="whitelist"` 旧测试仍然通过

**step 4.2**：更新 `src/extensions/hpl-protected-paths/index.ts`

变更内容：
- tool_call 钩子中，confirm 路径在弹框前先检查 `isTrusted(toolName, resolvedPath)`
- 弹框后根据 `result.scope` 调用 `addTrust(toolName, resolvedPath, scope)`（scope 为 "session" 或 "project"）
- block 路径仅检查 `isSessionTrusted`（不检查 project）
- `/allow` 命令改用 `trust-store` 的 `addPathAllow` / `clearSessionTrust` / `listTrust`
- 从 `trust-store.ts` 导入而非直接操作内部 Set

→ verify: 代码审查确认数据流正确

**step 4.3**：更新 `src/extensions/hpl-safety-gate/index.ts`

变更内容：
- confirm 路径（bash 命令）在弹框前先检查 `isTrusted("bash", command)`
- 弹框后根据 `result.scope` 调用 `addTrust("bash", command, scope)`
- block 路径仅检查 `isSessionTrusted("bash", command)`
- 用 `requestConfirm` 替代内联 `ctx.ui.confirm`

→ verify: 代码审查确认数据流正确

### 阶段 5：CLI 启动集成

**step 5.1**：更新 `src/cli.ts`

变更内容：
- 默认启动路径（spawn pi 之前）新增：
  ```typescript
  const { initProjectTrust } = await import("./extensions/trust-store.js");
  initProjectTrust(process.cwd());
  ```
- `_CHANGELOG-alpha.md` 和 `_todo.md` 不在此步骤更新（编码完成后单独处理）

→ verify: `npm run build && npm run test:integration` 集成测试通过

### 阶段 6：测试更新与补充

**step 6.1**：更新 `src/test/unit/hpl-protected-paths.test.ts`

变更内容：
- whitelist 测试组保持通过（whitelist.ts 代理到 trust-store，旧 API 兼容）
- 新增 "trust-store integration" 测试组：命令+路径维度、session 隔离、project 持久化
- 更新所有对 `isAllowed` 的调用，验证新的信任维度行为

→ verify: `npm run test:unit -- --test-name-pattern="hpl-protected-paths"` 全部通过

**step 6.2**：更新 `src/test/unit/hpl-safety-gate.test.ts`

变更内容：
- 新增 bash 信任判定测试组：`classifyCommand` 返回 confirm + trust-store 命中 → 不放行的单元逻辑验证
- 不直接测试 trust-store（那是 trust-store.test.ts 的职责），只测试 hpl-safety-gate 与分类器的集成

→ verify: `npm run test:unit -- --test-name-pattern="hpl-safety-gate"` 全部通过

### 阶段 7：清理与收尾

**step 7.1**：更新 `_todo.md`

将 TODO-9 和 TODO-10 标记为 `[x]`

**step 7.2**：更新 `_CHANGELOG-alpha.md`

追加变更日志条目

→ verify: 文件内容正确

## 关键风险

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| `trust-store.ts` 是 Node 模块级单例，多个扩展共享时无锁保护 | 低 | Node.js 事件循环是单线程，`tool_call` 回调是 async 但不会并发执行同一个事件处理器；Map 操作是同步的 |
| `projectTrust` 在每次 `addTrust("project")` 时写文件，频繁操作可能有 IO 压力 | 低 | 项目级 trust 仅用户显式选择 "Allow this Project" 时触发，频率极低（通常每个路径只触发一次） |
| `config.local.json` 被手动编辑与 hapilon 写入冲突 | 中 | `writeProjectLocalConfig` 每次都覆盖写（非增量 merge），以最后写入为准。手动编辑后 hapilon 会覆盖。文档提示用户不要手动编辑 allow 字段 |
| `ctx.ui.select()` 在 print/json 模式下行为 | 中 | `ctx.hasUI` 前置检查，非交互模式直接返回 `unavailable`，不会调用 `select()` |
| Pi 版本升级可能改变 `ctx.ui.select()` 的行为 | 低 | select 的签名是稳定的 (`title, options[] → Promise<string|undefined>`)，Pi 向后兼容保证 |

## 验收标准

### TODO-9
- [ ] `src/project-config.ts` 可检测项目 `.hapilon/` 目录
- [ ] `readMergedConfig(cwd)` 实现三级配置合并：`local > project > user`
- [ ] `config.local.json` 的 `allow` 字段序列化/反序列化正确
- [ ] `ensureProjectHapilonDir()` 创建目录权限为 0755
- [ ] 首次写入 `config.local.json` 时检查并提示 `.gitignore`
- [ ] 单元测试覆盖所有 project-config.ts 导出函数

### TODO-10
- [ ] `ctx.ui.select()` 替代 `ctx.ui.confirm()` 实现 4 选项弹框
- [ ] ConfirmResult 类型含 `scope` 字段，保持 `status === "approved"` 向后兼容
- [ ] `trust-store.ts` 实现 `Map<toolName, Set<target>>` 双维度信任
- [ ] `isTrusted()` 优先 session，回退 project
- [ ] `isSessionTrusted()` 仅查 session（block 路径专用）
- [ ] tool_call 拦截中 confirm 路径自动弹 4 选项
- [ ] Allow Session → session 级内存存储，session 结束自动清除
- [ ] Allow Project → 持久化到 `.hapilon/config.local.json`，后续 session 自动加载
- [ ] Block 路径不受 project trust 影响（仅 session 级 `/allow` 可绕过）
- [ ] 命令+路径双维度独立匹配（`write:.env` trusted 不等于 `read:.env` trusted）
- [ ] `/allow <path>` → 对所有工具加 session 信任
- [ ] `/allow --list` → 展示 session + project 全部信任
- [ ] `/allow --clear` → 清空 session，不影响 project
- [ ] 非交互模式下 project trust 仍生效，session trust 不生效
- [ ] hpl-safety-gate bash confirm 接入 4 选项 trust 流程
- [ ] 单元测试覆盖 trust-store 所有维度
- [ ] hpl-protected-paths / hpl-safety-gate 旧测试保持通过
- [ ] 集成测试验证端到端启动流程

## 非目标（显式排除）

- 不从 confirm 弹框提供"编辑信任列表"的 UI 入口（TODO-10 明确：只能通过弹框选择写入）
- 不在 `config.local.json` 中存储允许条目以外的内容（如 defaultProvider 等，那是 config.json 的职责）
- 不修改 `classifyPath()` / `classifyCommand()` 的签名或内部分类逻辑
- 不对 `.hapilon/` 目录下添加 `settings.json` 等 Pi 原生配置（那是 Pi 自管的事）
- 不实现 trust 的 TTL 或过期机制
- 不实现跨项目 trust 共享
