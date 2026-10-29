#!/usr/bin/env bash
# 安装或更新 Achat，并把这台电脑加入 __ACHAT_URL__ 上的 Achat 账号。
# 由 Achat 服务提供：curl -fsSL __ACHAT_URL__/install.sh | bash
# 代码从这台 Achat 服务下载，不经过 GitHub；npm 包默认用国内镜像。
set -euo pipefail

URL="__ACHAT_URL__"
NODE_VERSION=22.22.0
APP="${ACHAT_HOME:-$HOME/.achat}/app"
REGISTRY="${ACHAT_NPM_REGISTRY:-https://registry.npmmirror.com}"

say() { printf '\n== %s\n' "$*"; }
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; }

say "Node.js"
if ! node_ok; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) platform=darwin-arm64 ;;
    Darwin-x86_64) platform=darwin-x64 ;;
    Linux-x86_64) platform=linux-x64 ;;
    Linux-aarch64) platform=linux-arm64 ;;
    *) echo "这个系统还不支持，请先自己安装 Node.js 22.13 或更新版本"; exit 1 ;;
  esac
  name="node-v$NODE_VERSION-$platform"
  dir="${ACHAT_HOME:-$HOME/.achat}/node"
  mkdir -p "$dir"
  if [ ! -x "$dir/$name/bin/node" ]; then
    curl -fsSL "https://registry.npmmirror.com/-/binary/node/v$NODE_VERSION/$name.tar.gz" -o "$dir/node.tar.gz" ||
      curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.gz" -o "$dir/node.tar.gz"
    tar -xzf "$dir/node.tar.gz" -C "$dir" && rm -f "$dir/node.tar.gz"
  fi
  export PATH="$dir/$name/bin:$PATH"
fi
node --version

say "下载 Achat"
tmp="$(mktemp -d)"
curl -fsSL "$URL/download/achat.tgz" | tar -xzf - -C "$tmp"
rm -rf "$APP.old" && { [ ! -d "$APP" ] || mv "$APP" "$APP.old"; }
mkdir -p "$(dirname "$APP")" && mv "$tmp" "$APP"
cd "$APP"
npm ci --omit=dev --no-audit --no-fund --loglevel=error --registry="$REGISTRY" >/dev/null ||
  npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null
rm -rf "$APP.old"

say "配置这台电脑上的 Claude Code 和 Codex"
node "$APP/dist/cli.js" setup

say "加入账号"
node "$APP/dist/cli.js" link "$URL" --no-wait
