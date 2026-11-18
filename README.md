# cc-im-bridge

在手机上的企业微信里，和电脑上任意一个 Claude Code 会话（包括 Claude Desktop 的 Code 标签页）互发消息，并在手机上审批它要执行的操作。

## 组成

| 部分 | 位置 | 作用 |
|---|---|---|
| 中转 | `relay/` | 常驻本机的 Node 进程。一边连企微智能机器人（长连接，不需要公网地址），一边通过 Unix socket `~/.cc-im-bridge/relay.sock` 服务各会话；按会话名分发消息、管理审批 |
| 会话插件（mod） | `mod/cc-im-bridge/` | 装在 Claude Code 里，每个会话一份。定时向中转取信，用 `$.prompt.submit` 把企微消息投进会话（会话空闲时也能唤醒）；回合结束时把回复发回企微 |
| 审批钩子 | `hooks/permission-request.mjs` | 登记在 `~/.claude/settings.json` 的 `PermissionRequest` 钩子。Claude Code 真要弹框问人时，若该会话开着转发，就把审批发到企微并等答复 |
| 网页窗口 | `http://127.0.0.1:8788/?token=…` | 本机调试用的聊天窗口，地址在 `~/.cc-im-bridge/web-url` |

零第三方依赖：WebSocket 客户端是自写的（`relay/ws-client.mjs`），原因见「已知问题」。

## 安装

前提：Node 22+，Claude Code 2.1.3xx+，一个企业微信智能机器人（API 配置选「使用长连接」）。

1. 写企微配置（Secret 输入不回显，文件权限 600）：

   ```bash
   scripts/setup-wecom.sh
   ```

2. 让中转开机自启：

   ```bash
   CC_IM_NODE=/opt/homebrew/bin/node scripts/launchd.sh install
   ```

3. 安装会话插件（所有会话生效）：

   ```bash
   claude plugin marketplace add ~/workspace/ai/cc-im-bridge
   ```

   ```bash
   claude plugin install cc-im-bridge@cc-im-bridge-local --scope user
   ```

4. 登记审批钩子：在 `~/.claude/settings.json` 的 `hooks` 里加

   ```json
   "PermissionRequest": [
     { "matcher": "*", "hooks": [{ "type": "command", "timeout": 660,
       "command": "/opt/homebrew/bin/node /Users/<你>/workspace/ai/cc-im-bridge/hooks/permission-request.mjs" }] }
   ]
   ```

5. 在企微里给机器人发一条消息。不在白名单时机器人会回你的 userid，把它加进 `~/.cc-im-bridge/wecom.json` 的 `allowUsers`，再重启中转（`scripts/launchd.sh install` 会重启）。

插件直接读仓库目录：改了 mod 代码后，在会话里执行 `/reload-plugins` 生效。改了中转代码后重新执行 `scripts/launchd.sh install`。

## 在企微里怎么用

| 想做的事 | 怎么说 |
|---|---|
| 看有哪些会话 | 发「会话」，回一张卡片，点编号之后就发给它。会话名与 Desktop 侧边栏上的标题一致 |
| 切换会话 | 「切到 判例」「换到 2」（编号见会话卡片；标题或插件名都可只写开头） |
| 发给某个会话 | 「完整标题：内容」或「编号：内容」，或先切过去再直接说 |
| 批准 / 拒绝 | 点审批卡片上的按钮；只有一条待批时也可以回「好」「可以」或「不行，原因」 |
| 下一步建议 | 选完会话后自动发一张「接下来可以」卡片（按会话上下文生成 3–4 条），点编号或回编号就发给它；随时发「建议」再生成。每次生成会调用一次模型，费用记在该会话 |
| 发图片、文件给会话 | 直接发（可附一句话）。存到 `~/.cc-im-bridge/inbox/日期/`，会话收到「[图片] 路径」「[文件] 路径」后自己读取。上限 25MB；视频暂不支持 |
| 回答 Claude 的提问 | 点卡片上的编号；或回编号、选项原文、「答：其他内容」 |
| 中断当前会话 | 「停」 |
| 遥控某个会话 | 「离开」：回一张卡片，点要遥控的会话（只有一个在线会话时直接遥控它）；「离开 2」直接指定。同一时间只遥控一个会话，换一个时原来的自动退出；会话列表上标「遥控中」 |
| 回到电脑 | 「回来了」：所有会话退出遥控 |
| 查看待批 | `/pending` |

原来的命令写法（`/list`、`/use 2`、`@2 内容`、`/y 3`、`/n 3 原因`）仍然可用。

## 在 Claude Code 会话里的命令

装了插件的每个会话都有这几个斜杠命令，在 Desktop 或终端的输入框里输入（从企微发过来的 `/im-…` 不会被执行）：

| 命令 | 作用 | 默认 |
|---|---|---|
| `/im-status` | 查看本会话在企微里的名字、会话 id、中转连接状态、回传和审批转发是否打开 | — |
| `/im-away on` / `/im-away off` | 离开模式（遥控模式）：本会话每一轮的回复、审批、提问、计划确认都发到企微；企微里说「离开」（当前会话）、「回来了」（所有会话）效果相同 | off |
| `/im-push im` / `all` / `off` | 哪些回复发回企微：`im` 只发企微发起的那一轮；`all` 本地对话的回复也发；`off` 都不发 | im |
| `/im-name 名字` | 设置本会话的别名（可含空格，1–32 字，不能含冒号）。企微里优先显示 Desktop 侧边栏标题，读不到标题时显示别名；别名也能用来「切到」「名字：内容」 | 目录名（worktree 为「仓库名-worktree 名第一段」） |

另外插件给模型注册了一个工具 `send`：会话可以主动给你的企微发通知（任务完成、出错、需要你决定时），也可以带 `file`（本机绝对路径）把截图、报告发到你手机：PNG/JPG 不超过 10MB 按图片发，其他不超过 20MB 按文件发。

## 什么时候会给你发企微消息

遵循「安静即正常」，只在以下情况发：

1. 你从企微发起的那一轮，会话的最终回复；
2. 会话主动调用 `send` 工具给你发的通知；
3. 需要你批准的操作、Claude 的提问和计划确认（只在该轮由企微发起、或开了离开模式时）；离开模式下每一轮的回复也会发；
4. 你在企微里发的命令的回执（如「之后的消息发给 web」）。

在 Desktop 里直接对话产生的回复默认不发（`/im-push all` 可改）。

## 审批转发的规则

- 只在 Claude Code **真的要弹框问你**时触发（auto 模式下由分类器放行的不会打扰你）。
- 企微和电脑上的弹框同时出现，**谁先答复以谁为准**；在电脑上点了，企微里那条会标成「已在电脑上处理」。
- 10 分钟没人答复、会话中断、中转没在跑或出错时，都交回本地弹框，不会卡住。
- Claude 向你提问（AskUserQuestion）时，每个问题一张卡片：单选点编号，多选回编号（如「1 3」），也可回「答：其他内容」。批准计划时卡片显示计划开头，点批准即可。
- 中转重启后，之前发出的卡片作废，点了会提示「已过期」。

## 安全

- 中转会读 `~/.claude/projects/*/<会话 id>.jsonl` 里最新的 `custom-title` 一行，作为会话在企微里的名字；不读对话内容。

- 只接受 `wecom.json` 里 `allowUsers` 白名单用户的消息和按钮点击：能发消息进会话，就能让 Claude 在本机执行命令。
- `wecom.json`、`relay.sock` 只有本人可读写（600），数据目录 700。
- 网页窗口只听 127.0.0.1，校验 Host 头和随机 token。

## 撤销

```bash
scripts/launchd.sh uninstall
```

```bash
claude plugin uninstall cc-im-bridge@cc-im-bridge-local
```

再从 `~/.claude/settings.json` 删掉 `hooks.PermissionRequest`（安装时的备份在 `~/.claude/settings.json.bak-ccim-*`）。

## 开发

```bash
npm test
```

跑中转、钩子脚本的 node 测试和 mod 的 `claude plugin test`。改 mod 后还要过 `claude plugin validate mod/cc-im-bridge`。

## 已知问题

- 企微长连接服务端按大小写匹配握手头，只认 `Sec-WebSocket-Key`；Node 自带 WebSocket 一律发小写，握手 404，所以自写了客户端。
- 卡片点击事件里，`event_key`、`task_id` 在 `event.template_card_event` 下，与官方 SDK 类型（在 `event` 下）不同；两处都读。
- 企微会在机器人消息下方加「内容由 AI 生成」，无法去掉。
- 在组织安全策略插件（`cc-plugin-sec-default`）存在时，mod 挂的经典钩子事件（`classic.*`）会被跳过；审批因此放在 settings 钩子里做。
