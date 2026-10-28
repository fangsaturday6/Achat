#!/usr/bin/env bash
# 在服务器上以 root 运行，装好或更新 Achat 云端服务：
#   bash install.sh achat.example.com
# 重复运行是安全的：会拉取最新代码、重新构建、重启服务，已有的设置和数据不动。
set -euo pipefail

DOMAIN="${1:?用法：bash install.sh <域名>，例如 bash install.sh achat.example.com}"
REPO="${ACHAT_REPO:-https://github.com/fangsaturday6/Achat.git}"
BRANCH="${ACHAT_BRANCH:-claude/achat-decisions}"
CADDY_VERSION="2.8.4"

say() { printf '\n== %s\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "请用 root 运行（sudo bash install.sh $DOMAIN）"; exit 1; }
command -v systemctl >/dev/null || { echo "这台服务器没有 systemd，install.sh 不支持"; exit 1; }

say "Node.js 22"
need_node=1
if command -v node >/dev/null; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' && need_node=0
fi
if [ "$need_node" = 1 ]; then
  if command -v apt-get >/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs git
  elif command -v dnf >/dev/null || command -v yum >/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    (command -v dnf >/dev/null && dnf install -y nodejs git) || yum install -y nodejs git
  else
    echo "请先手动安装 Node.js 22.13 或更新版本和 git，再运行这个脚本"; exit 1
  fi
fi
command -v git >/dev/null || { (command -v apt-get >/dev/null && apt-get install -y git) || (command -v dnf >/dev/null && dnf install -y git) || yum install -y git; }
node --version

say "代码：$REPO（$BRANCH）"
id achat >/dev/null 2>&1 || useradd --system --home-dir /var/lib/achat --create-home --shell /usr/sbin/nologin achat
if [ -d /opt/achat/.git ]; then
  git -C /opt/achat fetch origin "$BRANCH"
  git -C /opt/achat checkout -B "$BRANCH" "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO" /opt/achat
fi
cd /opt/achat
npm ci --no-audit --no-fund
npm run build

say "设置：/etc/achat/achat.env"
mkdir -p /etc/achat /var/lib/achat
chown achat:achat /var/lib/achat
if [ ! -f /etc/achat/achat.env ]; then
  sed "s#achat.example.com#$DOMAIN#" deploy/achat.env.example > /etc/achat/achat.env
  chmod 600 /etc/achat/achat.env
  echo "已生成。填好 RESEND_API_KEY 和 ACHAT_MAIL_FROM 后运行：systemctl restart achat"
fi

say "Achat 服务"
sed "s#/usr/bin/node#$(command -v node)#" deploy/achat.service > /etc/systemd/system/achat.service
systemctl daemon-reload
systemctl enable achat >/dev/null
systemctl restart achat

say "Caddy（自动申请 HTTPS 证书）"
if [ ! -x /usr/local/bin/caddy ] || ! /usr/local/bin/caddy version | grep -q "v$CADDY_VERSION"; then
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "不认识的 CPU 架构：$(uname -m)"; exit 1 ;;
  esac
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_$arch.tar.gz" | tar -xz -C "$tmp" caddy
  install -m 755 "$tmp/caddy" /usr/local/bin/caddy
  rm -rf "$tmp"
fi
id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
mkdir -p /etc/caddy
sed "s#achat.example.com#$DOMAIN#" deploy/Caddyfile > /etc/caddy/Caddyfile
cp deploy/caddy.service /etc/systemd/system/caddy.service
systemctl daemon-reload
systemctl enable caddy >/dev/null
systemctl restart caddy

say "检查"
sleep 2
systemctl --no-pager --lines=5 status achat || true
if curl -fsS http://127.0.0.1:8080/api/health >/dev/null; then echo "Achat 在本机正常运行"; fi
cat <<DONE

装好了。还需要确认三件事：
  1. 域名 $DOMAIN 的 A 记录指向这台服务器的公网 IP；
  2. 阿里云安全组放行 80 和 443 端口（入方向）；
  3. 服务器在中国内地的话，域名要先完成 ICP 备案，否则 80/443 会被拦截。

然后在浏览器打开 https://$DOMAIN 。证书第一次申请可能要一两分钟。
日志：journalctl -u achat -f    Caddy 日志：journalctl -u caddy -f
DONE
