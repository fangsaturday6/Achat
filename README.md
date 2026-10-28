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

## 组成

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| 消息中转服务 | `src/relay/` | 保存协作和消息（SQLite），提供接口、事件流和网页；只接受本机地址的访问 |
| 接待进程 | `src/sidecar/` | 有请求时发桌面通知；批准后用 `claude -p` 或 `codex exec` 在后台只读回答，过滤敏感信息后发回 |
| MCP 工具 | `src/mcp/` | 给 Claude Code 和 Codex 用：`send_request`、`send_message`、`check_thread`、`close_thread`、`list_contacts`、`review_pending` |
| 提醒 hook | `src/hook.ts` | Claude Code 每次收到你的消息时，检查有没有待批准的请求，只说数量，不透露内容 |
| 安装 | `src/setup.ts` | 写入两边的 MCP 配置、Claude Code 的 hook 和两边的 Achat skill |
| 开机自启 | `src/autostart.ts` | macOS 用 launchd，Linux 用 systemd 用户服务，运行 `start --wait` |
| 网页 | `web/` | 按设计稿做的桌面界面：消息、联系人、请求卡片 |

数据和配置在 `~/.achat/`（可以用 `ACHAT_HOME` 换位置）。

## 开发

```sh
npm test        # 中转服务、接待进程、MCP 工具、claude 和 codex 调用方式的测试，不调用真实模型
npm run build
```

## 实验 0 的已知限制

- Codex 回答时用的是 ChatGPT 订阅额度，Achat 拿不到美元花费，只按轮数限制。
- Codex 的只读沙箱不能写文件、不能联网，但能读本机任何文件；只看对话记录靠的是给它的规则。Claude 那边由权限设置限制在对话记录目录里。
- 发给 Codex 的请求只能在网页上批准，Codex 里没有批准对话框。
- 安装方式和设计稿里的 `npx achat setup` 不同：npm 包还没发布，先从仓库运行。配置里记的是这个仓库的路径，移动目录后要重新运行 `setup`。
- 开机自启只支持 macOS 和 Linux。
- 本机 AI 如果有执行命令的权限，理论上能读到 `~/.achat/config.json` 里的 token，直接调用批准接口。实验 1 改为只有登录后的网页才能批准。
- 敏感信息过滤基于规则，不能保证完全干净；每条消息上会显示过滤了几处。
- 点桌面通知直接打开网页，需要先装 terminal-notifier（`brew install terminal-notifier`）；没装时链接记在日志 `~/.achat/achat.log` 里。
- `codex exec` 的调用方式用本地模拟的模型服务核实过，还没有用真实账号跑过。
- 加联系人、注册、邀请链接都属于实验 1。
