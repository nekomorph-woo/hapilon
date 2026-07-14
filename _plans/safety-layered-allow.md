# 写保护分层 + /allow 命令 — 实现计划

## Context

当前 `protected-paths.ts` 对所有 ~30 种写保护路径一律 hard block。正常工作中需要修改 `.env` 或 `.github/workflows/` 时，只能用 `--no-safety` 全局关闭所有安全检查，风险极大。

需要两个增强：
1. **写保护分层**：将统一 block 拆为高危 block + 中危 confirm
2. **/allow 命令**：注册 slash command，将指定路径加入 session 级临时白名单

## 核心原则

1. **安全侧默认**：真正不可逆的高危路径（SSH key、凭证、证书等）永远 block
2. **最小权限提升**：白名单是 session 级的 `Set<string>`，不持久化，不给全局豁免
3. **显式操作**：白名单需要用户显式输入 `/allow` 命令；block 路径也可加入白名单（用户有意的操作）
4. **不改 signature**：`classifyPath()` 不增加额外参数，改变的是内部分类逻辑；`PathVerdict` 类型不变

## 分层设计：哪个路径去哪层

### 高危 — block（真正不可逆）

| 类别 | 匹配规则 | 现有 label |
|------|----------|------------|
| SSH 目录 | `resolved.startsWith(homedir()+"/.ssh/")` | `~/.ssh` |
| SSH 密钥 | basename 匹配 `id_rsa/id_rsa.pub/id_ed25519/id_ed25519.pub/id_ecdsa/id_ecdsa.pub/authorized_keys` | `SSH 密钥` |
| AWS 目录 | `resolved.startsWith(homedir()+"/.aws/")` | `~/.aws` |
| netrc / git-credentials | 精确路径匹配 | `~/.netrc`, `~/.git-credentials` |
| Docker 凭证 | 精确路径匹配 | `Docker 凭证` |
| K8s 凭证 | 精确路径匹配 | `K8s 凭证` |
| npm token | 精确路径匹配 | `npm token` |
| 证书/密钥后缀 | `*.pem`, `*.key`, `*.crt`, `*.cer`, `*.p12`, `*.pfx`, `*.jks`, `*.asc`, `*.keystore`, `*.truststore` | `证书/密钥文件` |
| .git/config | 精确路径匹配 | `.git/config` |
| .git/hooks/* | 目录匹配 | `.git/hooks` |

### 中危 — confirm（工作中可能需要正常改）

| 类别 | 匹配规则 | 现有 label |
|------|----------|------------|
| .env* 系列 | basename 以 `.env` 开头 | `env 文件` |
| 包管理器锁文件 | basename 精确匹配 9 种锁文件 | `包管理器锁文件` |
| CI/CD 管道 | `.github/workflows/*` 目录匹配 | `GitHub Actions workflow` |
| | `.gitlab-ci.yml` 精确匹配 | `.gitlab-ci.yml` |
| .gitmodules | 精确路径匹配 | `.gitmodules` |
| kubeconfig | `*.kubeconfig` 后缀匹配 | `kubeconfig` |

**需要确认**：`*.kubeconfig` 放在 confirm 层是否合适？（K8s 凭证文件，放 block 也可）

## 文件变更清单

### 修改文件

| 文件 | 变更内容 |
|------|----------|
| `src/extensions/protected-paths.ts` | 重写分层逻辑、新增 whitelist Set、注册 /allow 命令、中危路径弹 confirm |
| `src/test/unit/protected-paths.test.ts` | 更新分类测试（区分 block vs confirm）、新增白名单集成测试、命令 handler 测试 |

（无新增文件，全部变更限定在现有 2 个文件中）

## 架构决策

### 决策 1：白名单在 classifyPath 之前检查，还是内置到 classifyPath 中

**方案 A（选择）**：在 `tool_call` handler 中先检查白名单，再调用 `classifyPath`。

```typescript
// tool_call handler 内
const resolved = resolveTarget(filePath, ctx.cwd);
if (isPathWhitelisted(resolved)) return; // 白名单放行
const verdict = classifyPath(resolved, toolName);
```

**方案 B（不选）**：将白名单作为 `classifyPath()` 的第三个参数传入。

**取舍理由**：
- `classifyPath` 是纯函数，不含副作用，当前测试全部基于纯函数
- 白名单是扩展内部的有状态逻辑，不应污染纯函数的接口
- 方案 A 使得测试边界清晰：纯函数测试不改，白名单逻辑单独测
- 未来如需 `resolveTarget` 也纳入纯函数导出，可以单独测试路径解析

### 决策 2：/allow 命令放在 protected-paths.ts 还是单独文件

**方案 A（选择）**：命令注册放在 `protected-paths.ts` 内部。

**方案 B（不选）**：独立 `src/extensions/allow-cmd.ts`。

**取舍理由**：
- 白名单 `Set` 需要与 `tool_call` handler 共享同一个内存引用
- 放在同一个文件内，模块级 `const whitelist = new Set<string>()` 即可实现共享
- 独立文件需要通过 `pi.events`（EventBus）传递白名单操作，增加不必要的复杂度
- 命令逻辑简短（~30 行），不会让文件显著膨胀

## 实现步骤

### Step 1：重构写保护列表为两层

**文件**：`src/extensions/protected-paths.ts`

**位置**：第 34-88 行 `WRITE_PROTECTED` 常量 → 拆分为 `WRITE_BLOCK` 和 `WRITE_CONFIRM`

```typescript
// 高危 — block：真正不可逆
const WRITE_BLOCK: Array<{ test: ...; label: string }> = [
  // SSH key 文件 + SSH 目录
  // ~/.aws/*、凭证精确路径
  // 证书/密钥后缀
  // .git/config、.git/hooks/*
];

// 中危 — confirm：工作中可能需要正常修改
const WRITE_CONFIRM: Array<{ test: ...; label: string }> = [
  // .env* 系列
  // 包管理器锁文件
  // CI/CD 管道
  // .gitmodules
  // *.kubeconfig
];
```

**验证**：
- `npm run typecheck` 通过
- 现有测试中那些应该变为 `'confirm'` 的用例会失败——这正是 Step 3 要修正的

---

### Step 2：修改 classifyPath 写保护返回逻辑

**文件**：`src/extensions/protected-paths.ts`

**位置**：第 153-157 行

当前：
```typescript
if (toolName === "write" || toolName === "edit") {
  for (const pattern of WRITE_PROTECTED) {
    if (pattern.test(resolved, name)) return "block";
  }
  return "allow";
}
```

改为：
```typescript
if (toolName === "write" || toolName === "edit") {
  // 先检查高危（block）再检查中危（confirm）
  for (const pattern of WRITE_BLOCK) {
    if (pattern.test(resolved, name)) return "block";
  }
  for (const pattern of WRITE_CONFIRM) {
    if (pattern.test(resolved, name)) return "confirm";
  }
  return "allow";
}
```

**验证**：
- `npm run typecheck` 通过
- 后续更新测试后，`npm run test:unit` 通过

---

### Step 3：在 tool_call handler 中实现 confirm 弹窗（写操作）

**文件**：`src/extensions/protected-paths.ts`

**位置**：第 176-188 行 — 写保护 handler，在 `verdict === "block"` 后增加 `verdict === "confirm"` 分支

当前写保护 handler：
```typescript
if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
  const filePath: string = event.input.path ?? "";
  if (!filePath) return;
  const toolName = isToolCallEventType("edit", event) ? "edit" : "write";
  const verdict = classifyPath(filePath, toolName, ctx.cwd);
  if (verdict === "block") {
    return { block: true, reason: `🛡️ ...` };
  }
  return;
}
```

改为：
```typescript
if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
  const filePath: string = event.input.path ?? "";
  if (!filePath) return;

  const toolName = isToolCallEventType("edit", event) ? "edit" : "write";
  const verdict = classifyPath(filePath, toolName, ctx.cwd);

  if (verdict === "block") {
    return {
      block: true,
      reason: `🛡️ 受保护的文件路径，不允许写入：${filePath}`,
    };
  }

  if (verdict === "confirm") {
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `🛡️ 非交互模式下禁止写入受保护文件：${filePath}`,
      };
    }
    try {
      const approved = await ctx.ui.confirm(
        "⚠️ 敏感文件写入确认",
        `Agent 正在尝试写入受保护的文件：\n\n> ${filePath}\n\n是否允许写入？`,
      );
      if (!approved) {
        return {
          block: true,
          reason: `用户拒绝了写入受保护文件：${filePath}`,
        };
      }
    } catch (err) {
      console.warn("安全确认对话框异常:", err instanceof Error ? err.message : String(err));
      return {
        block: true,
        reason: `🛡️ 确认对话框异常，已阻止写入：${filePath}`,
      };
    }
    // 用户确认 → 不返回 block，放行
  }

  // allow → 不拦截
}
```

**验证**：
- `npm run typecheck` 通过
- 逻辑检查：confirm 分支只在 `verdict === "confirm"` 时触发，`"allow"` 直接穿过

---

### Step 4：实现白名单 Set + whitelist 检查函数

**文件**：`src/extensions/protected-paths.ts`

**位置**：在 `export default function` 之前（模块顶层）

```typescript
/**
 * Session 级写保护白名单。
 * 存储已解析的绝对路径，优先级高于 block/confirm 规则。
 * Session 结束时自动清除（不持久化）。
 */
const writeWhitelist = new Set<string>();

/**
 * 将路径加入白名单。会自动展开 ~ 并解析为绝对路径。
 */
function addToWhitelist(rawPath: string, cwd: string): void {
  const resolved = resolveTarget(rawPath, cwd);
  writeWhitelist.add(resolved);
}

/**
 * 检查已解析的路径是否在白名单中。
 */
function isPathWhitelisted(resolved: string): boolean {
  return writeWhitelist.has(resolved);
}
```

**导出策略**：`writeWhitelist`、`addToWhitelist`、`isPathWhitelisted` 均不导出。它们仅供 `/allow` 命令和 `tool_call` handler 内部使用。测试时通过命令 handler 间接证明。

**验证**：
- `npm run typecheck` 通过

---

### Step 5：在 tool_call handler 中集成白名单检查

**文件**：`src/extensions/protected-paths.ts`

**位置**：写保护 handler 开头，在 `classifyPath` 调用之前

```typescript
// 白名单优先：已放行路径直接通过，不触发 block/confirm
const resolved = resolveTarget(filePath, ctx.cwd);
if (isPathWhitelisted(resolved)) return;
```

注意：需要调整 handler 中的路径解析。当前 `resolveTarget` 是 `classifyPath` 内部调用的，白名单检查需要提前解析。可选方案：

**方案**：将 `resolveTarget` 提取到 `classifyPath` 外部，导出供测试使用，handler 中也直接调用它：

```typescript
// 导出供测试
export function resolveTarget(targetPath: string, cwd: string): string {
  // ... 现有逻辑
}

export function classifyPath(targetPath: string, toolName: string, cwd?: string): PathVerdict {
  const cwd_ = cwd ?? process.cwd();
  const resolved = resolveTarget(targetPath, cwd_);
  const name = basename(resolved);
  // ...
}
```

然后在 handler 中：
```typescript
const resolved = resolveTarget(filePath, ctx.cwd);
if (isPathWhitelisted(resolved)) return;

const verdict = classifyPath(filePath, toolName, ctx.cwd);
```

> 注意：`classifyPath` 内部也会调用 `resolveTarget`，会导致双重解析。为了不破坏现有 public API，保持 `classifyPath` 不变（内部仍自己做解析），handler 中仅白名单检查时额外解析一次。额外开销极小（一次路径解析）。

**验证**：
- `npm run typecheck` 通过

---

### Step 6：注册 /allow 命令

**文件**：`src/extensions/protected-paths.ts`

**位置**：`export default function (pi: ExtensionAPI)` 开头

```typescript
export default function (pi: ExtensionAPI) {
  // ── /allow 命令 ──
  pi.registerCommand("allow", {
    description: "将指定路径加入本次 session 的写保护白名单",

    handler: async (args, ctx) => {
      const input = (args ?? "").trim();

      // --list：列出当前白名单
      if (input === "--list" || input === "") {
        const entries = Array.from(writeWhitelist).sort();
        if (entries.length === 0) {
          ctx.ui.notify("allow 白名单为空", "info");
        } else {
          const list = entries.map((p) => `  - ${p}`).join("\n");
          ctx.ui.notify(`当前白名单（${entries.length} 条）：\n${list}`, "info");
        }
        return;
      }

      // --clear：清空白名单
      if (input === "--clear") {
        const count = writeWhitelist.size;
        writeWhitelist.clear();
        ctx.ui.notify(`已清空白名单（移除了 ${count} 条路径）`, "info");
        return;
      }

      // 默认：将路径加入白名单（支持空格分隔多个）
      const paths = input.split(/\s+/).filter(Boolean);
      const added: string[] = [];

      for (const p of paths) {
        try {
          addToWhitelist(p, ctx.cwd);
          added.push(p);
        } catch (err) {
          ctx.ui.notify(`无法解析路径 "${p}"：${err instanceof Error ? err.message : String(err)}`, "error");
        }
      }

      if (added.length > 0) {
        ctx.ui.notify(`已放行 ${added.length} 条路径：\n${added.map((p) => `  - ${p}`).join("\n")}`, "info");
      }
    },
  });

  // ── tool_call handler（现有逻辑 + 白名单检查 + confirm 分支）──
  pi.on("tool_call", async (event, ctx) => {
    // ... 写入白名单后的完整逻辑
  });
}
```

**命令设计细节**：

| 输入 | 行为 |
|------|------|
| `/allow` 或 `/allow --list` | 列出当前白名单 |
| `/allow --clear` | 清空白名单 |
| `/allow .env` | 将 `.env`（解析为当前 cwd 下绝对路径）加入白名单 |
| `/allow .env .github/workflows/deploy.yml` | 批量添加 |

**关于 `--list` 和 `--clear` 使用 `ctx.ui.notify` 还是 `` `return { ... }` ``**：
- 参考 pattern code-patterns.md 模式 4：命令 handler 使用 `ctx.ui.notify` 输出信息
- 白名单信息不需要进入 LLM 上下文，用 `ctx.ui.notify` 最合适

**验证**：
- `npm run typecheck` 通过
- `npm run build` 编译通过

---

### Step 7：更新单元测试

**文件**：`src/test/unit/protected-paths.test.ts`

#### Step 7a：更新分类测试（block → confirm 的用例）

以下用例的预期值需要从 `"block"` 改为 `"confirm"`：

| 测试用例 | 变更 |
|----------|------|
| `write .env → block` | → `"confirm"` |
| `write .env.production → block` | → `"confirm"` |
| `write package-lock.json → block` | → `"confirm"` |
| `write yarn.lock → block` | → `"confirm"` |
| `write pnpm-lock.yaml → block` | → `"confirm"` |
| `write pnpm-lock.yml → block` | → `"confirm"` |
| `write bun.lockb → block` | → `"confirm"` |
| `write Cargo.lock → block` | → `"confirm"` |
| `write composer.lock → block` | → `"confirm"` |
| `write Gemfile.lock → block` | → `"confirm"` |
| `write poetry.lock → block` | → `"confirm"` |
| `write .github/workflows/deploy.yml → block` | → `"confirm"` |
| `write .gitlab-ci.yml → block` | → `"confirm"` |
| `write .gitmodules → block` | → `"confirm"` |
| `write project.kubeconfig → block` | → `"confirm"` |
| `write ./.env → block` | → `"confirm"` |
| `write .env with custom cwd → block` | → `"confirm"` |

约 17 个用例需要改预期值。

#### Step 7b：高危 block 用例保持不变

以下用例预期值保持 `"block"`（没有移到 confirm 层）：
- SSH 相关：`~/.ssh/id_rsa`、`id_rsa`、`id_ecdsa`、`id_ecdsa.pub`、`id_ed25519.pub`、`authorized_keys`
- 凭证：`~/.aws/credentials`、`~/.netrc`、`~/.git-credentials`、`~/.docker/config.json`、`~/.kube/config`、`~/.npmrc`
- 证书：`server.key`、`cert.pem`、`cert.p12`、`keystore.jks`、`server.keystore`、`server.truststore`、`key.asc`
- Git 敏感：`.git/config`、`.git/hooks/pre-commit`
- 绝对路径 `.env`：保持 block（因为 `resolveTarget("/absolute/.env")` 的 basename 是 `.env`，但需要确认它在 confirm 层）→ **实际上绝对路径的 .env 也会走 confirm 层，因为分类是按 basename 匹配的**

**需要确认**：绝对路径的 `.env` 测试 `classifyPath(resolve("/absolute/.env"), "write") → "block"` 需要改为 `"confirm"`。见下方测试用例。

#### Step 7c：新增分层测试组

建议新增一个 `describe("classifyPath() — 写保护分层")` 测试组：

```typescript
describe("classifyPath() — 写保护分层", () => {
  // 高危 block 确认
  it("write ~/.ssh/id_rsa → block（SSH 密钥始终 block）", () => {
    assert.strictEqual(classifyPath("~/.ssh/id_rsa", "write"), "block");
  });

  it("write cert.pem → block（证书后缀始终 block）", () => {
    assert.strictEqual(classifyPath("cert.pem", "write"), "block");
  });

  it("write ~/.netrc → block（凭证始终 block）", () => {
    assert.strictEqual(classifyPath("~/.netrc", "write"), "block");
  });

  // 中危 confirm 确认
  it("write .env → confirm（环境文件变为 confirm）", () => {
    assert.strictEqual(classifyPath(".env", "write"), "confirm");
  });

  it("write package-lock.json → confirm（锁文件变为 confirm）", () => {
    assert.strictEqual(classifyPath("package-lock.json", "write"), "confirm");
  });

  it("write .github/workflows/deploy.yml → confirm（CI 管道变为 confirm）", () => {
    assert.strictEqual(classifyPath(".github/workflows/deploy.yml", "write"), "confirm");
  });
});
```

#### Step 7d：新增 resolveTarget 纯函数测试

```typescript
describe("resolveTarget()", () => {
  it("相对路径 → 绝对路径", () => {
    const result = resolveTarget(".env", "/tmp/project");
    assert.strictEqual(result, "/tmp/project/.env");
  });

  it("~ 展开", () => {
    const result = resolveTarget("~/.ssh/id_rsa", "/tmp");
    assert.strictEqual(result, homedir() + "/.ssh/id_rsa");
  });

  it("绝对路径原样返回", () => {
    const result = resolveTarget("/etc/hosts", "/tmp");
    assert.strictEqual(result, "/etc/hosts");
  });
});
```

**验证**：
- `npm run test:unit` 全部通过
- 高风险用例确认保持 `"block"`（通过 grep 检查）

---

### Step 8：构建 + 端到端验证

```bash
npm run build        # tsc 编译
npm run test:unit    # 全量单测通过
```

**人工 E2E 验证步骤**：

1. 启动 hapilon
2. 尝试让 Agent 写入 `.env` → 应弹出确认框（不再是直接 block）
3. 在确认框中选 Allow → 写入成功
4. 尝试让 Agent 写入 `~/.ssh/id_rsa` → 应直接 block（高危）
5. 输入 `/allow .env` → 显示 "已放行 1 条路径"
6. 再次让 Agent 写入 `.env` → 应直接放行（不弹确认，不 block）
7. 输入 `/allow --list` → 显示白名单内容
8. 输入 `/allow --clear` → 清空
9. 关闭 hapilon 再重新启动 → 白名单应为空（session 级别）

## 关键风险

| 风险 | 缓解措施 |
|------|----------|
| **双重路径解析**：handler 先调用 `resolveTarget` 做白名单检查，`classifyPath` 内部再次解析 | 性能影响极小（一次 `realpathSync` 调用），可接受；未来如需优化，可将 `classifyPath` 重构为接收已解析路径 |
| **白名单路径匹配粒度过细**：只加一个文件，Agent 可能改其他同类文件 | 设计如此——白名单是最小权限原则。如果用户希望放行整个目录，需要显式 `/allow .env .env.production .env.local ...` 逐一添加。未来可扩展为 glob 模式支持 |
| **`registerCommand` handler 的 `args` 类型不明确** | 参考 code-patterns.md 模式 4：`args` 是 `string` 类型（命令后的全部文本） |
| **`ctx.ui.notify` 在 command handler 中是否可用** | 参考 code-patterns.md 模式 4 示例，`ctx.ui.notify` 在 command handler 中可用 |
| **confirm 对话框文本需要清晰区分写/读** | 写操作 confirm 用 "⚠️ 敏感文件写入确认"，读操作保持 "⚠️ 敏感文件读取确认" |

## 验收标准

### 写保护分层

- [ ] 高危路径（SSH key、凭证、证书、.git/config、.git/hooks）写入 → `block`
- [ ] 中危路径（.env、锁文件、CI 管道、.gitmodules、kubeconfig）写入 → `confirm`（弹确认框）
- [ ] 中危路径读取 → 行为不变（保持 `confirm`）
- [ ] 非交互模式下中危路径写入 → 降级为 `block`（安全侧）
- [ ] 正常文件（src/app.ts、README.md）写入 → `allow`
- [ ] `--no-safety` 全局绕过全部安全扩展

### /allow 命令

- [ ] `/allow .env` → 将 .env 解析为绝对路径加入白名单
- [ ] 白名单路径写入 → 直接放行，不弹 block/confirm
- [ ] 白名单路径读取 → 不弹 confirm（如果该路径在 READ_CONFIRM 中）
- [ ] `/allow --list` → 显示当前白名单（空则提示为空）
- [ ] `/allow --clear` → 清空白名单并提示移除数量
- [ ] 支持空格分隔多个路径同时添加
- [ ] hapilon 重启后白名单自动清除
- [ ] 白名单对 block 路径也生效（用户显式操作视为有意）

### 单元测试

- [ ] `classifyPath` 写保护测试区分 `"block"` 和 `"confirm"`（约 17 个用例改预期值）
- [ ] 高风险路径保持 `"block"` 的用例不变
- [ ] `resolveTarget` 有独立测试
- [ ] 全量单测 `npm run test:unit` 通过，断言数不减少

## 执行顺序

```
Step 1 (拆分 WRITE_BLOCK / WRITE_CONFIRM)
  │
  └─► Step 2 (修改 classifyPath 返回值)
        │
        └─► Step 3 (handler 中新增 confirm 弹窗)
              │
              ├─► Step 4 (白名单 Set + 辅助函数)    ──┐
              ├─► Step 5 (handler 中集成白名单检查)   │ 可并行
              └─► Step 6 (注册 /allow 命令)   ─┘
                    │
                    └─► Step 7 (更新测试)
                          │
                          └─► Step 8 (构建 + 全量测试 + E2E)
```

Step 4-6 之间互相依赖（共享 `writeWhitelist`），建议同一个人顺序完成，不需要并行。
