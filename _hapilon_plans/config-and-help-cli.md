# TODO-2/3/4 实现计划：config.json + 默认模型 + Provider CRUD + Help

## Context

当前 hapilon 已具备 `hapilon setup`（初始化）和 `hapilon doctor`（诊断），但缺少以下能力：
- 设置默认 provider 和模型（启动时自动使用）
- 独立增删查 provider API key（不依赖 setup 全量重走）
- 统一的 help 帮助系统（命令越来越多了）

本轮在 hapilon 自有 `~/.hapilon/config.json` 中存储默认模型配置，启动时作为 `--provider`/`--model` CLI 参数注入 Pi，不操作 Pi 原生 settings.json。

## 核心原则

1. **hapilon 自有配置**：默认模型存 `~/.hapilon/config.json`，Pi 不读写此文件
2. **CLI 参数传递**：通过 `--provider`/`--model` 传给 Pi spawn 命令
3. **用户参数优先**：显式传参覆盖 config.json 默认值
4. **模型列表运行时获取**：spawn `pi --list-models` 获取实时模型列表（方案 B）
5. **命令注册表单数据源**：help 和路由共享 `commands.ts` 命令定义

## 文件变更清单

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/pi-cli-path.ts` | 从 cli.ts 提取 `resolvePiCli()`，供 cli.ts 和 pi-listing.ts 共用 |
| `src/config-io.ts` | config.json 读写 + `hasFlag()` + `injectDefaultArgs()` 纯函数 |
| `src/pi-listing.ts` | spawn `pi --list-models` + 表格解析（纯函数 `parseModelsTable` 可单测） |
| `src/commands.ts` | 命令注册表（纯数据，零逻辑），help 和路由的单数据源 |
| `src/help.ts` | `printHelp()` + `printHelpFor()` |
| `src/config.ts` | config 所有子命令处理（show/default/provider CRUD） |
| `src/test/unit/config-io.test.ts` | config.json 读写、hasFlag、injectDefaultArgs 单元测试 |
| `src/test/unit/pi-listing.test.ts` | parseModelsTable 解析逻辑单元测试 |
| `src/test/unit/commands.test.ts` | 命令注册表完整性验证 |

### 修改文件

| 文件 | 修改点 |
|------|--------|
| `src/cli.ts` | (1) `resolvePiCli` 改为从 `pi-cli-path.js` 导入；(2) 新增 `--help`/`-h` 前置拦截；(3) 新增 `config`/`help` 路由；(4) 未知命令错误提示；(5) 默认路径启动注入 |
| `src/providers.ts` | 新增 `readAuthFile()`、`maskKey()`、`findProviderDef()` |
| `src/hapilon-home.ts` | 新增 `configFilePath()` |
| `src/test/unit/providers.test.ts` | 新增 `readAuthFile` / `maskKey` / `findProviderDef` 测试 |
| `src/test/unit/hapilon-home.test.ts` | 新增 `configFilePath` 测试 |
| `src/test/integration/cli.test.ts` | 新增 help 输出、未知命令、config 集成测试 |

## 命令路由设计

```
process.argv.slice(2) = args

1. args 中任一位置出现 --help 或 -h？
   → YES: printHelp() → exit(0)

2. args[0] 是已知 hapilon 子命令？
   → "setup"     → setupInteractive / setupQuick → return
   → "doctor"    → doctor() → return
   → "config"    → handleConfig(args) → return
   → "help"      → printHelp() 或 printHelpFor(args[1]) → return

3. args[0] 存在且不以 "-" 开头？
   → YES: "未知命令: ${args[0]}" + "输入 hapilon help" → exit(1)

4. 默认路径（启动 Pi）
   → 读 config.json → injectDefaultArgs(args, config)
   → 打印 "hapilon_v0.1.0_alpha"
   → spawn pi
```

### config 子命令路由

```
hapilon config                    → configShow()
hapilon config show               → configShow()
hapilon config default --set      → configSetDefaultInteractive()
hapilon config default --unset    → configUnsetDefault()
hapilon config provider list      → configProviderList()
hapilon config provider add <id>  → configProviderAdd(id)
hapilon config provider remove <id> → configProviderRemove(id)
```

## 关键数据流

### 启动注入

```
hapilon（无参数）
  ├─ 读 ~/.hapilon/config.json → { defaultProvider, defaultModel }
  ├─ 检查 args 中是否显式含 --provider / --model
  │   → 有则跳过该字段的注入
  └─ 拼接: piArgs = injectDefaultArgs(args, config)
     → spawn(pi, [--provider X, --model Y, ...userArgs])
```

### Provider CRUD（auth.json 读-改-写）

```
add/remove → readAuthFile(agentDir) → 修改内存对象 → writeAuthFile(agentDir, updated)
```

### 模型列表获取

```
configSetDefaultInteractive()
  → 选 provider
  → spawn(pi, --list-models) with PI_CODING_AGENT_DIR
  → parseModelsTable(stdout, providerId)  // 解析 6 列表格
  → 展示给用户选
```

## pi --list-models 解析

Pi 源码 `list-models.ts` 输出格式：

```
provider  model              context  max-out  thinking  images
deepseek  deepseek-chat      128K     32K      no        no
deepseek  deepseek-reasoner  128K     32K      yes       no
```

解析策略：
- `lines.slice(1)` 跳过表头
- 每行按 `/\s{2,}/` 分割（2+ 空格）
- 取 `cols[0]` = provider, `cols[1]` = model
- `parseModelsTable` 为纯函数（接受 string，返回 ParsedModel[]），可独立单元测试

## 实现阶段

### Phase 1: 基础设施（无用户可见变更）
- 新增 `src/pi-cli-path.ts` + `src/config-io.ts` + `src/commands.ts`
- 修改 `src/providers.ts`（readAuthFile/maskKey/findProviderDef）
- 修改 `src/hapilon-home.ts`（configFilePath）
- 修改 `src/cli.ts`（import 调整）
- 编写基础设施单元测试

### Phase 2: TODO-4 help 命令
- 新增 `src/help.ts`
- 修改 `src/cli.ts`（--help 拦截 + help 路由 + 未知命令提示）
- 集成测试

### Phase 3: TODO-3 config provider CRUD
- 新增 `src/pi-listing.ts` + `src/config.ts`（provider 子命令）
- 修改 `src/cli.ts`（config 路由）
- 单元测试 + 集成测试

### Phase 4: TODO-2 默认模型
- 修改 `src/config.ts`（show/default --set/--unset）
- 修改 `src/cli.ts`（启动注入 injectDefaultArgs）
- 集成测试

## 验证步骤

```bash
# 1. 编译
npm run build

# 2. 单元测试
npm run test:unit

# 3. help 验证
node dist/cli.js --help
node dist/cli.js help
node dist/cli.js help config

# 4. 未知命令
node dist/cli.js foobar  # 应提示 help

# 5. config provider CRUD
node dist/cli.js config provider list
node dist/cli.js config provider add deepseek
node dist/cli.js config provider remove deepseek

# 6. 默认模型设置
node dist/cli.js config show
node dist/cli.js config default --set
node dist/cli.js config default --unset

# 7. 启动注入（验证默认模型传递）
# 设置默认后：hapilon → 应使用默认模型启动 pi

# 8. 用户参数覆盖
hapilon --model gpt-4o  # 应覆盖默认模型

# 9. setup 不变
node dist/cli.js setup --quick
node dist/cli.js doctor
```
