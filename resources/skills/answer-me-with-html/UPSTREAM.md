# 上游来源

- 仓库：https://github.com/QingYunA/answer-me-with-html
- 版本：v0.5.11（commit 6f434a8c4f901995757948f8c435c5563cee82f0）
- 日期：2026-11-05
- 拷贝范围：上游 `skills/answer-me-with-html/` 目录原样（SKILL.md、references/、scripts/am.mjs 自包含 CLI、licenses/）。
- 本地改动：仅 SKILL.md 末尾追加 `<!-- hapilon: adaptation start/end -->` 标记段（CLI 调用方式、AM_HOME、禁用 am update、深度/广度前置反问）。re-vendor 时保留该段。

升级流程：拉上游新 commit → 用上游 `skills/answer-me-with-html/` 覆盖本目录（除适配段外零改动）→ 把适配段重放到 SKILL.md 末尾 → 更新本文件 commit 与日期 → 实测 `node scripts/am.mjs render -` 渲染一页。
