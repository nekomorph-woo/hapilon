---
name: hapilon-release
description: hapilon 发版全流程编排：issue 评论 → push main → release.sh（notes/门禁/tag/pack/冒烟/Release）。用户明确命令发版时使用（「发版」「发 0.x.y」「release」）；用户没下令、版本号还没给、或只是常规提交时不用。
---

# 发版

## 目标

产出 `v<版本号>` tag、GitHub Release（附 tarball），且待发提交关联的 open issue 全部带方案评论、随 push 自动关闭。机械步骤全部由脚本执行，agent 只做三件判断活：时序编排、issue 评论起草、失败归因。

## 何时不用

- 用户没有明确命令发版——版本规范规定模型无发起权。
- 常规提交走 snap，与发版无关；讨论版本号要不要升 minor 也不触发本技能。

## 前置门槛（动手前逐条确认）

- 版本号由用户指定，且等于 package.json 当前版本——snap 提交已自动迭代 patch 位，发版本身不产生 commit，tag 直接打在 HEAD。
- 工作区干净：有未提交改动先走 snap 收尾。
- release.sh 会自检以上两条、远端同步、@earendil-works 精确锁版本，任一不过即失败退出；发现不过不要绕过，先补齐。

## 时序（钉死，不可换序）

1. `node scripts/issue-comments.mjs` → 按脚本头部起草模式读实现写评论 → `gh issue comment` 发布（只对 open issue 出候选，不设人工确认）
2. `git push origin main`
3. `./scripts/release.sh <版本号> "<一句话内容>"`——拿不准可先加 `--dry-run` 预演

评论必须在 push main 之前：push 落地那一刻 GitHub 扫描提交关键词并 auto-close，脚本只对 open issue 出候选——顺序反了候选清单里就没有它，评论只能靠自己想起补。

main 的 push 仅发生在发版流程内（提交纪律禁止主动 push，用户下令发版即授权）。

## 脚本分工

| 谁 | 步骤 |
|---|---|
| agent | issue 评论（检测脚本 + 起草 + gh issue comment）、push main、失败归因 |
| release.sh 自跑 | notes 生成（机械映射 + haiku 兜底）→ build + 全量测试 → 附注 tag + push tag → npm pack → 全新安装冒烟 → gh release create 附 tarball |

## 护栏

- 禁止手搓发版：绕过 release.sh 直接 tag / pack / gh release 就是手搓；notes 生成、tarball 冒烟、全新安装三道门不可跳。
- 脚本中途失败（set -euo pipefail 即停）先归因再动手：补丁钩子计数类报错（letters/open/shell 数字不符）是锚点失配，修 ensure-pi-patch 锚点表而不是重跑；其余失败修完根因后清理残留（`git tag -d v<版本号>`、`rm /tmp/hapilon-<版本号>.tgz`）再从头重跑。

## 交付物

一句话发版汇报：版本号、Release 链接、本次评论过的 issue、冒烟验证结果。
