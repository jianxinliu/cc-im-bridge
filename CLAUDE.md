# cc-im-bridge 项目说明

企业微信 ↔ 本机 Claude Code 会话的双向桥。用法与安装见 README.md，版本见 CHANGELOG.md。

## 结构

- `relay/core.mjs`：路由与审批的纯逻辑（无 I/O，注入 `now`），绝大多数行为在这里测。
- `relay/relay.mjs`：中转进程，Unix socket（给 mod 和钩子）+ 127.0.0.1 网页窗口 + 企微适配器的装配。
- `relay/wecom.mjs`：企微智能机器人长连接适配器；`relay/ws-client.mjs`：自写 WebSocket 客户端。
- `relay/titles.mjs`：从 `~/.claude/projects/*/<会话 id>.jsonl` 读最新的 `custom-title` 作为企微里的会话名（Desktop 侧边栏标题；每轮都会重写一次）。只读这一行，按修改时间缓存。
- `relay/describe.mjs`：审批卡片上给人看的工具名与参数（只用于显示；匹配审批仍用 summary）。
- `relay/summary.mjs`：审批摘要。**mod 的 `hooks/register.ts` 里有一份相同实现**，两边必须一致（mod 按摘要作废「已在电脑上处理」的审批），改一边要同步另一边。
- `hooks/permission-request.mjs`：settings 的 PermissionRequest 钩子。
- `mod/cc-im-bridge/`：会话插件（engine 的 hooks 模块）。用户级安装时直接读这个目录。

## 运行环境

- 中转由 launchd 托管（`com.cc-im-bridge.relay`），日志 `~/.cc-im-bridge/relay.log`。改了中转代码后执行 `scripts/launchd.sh install` 重启；不要再在会话里另起一个中转，同一机器人两个连接会互踢（服务端发 `disconnected_event`，本中转收到后不再重连）。
- 数据目录 `~/.cc-im-bridge/`：`wecom.json` 含 secret，只取键名查看，不要打印值。
- 改了 mod 后在会话里 `/reload-plugins`。

## 测试

- 起中转子进程的测试，要在 `after()` 里把子进程全部杀掉：断言失败时子进程还活着，测试运行器会一直等（2026-11-18 犯过）。`npm test` 带了 `--test-timeout`。
- `npm test` = node 测试 + `claude plugin test mod/cc-im-bridge`。提交前必须全过；写完新测试做一次变异（临时改坏被测条件，确认对应用例失败，再用反向 sed 还原）。
- mod 的约束：`$` 只能传给文件顶层声明的函数（`claude plugin validate` 会拒）；模块内状态放在顶层 `bridge` 对象里。

## 踩过的坑（实测结论）

- 企微长连接握手区分请求头大小写：只认 `Sec-WebSocket-Key`，小写返回 404。Node 自带 WebSocket（undici）改不了头名。
- 企微卡片点击事件：`event_key`、`task_id` 在 `body.event.template_card_event` 下，官方 SDK 1.0.7 类型写在 `body.event` 下。更新卡片要在 5 秒内用**该事件的 req_id** 发 `aibot_respond_update_msg`。
- 审批编号每次启动从 1 计，卡片 `task_id` 带启动随机前缀，点击时校验，旧卡片不生效。
- 审批不能挂在 mod 的 `tool.check`：auto 模式下普通命令也判为 `ask`，之后由分类器放行。要用 settings 的 `PermissionRequest`（只在真要弹框时触发；在 Desktop 里与本地弹框并行，先答者生效）。
- 本机有组织安全策略插件 `cc-plugin-sec-default`，排在用户 mod 之前，会把 `classic.*` 事件直接放过，mod 收不到（如读 `permission_mode`）。
- mod 在上一回合未结束时就可能取到 IM 消息：识别 IM 回合要在 `turn.start` 按提示词标记记回合 id，不能在取信时计数。
- 本机 shell 有 http/https 代理环境变量，curl 走代理（看到 127.0.0.1）；Node 的连接不走代理，排查网络问题时注意两者不同。
