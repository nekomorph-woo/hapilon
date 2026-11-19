# 上游来源

- 仓库：https://github.com/QingYunA/answer-me-with-html
- 版本：v0.6.1（commit 9908ace6ee9254d51cb88e3b6db93738f2a90b53）
- 日期：2026-11-20
- 拷贝范围：上游 `skills/answer-me-with-html/` 目录原样（SKILL.md、references/、scripts/am.mjs 自包含 CLI、licenses/）。
- 本地改动：仅 SKILL.md 两处——① 末尾追加 `<!-- hapilon: adaptation start/end -->` 标记段（CLI 调用方式、AM_HOME、禁用 am update、深度/广度前置反问、description 改写说明）；② frontmatter description 改写为「仅用户明确要求时调用」（上游原文是 proactive 触发语，见适配段末条）。re-vendor 时保留该段与改写后的 description。

升级流程：拉上游新 commit → 用上游 `skills/answer-me-with-html/` 覆盖本目录（除适配段外零改动）→ 把适配段重放到 SKILL.md 末尾 → 更新本文件 commit 与日期 → 实测 `node scripts/am.mjs render -` 渲染一页。
