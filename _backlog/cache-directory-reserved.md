# cache/ 目录预留扩展

## 背景

当前 `hapilon-home.ts` 在 `ensureHapilonDirs()` 中创建了 `~/.hapilon/cache/` 目录，但整个代码库中没有任何模块读取或写入该目录。

## 目的

为未来存储缓存数据（API 响应缓存、模型列表缓存、自动补全缓存等）预留目录位置。避免重复请求或加速冷启动。

## 预留扩展描述

| 项目 | 内容 |
|------|------|
| 目录路径 | `~/.hapilon/cache/` |
| 创建时机 | `hapilon setup --quick` 或 `hapilon setup` 交互配置时 |
| 当前状态 | 空目录，无业务逻辑使用 |
| 预期用途 | API 响应缓存、模型列表缓存、provider 元数据缓存、临时计算结果 |
| 权限 | 0700（与父目录一致） |

## 参考引用

- 无

## 项目中指向的位置

- **创建**: `src/hapilon-home.ts:27` — `cache: join(base, "cache")`
- **目录定义**: `src/hapilon-home.ts:11` — `cache: string`（HapilonDirs 接口）
- **测试验证**: `src/test/unit/hapilon-home.test.ts:70` — 验证目录路径正确性
- **测试验证**: `src/test/unit/setup.test.ts:45` — 验证 setupQuick() 创建该目录
