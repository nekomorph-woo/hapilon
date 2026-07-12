# logs/ 目录预留扩展

## 背景

当前 `hapilon-home.ts` 在 `ensureHapilonDirs()` 中创建了 `~/.hapilon/logs/` 目录，但整个代码库中没有任何模块读取或写入该目录。

## 目的

为未来存储 Hapilon 自身的运行日志（启动日志、错误日志、诊断信息等）预留目录位置。当前诊断信息仅通过 `console.log` 输出到 stdout。

## 预留扩展描述

| 项目 | 内容 |
|------|------|
| 目录路径 | `~/.hapilon/logs/` |
| 创建时机 | `hapilon setup --quick` 或 `hapilon setup` 交互配置时 |
| 当前状态 | 空目录，无业务逻辑使用 |
| 预期用途 | 持久化运行日志、错误追踪、性能指标、调试信息 |
| 权限 | 0700（与父目录一致） |

## 参考引用

- 无

## 项目中指向的位置

- **创建**: `src/hapilon-home.ts:26` — `logs: join(base, "logs")`
- **目录定义**: `src/hapilon-home.ts:10` — `logs: string`（HapilonDirs 接口）
- **测试验证**: `src/test/unit/hapilon-home.test.ts:69` — 验证目录路径正确性
- **测试验证**: `src/test/unit/setup.test.ts:44` — 验证 setupQuick() 创建该目录
