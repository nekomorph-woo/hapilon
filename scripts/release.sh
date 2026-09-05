#!/usr/bin/env bash
# release.sh — 发版全流程（README「发版打包流程」）
#
# 用法：
#   ./scripts/release.sh <patch|minor> "<一句话内容>"
#   ./scripts/release.sh --dry-run patch "修复 xxx"   # 只打印将执行的命令
#
# 流程：版本号升级 → build + 全量测试门禁 → commit → 附注 tag → push →
#       npm pack → gh release create 附 tarball → 清理
#
# 前置：源码已全部合入当前分支且工作区干净；dist/ 与 src/ 一致（脚本会重新 build 保证）。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
# node -p 的 require 相对 cwd 而非脚本位置，用绝对路径注入（含引号转义）
REPO_DIR_JSON="$(node -p "JSON.stringify(process.argv[1])" "$REPO_DIR")"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1; shift
fi

BUMP="${1:-}"
SUMMARY="${2:-}"

usage() {
  echo "用法: $0 [--dry-run] <patch|minor> \"<一句话内容>\"" >&2
  exit 1
}
[[ "$BUMP" =~ ^(patch|minor)$ && -n "$SUMMARY" ]] || usage

# ── 前置检查 ──────────────────────────────────────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ 工作区不干净，先 commit/stash："; git status --short; exit 1
fi

read_version() { node -p "require($REPO_DIR_JSON + '/package.json').version"; }
OLD_VERSION="$(read_version)"
IFS='.' read -r MAJOR MINOR PATCH <<< "$OLD_VERSION"
if [[ "$BUMP" == "minor" ]]; then
  MINOR=$((MINOR + 1)); PATCH=0
else
  PATCH=$((PATCH + 1))
fi
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
TARBALL="hapilon-$NEW_VERSION.tgz"
TAG="v$NEW_VERSION"
# HTTPS push 失败（LibreSSL/代理）时的回退通道
SSH_REMOTE="git@github.com:nekomorph-woo/hapilon.git"

run() {
  if [[ $DRY_RUN -eq 1 ]]; then echo "  [dry-run] $*"; else eval "$@"; fi
}

echo "hapilon 发版: ${OLD_VERSION} → ${NEW_VERSION} ($BUMP)"
echo "  tag: ${TAG}  tarball: ${TARBALL}  内容: ${SUMMARY}"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "  [dry-run] npm version ${NEW_VERSION} --no-git-tag-version"
  echo "  [dry-run] npm run build && npm test（门禁）"
  echo "  [dry-run] git add package.json package-lock.json dist/"
  echo "  [dry-run] git commit -m 'chore(release): ${TAG}——${SUMMARY}'"
  echo "  [dry-run] git tag -a ${TAG} && git push（HTTPS 失败回退 ${SSH_REMOTE}）"
  echo "  [dry-run] npm pack → /tmp/${TARBALL}"
  echo "  [dry-run] gh release create ${TAG} /tmp/${TARBALL} --generate-notes"
  exit 0
fi
read -rp "继续? [y/N] " yn; [[ "$yn" == "y" ]] || exit 1

# ── 1. 升版本号 ───────────────────────────────────────────────────────
echo "▶ 1/6 升版本号"
npm version "$NEW_VERSION" --no-git-tag-version > /dev/null

# ── 2. build + 测试门禁 ───────────────────────────────────────────────
echo "▶ 2/6 build + 全量测试（不绿即中止并回滚版本号）"
if ! npm run build > /dev/null 2>&1; then
  echo "✗ build 失败"; npm version "$OLD_VERSION" --no-git-tag-version > /dev/null; exit 1
fi
if ! npm test > /tmp/hapilon-release-test.log 2>&1; then
  echo "✗ 测试不绿，详见 /tmp/hapilon-release-test.log"
  npm version "$OLD_VERSION" --no-git-tag-version > /dev/null; exit 1
fi
echo "  测试全绿"

# ── 3. 提交 ──────────────────────────────────────────────────────────
echo "▶ 3/6 提交版本变更（含 dist）"
git add package.json package-lock.json dist/
git commit -m "chore(release): $TAG——$SUMMARY"

# ── 4. tag + push（HTTPS 失败回退 ssh）────────────────────────────────
echo "▶ 4/6 打附注 tag 并推送"
git tag -a "$TAG" -m "$TAG
$SUMMARY"
BRANCH="$(git branch --show-current)"
if ! git push origin "$TAG" 2>/dev/null; then
  echo "  HTTPS push 失败，改用 ssh 通道"
  git push "$SSH_REMOTE" "$TAG" "$BRANCH"
else
  if ! git push origin "$BRANCH" 2>/dev/null; then
    git push "$SSH_REMOTE" "$BRANCH"
  fi
fi

# ── 5. pack ──────────────────────────────────────────────────────────
echo "▶ 5/6 npm pack"
npm pack --pack-destination /tmp > /dev/null
[[ -f "/tmp/$TARBALL" ]] || { echo "✗ tarball 未生成: /tmp/$TARBALL"; exit 1; }

# ── 6. Release ───────────────────────────────────────────────────────
echo "▶ 6/6 建 Release 并附 tarball"
gh release create "$TAG" "/tmp/$TARBALL" --title "$TAG" --generate-notes

rm "/tmp/$TARBALL"
echo "✓ 发版完成: $TAG（Release 页面已附 $TARBALL）"
