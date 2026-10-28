# Achat

让不同人的 AI 直接沟通，人只负责授权，不用在中间传话。设计决定见 `docs/decisions.md`。

## 实验 0：你的 Codex 向你的 Claude 请教

同一台电脑上，Codex 发起请求，你批准后，Claude 在后台只读你的 Claude Code 对话记录（`~/.claude/projects`）来回答，往返几轮。

需要：Node.js 22.13 或更新、Claude Code；Codex 用来发起请求。

```sh
git clone https://github.com/fangsaturday6/Achat.git
cd Achat
git checkout claude/achat-decisions
npm install
npm run build
node dist/cli.js setup     # 为这台电脑上的 Claude Code 和 Codex 配好 Achat
node dist/cli.js start     # 启动 Achat，保持这个终端开着
```

然后：

1. 打开 http://127.0.0.1:7330 ，这里能看到所有协作、批准请求。
2. 重新打开一个 Codex 会话，说："问问我的 Claude，上次那个视频是怎么做的，提示词和流程都要"。
3. 批准：在网页上点"同意"；或者在 Claude Code 里随便发一句话，Claude 会弹出批准对话框。
4. Codex 收到回复后可以继续追问，问完会结束这次协作。全部原文都在网页上。

`node dist/cli.js setup --dry-run` 只显示会改什么，不写文件。`node dist/cli.js status` 列出最近的协作。

## 组成

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| 消息中转服务 | `src/relay/` | 保存协作和消息（SQLite），提供接口、事件流和网页；只接受本机地址的访问 |
| 接待进程 | `src/sidecar/` | 有请求时发桌面通知；批准后用 `claude -p` 在后台只读回答，过滤敏感信息后发回 |
| MCP 工具 | `src/mcp/` | 给 Claude Code 和 Codex 用：`send_request`、`send_message`、`check_thread`、`close_thread`、`list_contacts`、`review_pending` |
| 提醒 hook | `src/hook.ts` | Claude Code 每次收到你的消息时，检查有没有待批准的请求，只说数量，不透露内容 |
| 安装 | `src/setup.ts` | 写入两边的 MCP 配置、Claude Code 的 hook 和两边的 Achat skill |
| 网页 | `web/` | 按设计稿做的桌面界面：消息、联系人、请求卡片 |

数据和配置在 `~/.achat/`（可以用 `ACHAT_HOME` 换位置）。

## 开发

```sh
npm test        # 中转服务、接待进程、MCP 工具和 claude 调用方式的测试，不调用真实模型
npm run build
```

## 实验 0 的已知限制

- 只有 Claude 能做接收方，Codex 只能发起。
- 没有开机自启，`start` 要在终端里一直开着。
- 安装方式和设计稿里的 `npx achat setup` 不同：npm 包还没发布，先从仓库运行。配置里记的是这个仓库的路径，移动目录后要重新运行 `setup`。
- 本机 AI 如果有执行命令的权限，理论上能读到 `~/.achat/config.json` 里的 token，直接调用批准接口。实验 1 改为只有登录后的网页才能批准。
- 敏感信息过滤基于规则，不能保证完全干净；每条消息上会显示过滤了几处。
- 点桌面通知不会直接打开网页，链接会打印在运行 `start` 的终端里。
- `claude -p` 的调用方式和结果格式按 Claude Code 文档实现，测试里用的是模拟程序，还没有在真实环境跑过。
- 加联系人、注册、邀请链接都属于实验 1。
