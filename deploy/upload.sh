#!/usr/bin/env bash
# 在你的电脑上运行：构建 Achat，把代码、Node.js 和 Caddy 一起传到服务器，再在
# 服务器上运行 install.sh。内地服务器访问 GitHub 和 Node.js 官网常常很慢，所以
# 这些都在电脑上下载好再传过去。
#   bash deploy/upload.sh root@服务器IP achat.example.com
# 要同时写入 Resend 设置，在前面加上：
#   RESEND_API_KEY=re_xxx ACHAT_MAIL_FROM='Achat <login@example.com>' bash deploy/upload.sh ...
set -euo pipefail

TARGET="${1:?用法：bash deploy/upload.sh root@服务器IP <域名>}"
DOMAIN="${2:?用法：bash deploy/upload.sh root@服务器IP <域名>}"
NODE_VERSION=22.22.0
CADDY_VERSION=2.8.4
cd "$(dirname "$0")/.."

echo "== 检查能否登录服务器"
arch="$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" uname -m)"
case "$arch" in
  x86_64) NODE_ARCH=x64; GO_ARCH=amd64 ;;
  aarch64|arm64) NODE_ARCH=arm64; GO_ARCH=arm64 ;;
  *) echo "不认识的 CPU 架构：$arch"; exit 1 ;;
esac

echo "== 构建"
npm run build >/dev/null

echo "== 准备 Node.js 和 Caddy（下载过就不再下载）"
CACHE=deploy/.cache
mkdir -p "$CACHE"
node_tar="$CACHE/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.gz"
if [ ! -s "$node_tar" ]; then
  name="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.gz"
  curl -fsSL -o "$node_tar" "https://nodejs.org/dist/v$NODE_VERSION/$name" ||
    curl -fsSL -o "$node_tar" "https://registry.npmmirror.com/-/binary/node/v$NODE_VERSION/$name"
fi
caddy_bin="$CACHE/caddy-linux-$GO_ARCH"
if [ ! -s "$caddy_bin" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_$GO_ARCH.tar.gz" | tar -xzf - -C "$tmp" caddy
  mv "$tmp/caddy" "$caddy_bin"
  rm -rf "$tmp"
fi

echo "== 上传到 $TARGET:/opt/achat"
# COPYFILE_DISABLE 让 macOS 的 tar 不带 ._ 开头的附加文件。
COPYFILE_DISABLE=1 tar --exclude=./node_modules --exclude=./.git -czf - . |
  ssh "$TARGET" 'mkdir -p /opt/achat && tar -xzf - -C /opt/achat --no-same-owner'

echo "== 在服务器上安装"
remote_env="ACHAT_MIRROR=cn"
[ -n "${RESEND_API_KEY:-}" ] && remote_env+=" RESEND_API_KEY=$(printf %q "$RESEND_API_KEY")"
[ -n "${ACHAT_MAIL_FROM:-}" ] && remote_env+=" ACHAT_MAIL_FROM=$(printf %q "$ACHAT_MAIL_FROM")"
ssh "$TARGET" "$remote_env bash /opt/achat/deploy/install.sh $(printf %q "$DOMAIN")"
