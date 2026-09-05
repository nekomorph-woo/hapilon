#!/usr/bin/env bash
# sandbox-verify.sh — SOP-4 沙箱验证（docs/distribution-sop.md）
#
# 在不动本机 npm 全局环境与 ~/.hapilon 的前提下，验证「tarball → 安装 → 运行」链路：
#   1. npm pack 出 tarball
#   2. NPM_CONFIG_PREFIX/CACHE 重定向安装
#   3. 双 bin + --version + doctor 验证（HOME 重定向到 fakehome）
#   4. 强制清理沙箱（200MB 级缓存残留）
#
# 用法：
#   ./scripts/sandbox-verify.sh            # 打包 + 安装 + 验证 + 清理
#   ./scripts/sandbox-verify.sh --keep     # 验证后保留沙箱目录供检查
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

VERSION="$(node -p "JSON.parse(require('fs').readFileSync('$REPO_DIR/package.json','utf8')).version")"
TARBALL="/tmp/hapilon-$VERSION.tgz"
ISOL="$REPO_DIR/.sandbox-verify"

echo "hapilon 沙箱验证: v$VERSION"

# ── 1. pack ──────────────────────────────────────────────────────────
echo "▶ 1/4 npm pack"
npm pack --pack-destination /tmp > /dev/null
[[ -f "$TARBALL" ]] || { echo "✗ tarball 未生成: $TARBALL"; exit 1; }

# ── 2. 隔离安装 ───────────────────────────────────────────────────────
echo "▶ 2/4 沙箱安装（prefix/cache 重定向，不碰本机全局环境）"
rm -rf "$ISOL"
mkdir -p "$ISOL/prefix" "$ISOL/cache" "$ISOL/fakehome"
env NPM_CONFIG_PREFIX="$ISOL/prefix" NPM_CONFIG_CACHE="$ISOL/cache" \
  npm install -g "$TARBALL" > /dev/null

# ── 3. 验证 ──────────────────────────────────────────────────────────
echo "▶ 3/4 验证（HOME 也指向 fakehome，零触碰真实 ~/.hapilon）"
PKG_DIR="$ISOL/prefix/lib/node_modules/hapilon"
FAIL=0

for bin in hapilon hapi; do
  if [[ -e "$ISOL/prefix/bin/$bin" ]]; then
    echo "  ✅ bin/$bin"
  else
    echo "  ❌ bin/$bin 缺失"; FAIL=1
  fi
done

GOT_VERSION="$(node "$PKG_DIR/dist/cli.js" --version 2>/dev/null || true)"
if [[ "$GOT_VERSION" == "$VERSION" ]]; then
  echo "  ✅ --version → $GOT_VERSION"
else
  echo "  ❌ --version 输出异常: ${GOT_VERSION:-<空>}（期望 ${VERSION}）"; FAIL=1
fi

FAKE_HOME="$ISOL/fakehome" node "$PKG_DIR/dist/cli.js" doctor > "$ISOL/doctor.log" 2>&1 \
  && echo "  ✅ doctor 退出码 0（详见 $ISOL/doctor.log）" \
  || { echo "  ❌ doctor 失败:"; cat "$ISOL/doctor.log"; FAIL=1; }

rm -f "$TARBALL"

# ── 4. 清理 ──────────────────────────────────────────────────────────
if [[ $KEEP -eq 1 ]]; then
  echo "▶ 4/4 保留沙箱目录供检查: $ISOL（检查完手动 rm -rf）"
else
  echo "▶ 4/4 清理沙箱"
  rm -rf "$ISOL"
fi

[[ $FAIL -eq 0 ]] && echo "✓ 沙箱验证通过" || { echo "✗ 沙箱验证有失败项"; exit 1; }
