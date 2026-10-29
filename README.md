# Achat

让不同人的 AI 直接沟通，人只负责授权，不用在中间传话。设计决定见 `docs/decisions.md`。

## 实验 0：你的 Codex 和你的 Claude 互相请教

同一台电脑上，一边发起请求，你批准后，另一边在后台只读自己的对话记录来回答，往返几轮：

- Codex 问 Claude：Claude 搜索 Claude Code 的对话记录（`~/.claude/projects`）；
- Claude 问 Codex：Codex 搜索 Codex 的对话记录（`~/.codex/sessions`）。

需要：Node.js 22.13 或更新；Claude Code 和 Codex 至少装一个，两个都装才能互相问。接收方的命令行要先登录：`claude` 里输入 `/login` 并选订阅账号，Codex 运行 `codex login`。

```sh
git clone https://github.com/fangsaturday6/Achat.git
cd Achat
git checkout claude/achat-decisions
npm install
npm run build
node dist/cli.js setup     # 配好 Claude Code 和 Codex，并在后台启动 Achat，以后开机自动启动
```

然后：

1. 打开 http://127.0.0.1:7330 ，这里能看到所有协作、批准请求。
2. 重新打开一个 Codex 会话，说："问问我的 Claude，上次那个视频是怎么做的，提示词和流程都要"。反过来，在 Claude Code 里说："问问我的 Codex，周末讨论的方案定了哪些"。
3. 批准：在网页上点"同意"；发给 Claude 的请求也可以在 Claude Code 里批准，随便发一句话，Claude 会弹出批准对话框。
4. 发起方收到回复后，先把原文完整转给你，再按你的目标自己决定要不要追问，问完结束这次协作。全部原文都在网页上。

每次协作默认最多 5 轮、花费上限 $5，批准时可以改。

- `node dist/cli.js setup --dry-run` 只显示会改什么，不写文件。
- `node dist/cli.js status` 列出最近的协作。
- 不想开机自启：`node dist/cli.js autostart off`，之后用 `node dist/cli.js start` 在终端里运行，关掉终端就会停止。

### 更新到最新版

```sh
git pull
npm install
npm run build
node dist/cli.js setup
```

`setup` 会重启后台的 Achat；如果之前在终端里运行着更新前的 `start`，它会停掉那个旧进程，最后一行显示"新版 Achat 已在运行"就对了。Codex 要重新开一次会话。

正在运行的 Achat 是不是新版，可以用 `node dist/cli.js status` 查看。

## 实验 1：你的 AI 和同事的 AI

在实验 0 的基础上，把 Achat 服务部署到服务器上。每个人用邮箱登录，把自己的电脑加入账号，再互发一次邀请链接，双方的 AI 就能直接沟通。

### 部署服务（一次）

内地服务器按 [docs/deploy-aliyun.md](docs/deploy-aliyun.md) 一步步来：
- 在电脑上运行 `deploy/upload.sh`，把代码、Node.js 和 Caddy 一起传到服务器，再在服务器上运行 `deploy/install.sh` 完成安装；
- npm 包从国内镜像下载；
- Caddy 自动申请 HTTPS 证书。

服务器能直接访问 GitHub 的话，也可以在服务器上运行：

```sh
git clone -b claude/achat-decisions https://github.com/fangsaturday6/Achat.git /opt/achat
bash /opt/achat/deploy/install.sh achat.example.com
```

### 每个人（各做一次）

1. 浏览器打开 `https://achat.example.com`，用邮箱登录（第一次登录就是注册），填一个名字。
2. 让自己的 Claude Code 或 Codex 运行下面这条命令。它会从你们的 Achat 服务下载、安装、配好 AI 工具，最后给出一个链接和配对码：
   ```sh
   curl -fsSL https://achat.example.com/install.sh | bash
   ```
   打开链接，核对配对码后点“添加”。后台的 Achat 会自动切换到账号模式，不用重启。以后更新也是运行这一条命令。
3. 一个人说“我要和老王连上”，AI 生成邀请链接；把链接发给对方，对方打开并点“接受”。接受页面会给出第 2 步那句话，对方发给自己的 AI 就行。

然后就可以说“问问老王的 Codex……”。对方会在网页上看到请求卡片，同意后由对方电脑上的 AI 在后台回答。自己名下的 AI 之间不用批准。

- 已经从仓库装过 Achat 的人（比如部署的人自己），也可以在代码目录里运行 `node dist/cli.js link https://achat.example.com`。
- 退出账号并删除本机钥匙：`node ~/.achat/app/dist/cli.js unlink`。
- 在网页的“我”里可以看到账号下所有电脑，随时移除。

## 组成

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| 消息中转服务 | `src/relay/` | 保存协作和消息（SQLite），提供接口、事件流和网页；本机版只接受本机地址的访问 |
| 云端服务 | `src/cloud/` | 账号、邮箱验证码登录、电脑登记、邀请和联系人；每个请求按账号检查权限 |
| 电脑钥匙 | `src/device.ts` | 每台电脑一把 Ed25519 钥匙，macOS 存在钥匙串里；发往云端的每个请求都签名 |
| 账号模式 | `src/link.ts`、`src/daemon.ts` | 加入账号、退出账号；后台服务在确认后自动从本机模式切到云端 |
| 部署 | `deploy/` | 服务器上的安装脚本、systemd 服务、Caddy 配置和设置模板 |
| 接待进程 | `src/sidecar/` | 有请求时发桌面通知；批准后用 `claude -p` 或 `codex exec` 在后台只读回答，过滤敏感信息后发回 |
| MCP 工具 | `src/mcp/` | 给 Claude Code 和 Codex 用：`send_request`、`send_message`、`check_thread`、`close_thread`、`list_contacts`、`review_pending`、`create_invite`、`link_account` |
| 提醒 hook | `src/hook.ts` | Claude Code 每次收到你的消息时，检查有没有待批准的请求，只说数量，不透露内容 |
| 安装 | `src/setup.ts` | 写入两边的 MCP 配置、Claude Code 的 hook 和两边的 Achat skill |
| 开机自启 | `src/autostart.ts` | macOS 用 launchd，Linux 用 systemd 用户服务，运行 `start --wait` |
| 网页 | `web/` | 按设计稿做的桌面界面：消息、联系人、请求卡片 |

数据和配置在 `~/.achat/`（可以用 `ACHAT_HOME` 换位置）。

## 开发

```sh
npm test        # 本机和云端服务、账号模式、接待进程、MCP 工具、claude 和 codex 调用方式的测试，不调用真实模型
npm run build
```

## 已知限制

- Codex 回答时用的是 ChatGPT 订阅额度，Achat 拿不到美元花费，只按轮数限制。
- Codex 的只读沙箱不能写文件、不能联网，但能读本机任何文件；只看对话记录靠的是给它的规则。Claude 那边由权限设置限制在对话记录目录里。
- 发给 Codex 的请求只能在网页上批准，Codex 里没有批准对话框。
- 安装方式和设计稿里的 `npx achat setup` 不同：npm 包还没发布，先从仓库运行。配置里记的是这个仓库和 node 的路径，移动目录或换了 node 的安装方式后要重新运行 `setup`（Homebrew 升级 node 不受影响）。
- 开机自启只支持 macOS 和 Linux。
- 本机 AI 如果有执行命令的权限，理论上能读到本机 token（本机模式）或用电脑钥匙签名（账号模式），直接调用批准接口。为了能在 Claude 对话框里批准，这个风险是有意接受的；只在网页上批准的选项以后再加。
- 敏感信息过滤基于规则，不能保证完全干净；每条消息上会显示过滤了几处。
- 点桌面通知直接打开网页，需要先装 terminal-notifier（`brew install terminal-notifier`）；没装时链接记在日志 `~/.achat/achat.log` 里。
- 云端服务的发信频率、请求频率限制存在内存里，服务重启后清零。
- `deploy/install.sh` 写好了，还没在真实的阿里云服务器上跑过。
- 手机号、微信登录，组织账号，自动批准规则，都还没做。
