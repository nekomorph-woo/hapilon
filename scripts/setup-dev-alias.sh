#!/usr/bin/env bash
# setup-dev-alias.sh — 向当前用户的 shell rc 写入 devhapi 别名（幂等）
#
# devhapi = 用本仓库构建产物 dist/cli.js 启动 hapilon，
# 数据目录隔离在 ~/.hapilon-dev（不污染正式安装的 ~/.hapilon）。
#
# 用法（换机器开发时）：
#   git clone <repo> && cd hapilon
#   npm install && npm run build
#   ./scripts/setup-dev-alias.sh        # 写入别名
#   source ~/.$(basename "$SHELL")rc    # 或重开终端
#   devhapi setup                       # 首次配置 provider
#   devhapi doctor                      # 体检
#
# 可选参数：
#   --home <dir>      数据目录（默认 ~/.hapilon-dev）
#   --alias <name>    别名（默认 devhapi）
#   --rc <file>       目标 rc 文件（默认按 $SHELL 自动选择）
#   --remove          从 rc 中移除别名
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_DIR/dist/cli.js"

ALIAS_NAME="devhapi"
HAPILON_HOME_DIR="\$HOME/.hapilon-dev"
RC_FILE=""
REMOVE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --home)   HAPILON_HOME_DIR="$2"; shift 2 ;;
    --alias)  ALIAS_NAME="$2"; shift 2 ;;
    --rc)     RC_FILE="$2"; shift 2 ;;
    --remove) REMOVE=1; shift ;;
    -h|--help)
      sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "未知参数: $1（--help 查看用法）" >&2; exit 1 ;;
  esac
done

# dist 必须先构建好——别名指向的是构建产物
if [[ ! -f "$CLI" && $REMOVE -eq 0 ]]; then
  echo "✗ 未找到 $CLI"
  echo "  先构建：npm install && npm run build"
  exit 1
fi

# 目标 rc 文件：显式指定 > 按 $SHELL 推断 > 依次探测 > 兜底 .zshrc
if [[ -z "$RC_FILE" ]]; then
  case "$(basename "${SHELL:-zsh}")" in
    bash) RC_FILE="$HOME/.bashrc" ;;
    zsh)  RC_FILE="$HOME/.zshrc" ;;
    *)
      for candidate in "$HOME/.zshrc" "$HOME/.bashrc"; do
        if [[ -f "$candidate" ]]; then RC_FILE="$candidate"; break; fi
      done
      RC_FILE="${RC_FILE:-$HOME/.zshrc}"
      ;;
  esac
fi

MARKER="# devhapi (managed by hapilon scripts/setup-dev-alias.sh)"
ALIAS_LINE="alias ${ALIAS_NAME}=\"HAPILON_HOME=${HAPILON_HOME_DIR} node ${CLI}\""

if [[ $REMOVE -eq 1 ]]; then
  if [[ ! -f "$RC_FILE" ]]; then
    echo "✗ $RC_FILE 不存在，无需移除"; exit 0
  fi
  if ! grep -qF "$MARKER" "$RC_FILE"; then
    echo "ℹ $RC_FILE 中没有 devhapi 别名"; exit 0
  fi
  TMP="$(mktemp)"
  grep -vF "$MARKER" "$RC_FILE" | grep -vF "$ALIAS_LINE" > "$TMP" || true
  # 兜底：别名行可能因参数不同而与当前拼出的不一致，按标记行+下一行模式再删一次
  if grep -qF "$MARKER" "$RC_FILE"; then
    awk -v m="$MARKER" 'BEGIN{skip=0} index($0,m)==1{skip=2;next} skip>0{skip--;next} {print}' "$RC_FILE" >> "$TMP"
  fi
  mv "$TMP" "$RC_FILE"
  echo "✓ 已从 $RC_FILE 移除 devhapi 别名（重开终端生效）"
  exit 0
fi

# 触碰 rc 文件（可能不存在）
touch "$RC_FILE"

if grep -qF "$MARKER" "$RC_FILE"; then
  # 已有托管块：替换为最新值（幂等更新，路径/参数变更时同步）
  TMP="$(mktemp)"
  awk -v m="$MARKER" 'BEGIN{skip=0} index($0,m)==1{skip=2;next} skip>0{skip--;next} {print}' "$RC_FILE" > "$TMP"
  printf '%s\n%s\n' "$MARKER" "$ALIAS_LINE" >> "$TMP"
  mv "$TMP" "$RC_FILE"
  echo "✓ 已更新 $RC_FILE 中的 devhapi 别名"
else
  printf '\n%s\n%s\n' "$MARKER" "$ALIAS_LINE" >> "$RC_FILE"
  echo "✓ 已写入 $RC_FILE"
fi

echo "
  ${ALIAS_LINE}

完成。激活方式：
  source $RC_FILE   # 或重开终端
  ${ALIAS_NAME} doctor   # 验证（首次使用先 ${ALIAS_NAME} setup）"
