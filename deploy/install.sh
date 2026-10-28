#!/usr/bin/env bash
# 在服务器上以 root 运行，装好或更新 Achat 云端服务：
#   bash /opt/achat/deploy/install.sh achat.example.com
#
# 代码和下载好的 Node.js、Caddy 通常由电脑上的 deploy/upload.sh 传上来（放在
# /opt/achat 和 /opt/achat/deploy/.cache）。没有上传时，从 GitHub 和官网下载。
# ACHAT_MIRROR=cn：Node.js 和 npm 包优先用国内镜像。
# RESEND_API_KEY、ACHAT_MAIL_FROM：给了就写进设置文件。
# 重复运行是安全的：已有的设置和数据不动。
set -euo pipefail

DOMAIN="${1:?用法：bash install.sh <域名>，例如 bash install.sh achat.example.com}"
APP=/opt/achat
REPO="${ACHAT_REPO:-https://github.com/fangsaturday6/Achat.git}"
BRANCH="${ACHAT_BRANCH:-claude/achat-decisions}"
NODE_VERSION=22.22.0
CADDY_VERSION=2.8.4
MIRROR="${ACHAT_MIRROR:-}"

say() { printf '\n== %s\n' "$*"; }
fetch() { # fetch <输出文件> <网址>...：依次尝试，直到有一个成功
  local out="$1"; shift
  for url in "$@"; do
    if curl -fsSL --connect-timeout 15 --retry 2 -o "$out" "$url"; then return 0; fi
    echo "  下载失败：$url"
  done
  return 1
}

[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }
command -v systemctl >/dev/null || { echo "这台服务器没有 systemd，install.sh 不支持"; exit 1; }
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64; GO_ARCH=amd64 ;;
  aarch64|arm64) NODE_ARCH=arm64; GO_ARCH=arm64 ;;
  *) echo "不认识的 CPU 架构：$(uname -m)"; exit 1 ;;
esac
CACHE="$APP/deploy/.cache"

say "Node.js"
if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  tarball="$CACHE/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.gz"
  if [ ! -f "$tarball" ]; then
    mkdir -p "$CACHE"
    name="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.gz"
    official="https://nodejs.org/dist/v$NODE_VERSION/$name"
    cn="https://registry.npmmirror.com/-/binary/node/v$NODE_VERSION/$name"
    if [ "$MIRROR" = cn ]; then fetch "$tarball" "$cn" "$official"; else fetch "$tarball" "$official" "$cn"; fi
  fi
  mkdir -p /usr/local/lib/nodejs
  tar -xzf "$tarball" -C /usr/local/lib/nodejs
  for bin in node npm npx; do
    ln -sf "/usr/local/lib/nodejs/node-v$NODE_VERSION-linux-$NODE_ARCH/bin/$bin" "/usr/local/bin/$bin"
  done
fi
export PATH="/usr/local/bin:$PATH"
node --version

say "代码"
npm_flags=(--no-audit --no-fund)
[ "$MIRROR" = cn ] && npm_flags+=(--registry=https://registry.npmmirror.com)
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch origin "$BRANCH"
  git -C "$APP" checkout -B "$BRANCH" "origin/$BRANCH"
  cd "$APP" && npm ci "${npm_flags[@]}" && npm run build
elif [ -f "$APP/dist/cli.js" ]; then
  echo "使用上传的代码（已在电脑上构建好）"
  cd "$APP" && npm ci --omit=dev "${npm_flags[@]}"
else
  command -v git >/dev/null || { echo "没有 git，也没有上传的代码。请在电脑上运行 deploy/upload.sh"; exit 1; }
  git clone --branch "$BRANCH" "$REPO" "$APP"
  cd "$APP" && npm ci "${npm_flags[@]}" && npm run build
fi

say "设置：/etc/achat/achat.env"
id achat >/dev/null 2>&1 || useradd --system --home-dir /var/lib/achat --create-home --shell /usr/sbin/nologin achat
mkdir -p /etc/achat /var/lib/achat
chown achat:achat /var/lib/achat
ENV=/etc/achat/achat.env
if [ ! -f "$ENV" ]; then
  sed "s#achat.example.com#$DOMAIN#" "$APP/deploy/achat.env.example" > "$ENV"
fi
chmod 600 "$ENV"
set_env() { # set_env <名字> <值>
  if grep -q "^$1=" "$ENV"; then
    local escaped; escaped="$(printf '%s' "$2" | sed 's/[#&\\]/\\&/g')"
    sed -i "s#^$1=.*#$1=$escaped#" "$ENV"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV"
  fi
}
set_env ACHAT_PUBLIC_URL "https://$DOMAIN"
[ -n "${RESEND_API_KEY:-}" ] && set_env RESEND_API_KEY "$RESEND_API_KEY"
[ -n "${ACHAT_MAIL_FROM:-}" ] && set_env ACHAT_MAIL_FROM "$ACHAT_MAIL_FROM"
grep -q '^RESEND_API_KEY=.\+' "$ENV" || echo "还没填 RESEND_API_KEY：验证码只会打印在 journalctl -u achat 里"

say "Achat 服务"
sed "s#/usr/bin/node#$(command -v node)#" "$APP/deploy/achat.service" > /etc/systemd/system/achat.service
systemctl daemon-reload
systemctl enable achat >/dev/null
systemctl restart achat

say "Caddy（自动申请 HTTPS 证书）"
if [ ! -x /usr/local/bin/caddy ] || ! /usr/local/bin/caddy version | grep -q "v$CADDY_VERSION"; then
  if [ -f "$CACHE/caddy-linux-$GO_ARCH" ]; then
    install -m 755 "$CACHE/caddy-linux-$GO_ARCH" /usr/local/bin/caddy
  else
    tmp="$(mktemp -d)"
    if fetch "$tmp/caddy.tar.gz" "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_$GO_ARCH.tar.gz"; then
      tar -xzf "$tmp/caddy.tar.gz" -C "$tmp" caddy
    else
      fetch "$tmp/caddy" "https://caddyserver.com/api/download?os=linux&arch=$GO_ARCH" || { echo "下载不了 Caddy。请在电脑上运行 deploy/upload.sh，它会把 Caddy 一起传上来"; exit 1; }
    fi
    install -m 755 "$tmp/caddy" /usr/local/bin/caddy
    rm -rf "$tmp"
  fi
fi
id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
mkdir -p /etc/caddy
sed "s#achat.example.com#$DOMAIN#" "$APP/deploy/Caddyfile" > /etc/caddy/Caddyfile
cp "$APP/deploy/caddy.service" /etc/systemd/system/caddy.service
systemctl daemon-reload
systemctl enable caddy >/dev/null
systemctl restart caddy

say "检查"
sleep 2
if curl -fsS http://127.0.0.1:8080/api/health >/dev/null; then
  echo "Achat 在服务器上正常运行"
else
  echo "Achat 没有启动起来，最近的日志："
  journalctl -u achat -n 20 --no-pager || true
  exit 1
fi
cat <<DONE

装好了。还需要确认：
  1. 域名 $DOMAIN 的 A 记录指向这台服务器的公网 IP；
  2. 阿里云安全组（轻量应用服务器叫“防火墙”）放行 80 和 443 端口；
  3. 域名已经完成 ICP 备案。

然后打开 https://$DOMAIN 。证书第一次申请可能要一两分钟。
日志：journalctl -u achat -f    Caddy 日志：journalctl -u caddy -f
DONE
