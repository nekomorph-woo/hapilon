# P0 安全基础设施 — 统一实现计划

## Context

hapilon 以 Pi Coding Agent 为内核，裸 Pi 的所有工具（bash/write/edit/read 等）以用户完整权限运行，无任何拦截。需要在 hapilon 层面补齐三层安全基础设施：

1. **TODO-5**：危险命令拦截（safety-gate.ts）— 拦截 bash 工具的高危/中危命令
2. **TODO-6**：文件路径保护（protected-paths.ts）— 拦截 write/edit/read 对敏感路径的操作
3. **TODO-7**：启动安全提示 — 首次启动时告知用户安全扩展已激活

三者共享 `--no-safety` CLI 绕过开关，需统一设计。

## 核心原则

1. **Fail Fast / 不静默阻止**：拦截时必须 `return { block: true, reason: "..." }`，给用户清晰反馈
2. **先 block 再考虑 confirm**：高危一律 block，中危弹 confirm（非交互模式下降级为 block）
3. **绕过策略统一**：`--no-safety` 在 hapilon CLI 层处理，不加载安全扩展即完全绕过，无需扩展间共享状态
4. **不引入新依赖**：路径匹配用纯函数实现，不引入 glob/minimatch 等三方库

## 文件变更清单

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/extensions/safety-gate.ts` | 危险命令拦截扩展：bash 工具混合策略（block / confirm / allow）+ shell 注入检测 |
| `src/extensions/protected-paths.ts` | 文件路径保护扩展：拦截 write/edit 的写操作 + read 的读敏感文件操作 |
| `src/test/unit/safety-gate.test.ts` | safety-gate 单元测试：命令分类逻辑、shell 注入检测、扩展注册验证 |
| `src/test/unit/protected-paths.test.ts` | protected-paths 单元测试：路径匹配逻辑、写保护/读保护分类、扩展注册验证 |

### 修改文件

| 文件 | 变更内容 |
|------|----------|
| `src/config-io.ts` | `HapilonConfig` 接口新增 `safetyNoticeShown?: boolean`；`readHapilonConfig()` 校验该字段 |
| `src/cli.ts` | 新增 `--no-safety` flag 检测；启动安全提示（首次）；按 `--no-safety` 过滤安全扩展 |

## 架构决策

### 决策 1：`--no-safety` 在 CLI 层处理，而非扩展内读 flag

**方案 A（选择）**：hailon CLI 检测 `--no-safety` 后，从 `discoverExtensions()` 结果中过滤掉安全扩展的 JS 文件，不传给 Pi。

```
discoverExtensions() → filter out safety-gate.js + protected-paths.js → spawn pi
```

**方案 B（不选）**：安全扩展内通过 `pi.getFlag("no-safety")` 自行判断。

**取舍理由**：方案 A 更简洁——不被加载的扩展零运行时开销，且不依赖 Pi 的 `registerFlag` API（该 API 的参数传递链路在 wrapper 模式下可能不可靠）。方案 B 的 flag 值需要 hapilon CLI 通过某种方式传给 Pi（要么作为 Pi CLI 参数，要么通过环境变量），引入额外复杂度。

### 决策 2：两个独立扩展 vs 一个统一扩展

**方案 A（选择）**：safety-gate.ts 和 protected-paths.ts 两个独立文件。

**方案 B（不选）**：合并为 safety.ts 单文件。

**取舍理由**：两者拦截的工具类型不同（bash vs write/edit/read）、匹配逻辑不同（命令模式 vs 路径模式），合并会让单文件过长且职责不清。独立文件使得测试边界清晰、未来可单独禁用。

### 决策 3：纯函数提取测试 vs 全 mock 测试

**方案 A（选择）**：将核心匹配逻辑提取为纯函数（`classifyCommand()`、`hasShellInjection()`、`isProtectedPath()`），纯函数做详细测试；扩展注册用轻量 mock 验证。

**方案 B（不选）**：完全 mock `ExtensionAPI` 对象。

**取舍理由**：纯函数测试更可靠、更易维护、不依赖 Pi 内部类型。mock ExtensionAPI 只能验证"注册了 handler"这个事实，无法验证 handler 的逻辑正确性。

### 决策 4：路径匹配算法

不使用 glob 库，自实现简单匹配。原因：模式集固定且简单（前缀/后缀/目录匹配），引入 glob 库增加依赖却只用到其 5% 的功能。

匹配规则表：

| 模式类型 | 示例 | 匹配逻辑 |
|----------|------|----------|
| 精确文件名 | `.env`, `package-lock.json` | `basename(target) === pattern` |
| 通配前缀 | `*.pem`, `*.key` | `basename(target).endsWith(".pem")` |
| 通配后缀 | `id_rsa*`, `.env*` | `basename(target).startsWith("id_rsa")` |
| 相对路径 | `.git/config` | `target.endsWith("/.git/config")` |
| 目录通配 | `.git/hooks/*`, `~/.ssh/*` | `target.startsWith(resolvedDir + sep)` |
| 绝对路径 | `~/.aws/credentials` | `resolvedTarget === expandTilde(pattern)` |

## 实现步骤

### 阶段 1：配置层改动（TODO-7 前半）

#### 步骤 1.1：扩展 HapilonConfig 接口

**文件**：`src/config-io.ts`

在 `HapilonConfig` 接口新增 `safetyNoticeShown?: boolean`。在 `readHapilonConfig()` 中添加该字段的类型校验（确保值为 boolean 或 undefined）。

```
修改 HapilonConfig 接口：
  defaultProvider?: string;
  defaultModel?: string;
+ safetyNoticeShown?: boolean;

修改 readHapilonConfig()：
  在校验 defaultProvider/defaultModel 类型之后，添加 safetyNoticeShown 的类型校验
```

**验证**：`npm run typecheck` 通过；`readHapilonConfig()` 对 `{"safetyNoticeShown": true}` 正确解析，对 `{"safetyNoticeShown": "yes"}` 输出 warning 并忽略。

---

### 阶段 2：安全扩展实现（TODO-5 + TODO-6）

#### 步骤 2.1：实现 safety-gate.ts

**文件**：`src/extensions/safety-gate.ts`

**结构**：

```
// 1. imports：ExtensionAPI, isToolCallEventType
// 2. 常量定义：BLOCK_PATTERNS, CONFIRM_PATTERNS, SHELL_INJECTION_PATTERNS
// 3. 纯函数（导出供测试）：
//    - classifyCommand(command: string): 'block' | 'confirm' | 'allow'
//    - hasShellInjection(command: string): boolean
// 4. export default function (pi: ExtensionAPI)
//    - pi.on("tool_call", handler)
//    - 仅拦截 isToolCallEventType("bash", event)
//    - 检查 hasShellInjection → block
//    - 检查 classifyCommand → block / confirm
```

**危险命令分类**：

| 级别 | 模式 | 匹配方式 |
|------|------|----------|
| BLOCK | `rm -rf /`, `rm -rf /*`, `sudo rm -rf /`, `sudo rm -rf /*` | 包含匹配（含空格） |
| BLOCK | `mkfs.` | 前缀匹配 |
| BLOCK | `dd of=/dev/` | 包含匹配 |
| BLOCK | `:(){ :\|:& };:`, `:(){ :\|:& };:` | 精确匹配（fork bomb） |
| BLOCK | `chmod 777 /`, `chmod -R 777 /` | 包含匹配 |
| BLOCK | `chown -R /` | 包含匹配 |
| BLOCK | `> /dev/sda`, `> /dev/nvme` | 包含匹配（输出重定向到块设备） |
| BLOCK | `` ` ``（反引号）、`$(`、`<(`、`>(` | 字符级检测（shell 注入） |
| CONFIRM | `rm -rf`（target 不是 `/` 或 `/*`） | 先匹配 `rm -rf` 再排除根目录 |
| CONFIRM | `git push --force`（含 `--force-with-lease`） | 包含匹配 |
| CONFIRM | `curl ... \| sh`, `curl ... \| bash`, `wget ... \| sh` | 包含 `\|` 且目标为 sh/bash |
| CONFIRM | `chmod 777`（target 不是 `/`） | 先匹配 `chmod 777` 再排除根目录 |
| CONFIRM | `git reset --hard` | 包含匹配 |
| CONFIRM | `docker rm -f` | 包含匹配 |
| CONFIRM | `eval` | 独立词匹配（非 eval 子串） |

**confirm 处理**：

```typescript
async function requestConfirm(ctx: ExtensionContext, reason: string): Promise<boolean> {
  if (!ctx.hasUI) {
    // 非交互模式下无法弹确认框 → 等同于拒绝
    return false;
  }
  try {
    return await ctx.ui.confirm(reason, { title: "⚠️ 危险操作" });
  } catch {
    // confirm 调用异常 → 安全侧拒绝
    return false;
  }
}
```

**⚠️ 需要确认**（实现时验证）：
1. `isToolCallEventType` 从 `@earendil-works/pi-coding-agent` 是否可正常 import？
2. `ctx.ui.confirm(message, options?)` 的 `options` 参数类型是否符合 `{ title: string }`？
3. `event.input.command` 是 bash 工具的参数名是否正确？（从 pi-wiki.md §4.3 的 tool_call 示例确认）

**验证**：
- `npm run build` 编译通过
- 单元测试（详见步骤 3.1）覆盖所有分类场景

---

#### 步骤 2.2：实现 protected-paths.ts

**文件**：`src/extensions/protected-paths.ts`

**结构**：

```
// 1. imports：ExtensionAPI, isToolCallEventType, path, os
// 2. 常量定义：WRITE_PROTECTED_PATTERNS, READ_CONFIRM_PATTERNS
// 3. 纯函数（导出供测试）：
//    - matchesProtectedPath(resolvedPath: string, patterns: string[]): boolean
//    - classifyPath(targetPath: string, cwd: string): 'block' | 'confirm' | 'allow'
//    - expandTilde(p: string): string
// 4. export default function (pi: ExtensionAPI)
//    - pi.on("tool_call", handler)
//    - 拦截 write/edit → 检查 file_path → block
//    - 拦截 read → 检查 path → confirm
```

**路径模式定义**：

```typescript
// 写保护（block）：任何 write/edit 操作被拦截
const WRITE_PROTECTED = [
  // ── 环境变量文件 ──
  ".env", ".env.local", ".env.production", ".env.development",

  // ── 包管理器锁文件（篡改可投毒依赖）──
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "pnpm-lock.yml", "bun.lockb",
  "composer.lock", "Gemfile.lock", "Cargo.lock", "poetry.lock",

  // ── Git 敏感路径 ──
  ".git/config", ".git/hooks/*", ".gitmodules",

  // ── CI/CD 管道（修改可在 CI 环境执行任意代码）──
  ".github/workflows/*", ".gitlab-ci.yml",

  // ── SSH 密钥与授权 ──
  "id_rsa", "id_rsa.pub", "id_ed25519", "id_ed25519.pub",
  "id_ecdsa", "id_ecdsa.pub",
  "authorized_keys",
  "~/.ssh/*",

  // ── 凭证文件 ──
  "~/.netrc", "~/.git-credentials",
  "~/.docker/config.json",
  "~/.kube/config", "*.kubeconfig",
  "~/.npmrc",
  "~/.aws/*",

  // ── 证书与密钥文件 ──
  "*.pem", "*.key", "*.crt", "*.cer",
  "*.p12", "*.pfx",
  "*.jks", "*.keystore", "*.truststore",
  "*.asc",
];

// 读保护（confirm）：read 工具读取这些路径时弹确认框
const READ_CONFIRM = [
  "~/.ssh/*",
  "~/.aws/credentials",
  "~/.aws/config",
  "~/.config/gcloud/*",
  "~/.docker/config.json",
  "~/.kube/config", "*.kubeconfig",
  "~/.npmrc",
];
```

**路径解析**：

```typescript
// 解析目标路径为绝对路径
function resolveTarget(targetPath: string, cwd: string): string {
  const expanded = expandTilde(targetPath);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
```

**⚠️ 需要确认**（实现时验证）：
1. `write` 工具的 `file_path` 参数名是否正确？`edit` 工具是否也用 `file_path`？
2. `read` 工具的参数名是 `path` 还是 `file_path`？
3. Pi 传递的路径是否已经过规范化（如 `~` 已被 Pi 展开）？如果 Pi 已展开，则 `expandTilde` 逻辑可简化。

**验证**：
- `npm run build` 编译通过
- 单元测试（详见步骤 3.2）覆盖所有路径匹配场景

---

### 阶段 3：单元测试

#### 步骤 3.1：safety-gate 单元测试

**文件**：`src/test/unit/safety-gate.test.ts`

使用 `node:test` 框架（项目现有标准）。

**测试用例清单**：

| 测试组 | 用例 | 预期结果 |
|--------|------|----------|
| `classifyCommand()` BLOCK | `sudo rm -rf /` | `'block'` |
| | `rm -rf /*` | `'block'` |
| | `mkfs.ext4 /dev/sda1` | `'block'` |
| | `dd if=/dev/zero of=/dev/sda` | `'block'` |
| | `chmod 777 /` | `'block'` |
| | `chown -R /` | `'block'` |
| | `echo data > /dev/sda` | `'block'` |
| `classifyCommand()` CONFIRM | `rm -rf ./node_modules` | `'confirm'` |
| | `git push --force origin main` | `'confirm'` |
| | `git push --force-with-lease` | `'confirm'` |
| | `curl https://example.com \| sh` | `'confirm'` |
| | `wget -qO- https://x.com \| bash` | `'confirm'` |
| | `chmod 777 ./script.sh` | `'confirm'` |
| | `git reset --hard HEAD~1` | `'confirm'` |
| | `docker rm -f mycontainer` | `'confirm'` |
| | `eval "$CMD"` | `'confirm'` |
| `classifyCommand()` ALLOW | `ls -la` | `'allow'` |
| | `npm test` | `'allow'` |
| | `git status` | `'allow'` |
| | `mkdir -p ./src` | `'allow'` |
| | `echo "hello"` | `'allow'` |
| `hasShellInjection()` | `` ls `whoami` `` | `true` |
| | `echo $(id)` | `true` |
| | `diff <(ls) <(ls -a)` | `true` |
| | `cat >(grep pattern)` | `true` |
| | `echo "backtick: \`"` | `true`（含反引号即触发） |
| | `ls -la` | `false` |
| | `echo "$HOME"` | `false`（双引号内的 `$` 变量不是命令替换） |
| fork bomb 精确匹配 | `:(){ :\|:& };:` | BLOCK |
| | `:(){ :\|:& };: ` | BLOCK（trim 后匹配） |
| | `function bomb { bomb\|bomb& }; bomb` | 不匹配（变体，暂不拦截） |

**验证**：`npm run test:unit` 全部通过（65+ 个断言）

---

#### 步骤 3.2：protected-paths 单元测试

**文件**：`src/test/unit/protected-paths.test.ts`

**测试用例清单**：

| 测试组 | 用例 | 预期结果 |
|--------|------|----------|
| `classifyPath()` BLOCK | `write` `.env` | `'block'` |
| | `write` `.env.production` | `'block'` |
| | `write` `package-lock.json` | `'block'` |
| | `write` `yarn.lock` | `'block'` |
| | `write` `pnpm-lock.yaml` | `'block'` |
| | `write` `Cargo.lock` | `'block'`（其他语言锁文件） |
| | `write` `composer.lock` | `'block'` |
| | `edit` `.git/config` | `'block'` |
| | `write` `.git/hooks/pre-commit` | `'block'` |
| | `write` `.gitmodules` | `'block'` |
| | `write` `.github/workflows/deploy.yml` | `'block'`（CI/CD 管道） |
| | `write` `~/.ssh/id_rsa` | `'block'`（含 tilde 展开） |
| | `write` `~/.aws/credentials` | `'block'` |
| | `write` `~/.netrc` | `'block'`（凭证文件） |
| | `write` `~/.git-credentials` | `'block'` |
| | `write` `~/.docker/config.json` | `'block'` |
| | `write` `~/.kube/config` | `'block'`（K8s 凭证） |
| | `write` `~/.npmrc` | `'block'`（npm token） |
| | `write` `server.key` | `'block'`（匹配 `*.key`） |
| | `write` `cert.pem` | `'block'`（匹配 `*.pem`） |
| | `write` `cert.p12` | `'block'`（匹配 `*.p12`） |
| | `write` `keystore.jks` | `'block'`（匹配 `*.jks`） |
| | `write` `key.asc` | `'block'`（匹配 `*.asc`） |
| | `write` `id_rsa` | `'block'` |
| | `write` `id_ed25519.pub` | `'block'` |
| | `write` `authorized_keys` | `'block'` |
| `classifyPath()` CONFIRM | `read` `~/.ssh/id_rsa` | `'confirm'` |
| | `read` `~/.aws/credentials` | `'confirm'` |
| | `read` `~/.config/gcloud/application_default_credentials.json` | `'confirm'` |
| | `read` `~/.docker/config.json` | `'confirm'`（Docker 凭证） |
| | `read` `~/.kube/config` | `'confirm'`（K8s 凭证） |
| | `read` `~/.npmrc` | `'confirm'`（npm token） |
| `classifyPath()` ALLOW | `write` `src/app.ts` | `'allow'` |
| | `write` `README.md` | `'allow'` |
| | `edit` `src/utils.ts` | `'allow'` |
| | `read` `package.json` | `'allow'`（非锁文件） |
| | `read` `.gitignore` | `'allow'`（非 .git/config） |
| 边界条件 | 相对路径解析（`cwd=/home/user/project`, target=`./.env`） | 正确 resolve 并匹配 |
| | symlink（`/tmp/link` → `~/.ssh/id_rsa`） | `需要确认`：是否跟随 symlink？建议暂不跟随 |
| | Windows 风格路径（`C:\Users\...`） | 不处理（hapilon 仅 Unix） |

**验证**：`npm run test:unit` 全部通过（80+ 个断言）

---

### 阶段 4：CLI 层集成（TODO-7 后半 + `--no-safety`）

#### 步骤 4.1：添加 `--no-safety` 检测和启动安全提示

**文件**：`src/cli.ts`

**变更点 1**（在 `main()` 函数开头，args 解析后）：

```typescript
// 检测 --no-safety 标志（在启动 pi 前）
const noSafety = hasFlag(args, "--no-safety");
```

**变更点 2**（在 `hapilon_v0.1.0_alpha` banner 之后、spawn pi 之前）：

```typescript
// 首次启动安全提示
const config = readHapilonConfig();
if (!config.safetyNoticeShown && !noSafety && !isNonInteractive) {
  console.log("\n🛡️  hapilon 安全扩展已激活：");
  console.log("   • 危险命令拦截 — sudo rm、mkfs、fork bomb 等将被阻止");
  console.log("   • 文件路径保护 — .env / SSH key 等敏感文件受保护");
  console.log("   • 使用 --no-safety 可临时关闭所有安全检查\n");
  writeHapilonConfig({ ...config, safetyNoticeShown: true });
}
```

**变更点 3**（修改扩展发现和过滤逻辑）：

```typescript
// 原来的代码：
const extensionFlags = discoverExtensions().flatMap((e) => ["-e", e]);

// 改为：
const allExtensions = discoverExtensions();
const loadedExtensions = noSafety
  ? allExtensions.filter(
      (e) =>
        !e.endsWith("/safety-gate/index.js") &&
        !e.endsWith("/safety-gate.js") &&
        !e.endsWith("/protected-paths/index.js") &&
        !e.endsWith("/protected-paths.js"),
    )
  : allExtensions;
const extensionFlags = loadedExtensions.flatMap((e) => ["-e", e]);
```

**验证**：
- `hapilon --help` 显示 `--no-safety` 说明（步骤 4.2 同步更新）
- `hapilon`（首次，无 `~/.hapilon/config.json`）：显示安全声明
- `hapilon`（再次）：不重复显示
- `hapilon -p "hello"`：不显示安全声明（print 模式静默）
- `hapilon --no-safety`：不显示安全声明，不加载安全扩展
- `npm run build && npm run test:unit` 全部通过

---

#### 步骤 4.2：更新帮助文档

**文件**：`src/help.ts`

在帮助信息中添加 `--no-safety` 选项说明。找到 CLI 标志列表区域，新增：

```
  --no-safety              临时关闭所有安全检查（危险命令拦截 + 文件路径保护）
```

**验证**：`hapilon help` 输出包含 `--no-safety` 说明

---

### 阶段 5：集成验证

#### 步骤 5.1：构建验证

```bash
npm run build
ls dist/extensions/safety-gate.js       # 应存在
ls dist/extensions/protected-paths.js   # 应存在
```

#### 步骤 5.2：类型检查

```bash
npm run typecheck
# 应无错误
```

#### 步骤 5.3：全量单元测试

```bash
npm run test:unit
# 全部通过，包括新增的 safety-gate.test.js 和 protected-paths.test.js
```

---

## 关键风险

| 风险 | 缓解措施 |
|------|----------|
| **Pi API 参数名不确定**：write/edit/read 工具的 `event.input` 参数名可能与文档有差异 | 实现时先用 `console.log(event.input)` 验证实际参数名，再编写匹配逻辑；单元测试中 mock event 对象的参数名跟随实际 API |
| **`isToolCallEventType` 导入路径**：该函数在 Pi v0.80.6 中是否存在及导出路径 | 如果导入失败，降级为手动类型断言（`if (event.toolName === "bash")`） |
| **`ctx.ui.confirm` 在非 TUI 模式下的行为**：print/json 模式下可能 throw 或返回 false | 在 confirm 调用前检查 `ctx.hasUI`，无 UI 时直接 block（安全侧） |
| **路径规范化差异**：Pi 传给 tool_call 的路径可能是相对路径、已解析的绝对路径、或含 `~` 的路径 | 在路径匹配前统一调用 `resolveTarget()` 做规范化；单元测试覆盖三种输入形式 |
| **symlink 绕过**：Agent 可能通过 symlink 路径绕过匹配（如 `ln -s ~/.ssh/id_rsa /tmp/key` 然后 `read /tmp/key`） | 暂不跟随 symlink（保持简单）；TODO 中标注后续增强 |
| **命令编码绕过**：Agent 可能用 base64 编码/hex 编码等方式绕过命令匹配 | 当前不处理编码绕过（Agent 通常不会主动这样做）；作为后续增强记录到 backlog |

## 验收标准

### TODO-5：危险命令拦截

- [ ] 高危命令（如 `sudo rm -rf /`）被直接阻止，Agent 收到 block reason
- [ ] 中危命令（如 `rm -rf ./node_modules`）弹出确认框，用户可选择 Allow/Deny
- [ ] Shell 注入技巧（`` `cmd` ``、`$(cmd)`、`<(cmd)`、`>(cmd)`）被检测并阻止
- [ ] 正常 bash 命令（`ls`、`npm test`、`git status`）不受影响
- [ ] `--no-safety` 标志可绕过所有安全检查
- [ ] hapilon 启动时自动加载（`discoverExtensions()` → `-e` 注入）
- [ ] 单元测试覆盖：高危阻止（8+ 用例）、中危确认（9+ 用例）、正常放行（5+ 用例）、shell 注入（6+ 用例）、绕过开关
- [ ] 阻止时返回清晰的 reason 信息，不静默阻止

### TODO-6：文件路径保护

- [ ] 对 `.env` 等文件的 write/edit 被直接阻止
- [ ] 对 `~/.ssh/id_rsa` 的 read 弹出确认框
- [ ] 对普通文件（`src/app.ts`、`README.md`）的 write/edit/read 不受影响
- [ ] `--no-safety` 标志绕过所有路径保护
- [ ] hapilon 启动时自动加载
- [ ] 单元测试覆盖：写保护阻止（26+ 用例）、读保护确认（6+ 用例）、正常放行（5+ 用例）、边界条件（3+ 用例）

### TODO-7：启动安全提示

- [ ] 全新安装后首次 `hapilon` 启动显示安全声明
- [ ] 再次启动 hapilon 不重复显示
- [ ] `hapilon -p "..."` 静默模式下不显示
- [ ] `hapilon --no-safety` 时不显示安全声明
- [ ] 安全声明内容清晰（3 行），列出被保护的内容和绕过方式
- [ ] `config.json` 中 `safetyNoticeShown` 字段正确持久化

## 执行顺序

```
步骤 1.1 (config-io.ts 接口扩展)
  │
  ├─► 步骤 2.1 (safety-gate.ts)     ──┐  可并行
  └─► 步骤 2.2 (protected-paths.ts) ──┘
        │
        ├─► 步骤 3.1 (safety-gate 单元测试)     ──┐  可并行
        └─► 步骤 3.2 (protected-paths 单元测试) ──┘
              │
              └─► 步骤 4.1 (cli.ts 集成)
                    │
                    └─► 步骤 4.2 (help.ts 更新)
                          │
                          └─► 步骤 5.x (构建 + 全量测试验证)
```
