# 把 Achat 部署到阿里云（内地服务器）

给代为部署的 AI 和人看的步骤。前提：服务器在中国内地，域名已经完成 ICP 备案，验证码用 Resend 发。

操作分两处：
- **浏览器**：阿里云控制台、Resend。主人自己登录，登录后的点击可以由 AI 代劳。
- **主人电脑上的终端**：在 Achat 代码目录（例如 `~/code/Achat`）里运行命令，通过 SSH 操作服务器。

不要在对话、提交记录或日志里留下密码和 API Key。

## 0. 先问主人这几样

| 要什么 | 从哪来 |
| --- | --- |
| 服务器公网 IP | 阿里云控制台 → 云服务器 ECS（或轻量应用服务器）→ 实例列表 |
| 用哪个域名 | 已备案的域名下新开一个子域名，例如 `achat.example.com` |
| 发件邮箱 | 例如 `login@example.com`；不用真的存在，只要域名在 Resend 验证过 |

下文用 `IP`、`achat.example.com`、`example.com` 代指。

## 1. 让电脑能 SSH 登录服务器

```sh
ssh -o BatchMode=yes -o ConnectTimeout=15 root@IP true && echo 可以登录
```

能登录就跳到第 2 步。不能的话：

1. 电脑上没有钥匙就生成一把：`test -f ~/.ssh/id_ed25519 || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519`。
2. 复制公钥：`cat ~/.ssh/id_ed25519.pub`。
3. 浏览器里：阿里云控制台 → 实例 → “远程连接” → Workbench，以 root 登录。需要密码时请主人自己输入。
4. 在 Workbench 的终端里运行（把引号里换成上一步的公钥整行）：
   ```sh
   mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo 'ssh-ed25519 AAAA... 主人的电脑' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
   ```
5. 回到电脑上再试一次第一条命令。

## 2. 放行端口

浏览器里：实例 → 安全组（轻量应用服务器叫“防火墙”）→ 入方向添加规则，放行 TCP 80 和 443，来源 `0.0.0.0/0`。22 端口应该已经放行。

## 3. 域名解析

浏览器里：阿里云控制台 → 云解析 DNS → 选 `example.com` → 添加记录：类型 A，主机记录 `achat`，记录值 `IP`。

检查：`dig +short achat.example.com` 或 `nslookup achat.example.com` 返回 `IP`（生效可能要几分钟）。

## 4. Resend

浏览器里打开 <https://resend.com>，请主人注册或登录，然后：

1. Domains → Add Domain，填 `example.com`，地区选离中国近的（例如 Tokyo）。
2. 页面会列出几条 DNS 记录（MX、TXT，名字一般是 `send` 和 `resend._domainkey`）。到阿里云云解析 DNS 里逐条添加：主机记录填 Resend 给的名字，类型和值照抄。
3. 回到 Resend 点 Verify，等状态变成 Verified（几分钟到几十分钟）。
4. API Keys → Create API Key，权限选 Sending access。Key 只显示一次，直接用在下一步，不要贴进对话。

## 5. 部署

在电脑上的 Achat 目录里：

```sh
git pull
npm install
RESEND_API_KEY='re_...' ACHAT_MAIL_FROM='Achat <login@example.com>' bash deploy/upload.sh root@IP achat.example.com
```

`upload.sh` 会：
- 在电脑上构建 Achat，下载 Linux 版的 Node.js 和 Caddy；
- 把它们和代码一起传到服务器的 `/opt/achat`；
- 在服务器上运行 `deploy/install.sh`，npm 包从国内镜像下载；
- 装好 systemd 服务和 Caddy（80/443 已被别的程序占着时不装，见下一节）；
- 把 Resend 设置写进 `/etc/achat/achat.env`。

最后一段输出“Achat 在服务器上正常运行”就成功了。以后更新代码，重复这一步即可；已有的设置和数据不会被覆盖。

### 服务器上已经有网站占着 80/443

部署前先看一眼：`ssh root@IP 'ss -ltnp | grep -E ":(80|443|8080) "'`。80/443 被别的程序（例如 Docker 里的 Caddy、宝塔的 nginx）占着时，`install.sh` 不装 Caddy，免得把那边的网站弄挂，只装 Achat 服务。这时要让那个程序把 `achat.example.com` 转给 Achat：

1. 那个程序在 Docker 里时，容器访问不到宿主机的 127.0.0.1。查出它所在网络的网关，例如 `docker network inspect 网络名 --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'` 得到 `172.20.0.1`；把 `/etc/achat/achat.env` 里的 `HOST=127.0.0.1` 改成它，再 `systemctl restart achat`。以后重新部署不会改回去。
2. 在那个程序的配置里加一个站点。Caddy 的写法如下（`flush_interval -1` 让消息实时送达；nginx 对应的是 `proxy_buffering off;`）：
   ```
   achat.example.com {
   	encode gzip
   	reverse_proxy 172.20.0.1:8080 {
   		flush_interval -1
   	}
   }
   ```
   改之前先备份。Docker 挂进容器的是单个 Caddyfile 时，要原地写入（`cat 新文件 > Caddyfile`），不能用 `sed -i` 或编辑器另存：那样会换掉文件，容器里看到的还是旧的。改完先 `docker exec 容器名 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`，再把 `validate` 换成 `reload` 生效，不用重启容器。
3. 那个网站的配置文件在它自己的代码仓库里、部署时会被换掉的话，上一步加的站点迟早被冲掉（Caddy 下次重启才暴露）。这时别把站点写进那个文件：
   - 在它的 Caddyfile 末尾加一行 `import /etc/caddy/sites/*.caddy`；Caddy 在 Docker 里时，再给它加一个只读挂载 `/etc/caddy/sites:/etc/caddy/sites:ro`。这两处提交到那个项目的仓库，以后它照常部署。
   - 把上面的站点块存成服务器上的 `/etc/caddy/sites/achat.caddy`。这个目录不在那个项目里，它部署时碰不到。
   - 先用临时容器校验：`docker run --rm -v 新Caddyfile:/etc/caddy/Caddyfile:ro -v /etc/caddy/sites:/etc/caddy/sites:ro 同一个镜像 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`。
   - 新加了挂载，要重建一次 Caddy 容器：`docker compose ... up -d --no-deps caddy`。80/443 会断一两秒；证书在它的数据目录里，不会重新申请。以后改 `achat.caddy` 只要 `caddy reload`。

## 6. 检查

```sh
curl -fsS https://achat.example.com/api/health
```

返回 `{"pid":…,"mode":"cloud"}` 就好了。第一次申请证书可能要一两分钟。不通时：

- `ssh root@IP journalctl -u caddy -n 50 --no-pager`：证书申请失败多半是 80/443 没放行，或者域名解析还没生效。
- `ssh root@IP journalctl -u achat -n 50 --no-pager`：服务本身的错误。
- 浏览器打开 `https://achat.example.com` 显示阿里云的备案提示页：这个子域名没有接入备案，到阿里云 ICP 备案控制台确认。

## 7. 主人登录并把电脑加入账号

1. 浏览器打开 `https://achat.example.com`，用邮箱登录。收不到验证码时看 `ssh root@IP journalctl -u achat -n 50 --no-pager`：Resend 的报错会在这里。
2. 在电脑上：`node dist/cli.js link https://achat.example.com`，打开它给的链接，核对配对码后点“添加”。
3. 想和同事连上：在 Claude Code 或 Codex 里说“我要和某某连上”，把生成的邀请链接发给对方。
