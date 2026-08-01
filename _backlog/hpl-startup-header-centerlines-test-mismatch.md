# hpl-startup-header centerLines 测试断言与实现不符（3 个红灯）

## 背景

2026-08-01 全量单测（`npm run test:unit`）时发现 `hpl-startup-header.test.js` 有 3 个失败，git stash 验证为**预先存在**（初始提交 68dc68f 起即红灯，非回归）。同期 issue #12（hpl-footer CJK 宽度）修复不涉及此扩展。

## 目的

3 个红灯长期掩盖真实信号：`npm run test:unit` 的「fail 0」是假性期望，任何人改动 startup-header 时无法区分新旧失败。需决策：修测试断言（确认实现语义）或改实现为两端居中。

## 技术债/预留扩展描述

| 项目 | 内容 |
|------|------|
| 失败用例 1 | `centerLines(["hi"], 10)` 断言 `result[0].length === 4`（实际 6 = pad 4 + "hi" 2） |
| 失败用例 2 | `centerLines([""], 10)` 断言 10 个空格（实际 5 = floor(10/2)） |
| 失败用例 3 | 第三个用例同为 centerLines 系列（同断言风格） |
| 根因 | `centerLines` 实现为「左缩进式居中」（仅左补空格，行不填满），测试把 padding 数量断言成了整行长度，断言语义与实现语义不符 |
| 决策选项 | A. 修测试断言为「行 = pad + 原行」语义；B. 改实现为两端居中（左右均补，行填满 maxWidth）——需 hpl-startup-header 维护者确认期望的视觉语义 |

## 参考引用

- 无（未开 ticket）

## 项目中指向的位置

- **实现**: `src/extensions/hpl-startup-header/content.ts:152-159` — `centerLines()`（左缩进式居中）
- **测试**: `src/test/unit/hpl-startup-header.test.ts:188` — 「短文本在宽列中居中」
- **测试**: `src/test/unit/hpl-startup-header.test.ts:199` — 「空字符串对齐」
- **全量验证**: `npm run test:unit` — 3 fail（fail 均为本 backlog）
