# sessions/ 目录预留扩展

## 背景

当前 `hapilon-home.ts` 在 `ensureHapilonDirs()` 中创建了 `~/.hapilon/sessions/` 目录，但整个代码库中没有任何模块读取或写入该目录。

## 目的

为未来存储 Pi Coding Agent 的会话历史（conversation history、上下文快照等）预留目录位置。避免后续功能扩展时需要迁移用户数据。

## 预留扩展描述

| 项目 | 内容 |
|------|------|
| 目录路径 | `~/.hapilon/sessions/` |
| 创建时机 | `hapilon setup --quick` 或 `hapilon setup` 交互配置时 |
| 当前状态 | 空目录，无业务逻辑使用 |
| 预期用途 | 存储 pi 的会话历史、上下文快照、对话恢复数据 |
| 权限 | 0700（与父目录一致） |

## 参考引用

- Pi Coding Agent 文档中关于会话持久化的说明（待补充具体链接）

## 项目中指向的位置

- **创建**: `src/hapilon-home.ts:25` — `sessions: join(base, "sessions")`
- **目录定义**: `src/hapilon-home.ts:9` — `sessions: string`（HapilonDirs 接口）
- **测试验证**: `src/test/unit/hapilon-home.test.ts:68` — 验证目录路径正确性
- **测试验证**: `src/test/unit/setup.test.ts:43` — 验证 setupQuick() 创建该目录
