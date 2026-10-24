# 上游来源

- 仓库：https://github.com/Leonxlnx/taste-skill
- commit：6010f91a9935f1c167dfc500fb1a475681892e6b
- 日期：2026-10-24
- 拷贝范围：上游 `skills/taste-skill/` 目录原样（SKILL.md、references/、scripts/ 零依赖 CDP、library/ 方向库、assets/、evals/）。
- 本地改动：仅 SKILL.md 末尾追加 `<!-- hapilon: adaptation start/end -->` 标记段（输出到 .hapilon/taste、CHROME_PATH、范围分诊表、与其他 skill 的关系）。re-vendor 时保留该段。

升级流程：拉上游新 commit → 覆盖本目录（除适配段）→ 重放适配段 → 更新本文件 → 实跑 `node scripts/inspect.mjs <fixture>` 验证浏览器链路。
