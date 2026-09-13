#!/usr/bin/env bash
# release.sh — 发版全流程（README「发版打包流程」）
#
# 用法：
#   ./scripts/release.sh <patch|minor> "<一句话内容>"
#   ./scripts/release.sh --notes <文件> <patch|minor> "<一句话内容>"   # 自定义 Release 说明全文
#   ./scripts/release.sh --dry-run patch "修复 xxx"   # 只打印将执行的命令
#
# 流程：版本号升级 → 依赖精确锁定检查 → build + 全量测试门禁 → commit →
#       附注 tag → push → npm pack → 全新安装冒烟验证（版本号 + 补丁钩子） →
#       gh release create 附 tarball → 清理
#
# 前置：源码已全部合入当前分支且工作区干净；dist/ 与 src/ 一致（脚本会重新 build 保证）。
#       @earendil-works 系依赖必须精确锁版本（无 ^ ~）——范围依赖在全新安装时会漂移到
#       未验证版本导致补丁锚点失配（v0.4.0 事故）。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
# node -p 的 require 相对 cwd 而非脚本位置，用绝对路径注入（含引号转义）
REPO_DIR_JSON="$(node -p "JSON.stringify(process.argv[1])" "$REPO_DIR")"

DRY_RUN=0
NOTES_FILE=""
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --notes) NOTES_FILE="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

BUMP="${ARGS[0]:-}"
SUMMARY="${ARGS[1]:-}"

usage() {
  echo "用法: $0 [--dry-run] [--notes <文件>] <patch|minor> \"<一句话内容>\"" >&2
  exit 1
}
[[ "$BUMP" =~ ^(patch|minor)$ && -n "$SUMMARY" ]] || usage
[[ -z "$NOTES_FILE" || -f "$NOTES_FILE" ]] || { echo "✗ notes 文件不存在: $NOTES_FILE" >&2; exit 1; }

# ── 前置检查 ──────────────────────────────────────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ 工作区不干净，先 commit/stash："; git status --short; exit 1
fi

# @earendil-works 依赖必须精确锁版本：范围依赖（^ ~）在用户全新安装时会被
# registry 解析到未验证版本，补丁锚点失配、中段补全失效（v0.4.0 事故）
while IFS='=' read -r name range; do
  [[ -n "$name" ]] || continue
  if [[ "$range" == ^* || "$range" == ~* ]]; then
    echo "✗ $name 用了范围依赖（${range}）——请精确锁版本（如 0.85.1）后重试"; exit 1
  fi
done < <(node -p "Object.entries(require($REPO_DIR_JSON + '/package.json').dependencies).filter(([n]) => n.includes('@earendil-works')).map(([n, v]) => n + '=' + v).join('\\n')")

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
  echo "  [dry-run] 全新安装冒烟验证（版本号 + 补丁钩子）"
  echo "  [dry-run] gh release create ${TAG} /tmp/${TARBALL} $([[ -n $NOTES_FILE ]] && echo --notes-file $NOTES_FILE || echo --generate-notes)"
  exit 0
fi
read -rp "继续? [y/N] " yn; [[ "$yn" == "y" ]] || exit 1

# ── 1. 升版本号 ───────────────────────────────────────────────────────
echo "▶ 1/7 升版本号"
npm version "$NEW_VERSION" --no-git-tag-version > /dev/null

# ── 2. build + 测试门禁 ───────────────────────────────────────────────
echo "▶ 2/7 build + 全量测试（不绿即中止并回滚版本号）"
if ! npm run build > /dev/null 2>&1; then
  echo "✗ build 失败"; npm version "$OLD_VERSION" --no-git-tag-version > /dev/null; exit 1
fi
if ! npm test > /tmp/hapilon-release-test.log 2>&1; then
  echo "✗ 测试不绿，详见 /tmp/hapilon-release-test.log"
  npm version "$OLD_VERSION" --no-git-tag-version > /dev/null; exit 1
fi
echo "  测试全绿"

# ── 3. 提交 ──────────────────────────────────────────────────────────
echo "▶ 3/7 提交版本变更（含 dist）"
git add package.json package-lock.json dist/
git commit -m "chore(release): ${TAG}——$SUMMARY"

# ── 4. tag + push（HTTPS 失败回退 ssh）────────────────────────────────
echo "▶ 4/7 打附注 tag 并推送"
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
echo "▶ 5/7 npm pack"
npm pack --pack-destination /tmp > /dev/null
[[ -f "/tmp/$TARBALL" ]] || { echo "✗ tarball 未生成: /tmp/$TARBALL"; exit 1; }

echo "▶ 6/7 全新安装冒烟验证"
SMOKE_DIR="$(mktemp -d)"
cleanup_smoke() { rm -rf "$SMOKE_DIR"; }
if ! npm install --prefix "$SMOKE_DIR" --no-audit --no-fund "/tmp/$TARBALL" > /dev/null 2>&1; then
  echo "✗ 全新安装失败（tarball 不可安装，不上 Release）"; cleanup_smoke; exit 1
fi
SMOKE_BIN="$SMOKE_DIR/node_modules/.bin/hapilon"
[[ -x "$SMOKE_BIN" ]] || { echo "✗ 安装后无 hapilon 可执行"; cleanup_smoke; exit 1; }
SMOKE_VERSION="$("$SMOKE_BIN" --version 2>/dev/null | tail -1)"
[[ "$SMOKE_VERSION" == "$NEW_VERSION" ]] || { echo "✗ 版本不符: $SMOKE_VERSION ≠ $NEW_VERSION"; cleanup_smoke; exit 1; }
# 运行时 pi-tui = pi-coding-agent 的嵌套副本（npm 解析优先），其次才是提升层
RUNTIME_TUI=""
for candidate in \
  "$SMOKE_DIR/node_modules/hapilon/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui" \
  "$SMOKE_DIR/node_modules/@earendil-works/pi-tui"; do
  [[ -f "$candidate/dist/components/editor.js" ]] && RUNTIME_TUI="$candidate/dist/components/editor.js" && break
done
[[ -n "$RUNTIME_TUI" ]] || { echo "✗ 未找到运行时 pi-tui"; cleanup_smoke; exit 1; }
LETTERS=$(grep -oF '__hapiMidTextSlash?.' "$RUNTIME_TUI" | wc -l | tr -d ' ')
OPEN=$(grep -oF '__hapiMidTextSlashOpen?.' "$RUNTIME_TUI" | wc -l | tr -d ' ')
if [[ "$LETTERS" != "3" || "$OPEN" != "1" ]]; then
  echo "✗ 补丁钩子未落在运行时副本（letters=$LETTERS open=${OPEN}）——中段补全会失效，不上 Release"
  cleanup_smoke; exit 1
fi
# 后台任务插件的 Windows shell 补丁（写死的 /bin/sh 在 Windows 上 spawn 失败）
RUNTIME_BG=""
for candidate in \
  "$SMOKE_DIR/node_modules/hapilon/node_modules/@nklisch/pi-background-tasks/extensions/background-tasks.ts" \
  "$SMOKE_DIR/node_modules/@nklisch/pi-background-tasks/extensions/background-tasks.ts"; do
  [[ -f "$candidate" ]] && RUNTIME_BG="$candidate" && break
done
[[ -n "$RUNTIME_BG" ]] || { echo "✗ 未找到后台任务插件（background/monitor 不可用）"; cleanup_smoke; exit 1; }
BG_SPAWN=$(grep -oF 'shell: hapiShell(),' "$RUNTIME_BG" | wc -l | tr -d ' ')
BG_EXEC=$(grep -oF 'pi.exec!(hapiShell(),' "$RUNTIME_BG" | wc -l | tr -d ' ')
if [[ "$BG_SPAWN" != "1" || "$BG_EXEC" != "1" ]]; then
  echo "✗ 后台任务 shell 补丁未落在已安装插件（spawn=$BG_SPAWN exec=$BG_EXEC）——Windows 上派发链会失效，不上 Release"
  cleanup_smoke; exit 1
fi
cleanup_smoke
echo "  版本 $SMOKE_VERSION ✓ 补丁钩子 letters=3 open=1 shell=1+1 ✓"

echo "▶ 7/7 建 Release 并附 tarball"
if [[ -n "$NOTES_FILE" ]]; then
  gh release create "$TAG" "/tmp/$TARBALL" --title "$TAG" --notes-file "$NOTES_FILE"
else
  gh release create "$TAG" "/tmp/$TARBALL" --title "$TAG" --generate-notes
fi

rm "/tmp/$TARBALL"
echo "✓ 发版完成: ${TAG}（Release 页面已附 ${TARBALL}）"
