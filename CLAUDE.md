# cc-im-bridge 项目说明

企业微信 ↔ 本机 Claude Code 会话的双向桥。用法见 README.md，新人从零安装见 docs/上手.md（改了安装步骤、脚本参数或报错文字要同步这份文档），版本见 CHANGELOG.md。

## 结构

- `relay/core.mjs`：路由与审批的纯逻辑（无 I/O，注入 `now`），绝大多数行为在这里测。
- `relay/relay.mjs`：中转进程，Unix socket（给 mod 和钩子）+ 127.0.0.1 网页窗口 + 企微适配器的装配。
- `relay/wecom.mjs`：企微智能机器人长连接适配器；`relay/ws-client.mjs`：自写 WebSocket 客户端。
- `relay/titles.mjs`：从 `~/.claude/projects/*/<会话 id>.jsonl` 读最新的 `custom-title` 作为企微里的会话名（Desktop 侧边栏标题；每轮都会重写一次）。只读这一行，按修改时间缓存。
- `relay/describe.mjs`：审批卡片上给人看的工具名与参数（只用于显示；匹配审批仍用 summary）。
- `relay/lucid-blocks.mjs`：发往企微前，把回复里 Lucid 插件的组件代码块（callout / details / steps / compare / chart / diagram）转成纯文字，在 `wecom.mjs` 的 `formatOutgoing` 里调用。代码块格式以 claude-plugins 仓库 `plugins/lucid/skills/blocks/SKILL.md` 为准，那边改了格式这里要跟着改；认不出或 JSON 写错的块原样保留。
- `relay/media.mjs`：附件。收：解析 image/file/mixed 里的 url+aeskey，解密（AES-256-CBC，IV=密钥前 16 字节，**PKCS#7 按 32 字节对齐，要关掉 Node 的自动去填充**）。发：按扩展名和大小决定图片/文件。上传在 `wecom.mjs` 的 `uploadMedia`（init → chunk(512KB) → finish 拿 media_id）。
- `relay/summary.mjs`：审批摘要。**mod 的 `hooks/register.ts` 里有一份相同实现**，两边必须一致（mod 按摘要作废「已在电脑上处理」的审批），改一边要同步另一边。
- `hooks/permission-request.mjs`：settings 的 PermissionRequest 钩子。
- `mod/cc-im-bridge/`：会话插件（engine 的 hooks 模块）。用户级安装时直接读这个目录。

## 运行环境

- 中转由 launchd 托管（`com.cc-im-bridge.relay`），日志 `~/.cc-im-bridge/relay.log`。改了中转代码后执行 `scripts/launchd.sh install` 重启；不要再在会话里另起一个中转，同一机器人两个连接会互踢（服务端发 `disconnected_event`，本中转收到后不再重连）。
- 数据目录 `~/.cc-im-bridge/`：`wecom.json` 含 secret，只取键名查看，不要打印值。
- 改了 mod 后：**先把 `plugin.json` 的 version 升一级，再 `claude plugin update cc-im-bridge@cc-im-bridge-local`，然后重启 Claude Desktop（⌘Q 再打开）**。安装时 Claude Code 在 `~/.claude/plugins/cache/cc-im-bridge-local/cc-im-bridge/<版本>/` 存了一份副本：Desktop 重启后各会话加载的是这份副本，不再读仓库目录（2026-11-18 实测：重启后 8 个会话全回到 0.2.1；`plugin update` 之后，已在运行的会话执行 `/reload-plugins` 仍是旧版，只有更新后才启动的会话进程用上了新版。`plugin update` 的输出也写着「Restart to apply changes」）。不升版本号，`plugin update` 不会更新副本。核对办法：`curl --unix-socket ~/.cc-im-bridge/relay.sock http://relay/mod/sessions` 看各会话上报的 version。

## 测试

- 起中转子进程的测试，要在 `after()` 里把子进程全部杀掉：断言失败时子进程还活着，测试运行器会一直等（2026-11-18 犯过）。`npm test` 带了 `--test-timeout`。
- `npm test` = node 测试 + `claude plugin test mod/cc-im-bridge`。提交前必须全过；写完新测试做一次变异（临时改坏被测条件，确认对应用例失败，再用反向 sed 还原）。
- mod 的约束：`$` 只能传给文件顶层声明的函数（`claude plugin validate` 会拒）；模块内状态放在顶层 `bridge` 对象里。

## 踩过的坑（实测结论）

- **安装或 `claude plugin update` 前，`mod/` 里不能有未提交的临时代码**：它会被原样复制进插件缓存，跑在各个会话里。2026-11-17 安装时工作区里正留着一段临时诊断代码（把每次权限判定写进 `~/.cc-im-bridge/diag-tool-check.json`），被装进了 0.2.1 的缓存，Desktop 重启后回落到 0.2.1 的会话一直在写这个文件。更新前先 `git status` 确认 `mod/` 干净。

- **改了 `$.tool.register` 的描述或参数，已有会话的模型看不到**：会话里模型看到的工具定义在会话内是固定的，升级插件、重启 Desktop 后钩子代码换成新版，但模型手里仍是旧定义，直到该会话压缩上下文（compact）或新开会话。2026-11-18 实测：「AI 项目经理」会话中转上报 0.7.3，18:02 看到的 `send` 仍只有 `text`，于是回答用户「企微只能发文字，发不了图」；00:34 自动压缩后才拿到带 `file` 的定义。核对办法：在会话记录里找最新一条含 `"name": "mcp__cc-im-bridge__send"` 的 `api-request-shape`，看参数里有没有新字段。因此，新能力要让已开的会话马上用上时，别只改已有工具的参数；靠提示传达的规则写进工具的返回或拒绝信息里，不要只写在描述里。
- **用 heredoc 或 python 脚本往文件里写大段中文后，要查有没有替换字符（U+FFFD）**：`grep -n $'\xef\xbf\xbd' <文件>`。2026-11-19 提交信息里的「仓库」、2026-11-20 常问问题默认清单里的「么」都在写入时变成了乱码，前者已进了一次提交（推送前 amend 改掉）。
- **认「人在电脑上打字」看 `origin.kind === 'composer'`**（引擎类型 `PromptOrigin`，2026-11-25 查 `claude-code.d.ts`）：其余取值有 `scheduled-trigger`（定时任务、/loop）、`task-notification`（后台任务完成）、`peer`/`peer-send-message`（别的会话来信）、`bridge`（Remote Control）、`sdk`、插件自己提交的等。斜杠命令在 `command.run` 里认（它也带 `origin`）；`prompt.submit` 只对会交给模型的命令带 `e.command`，`/im-status` 这类本地命令不经过它。`turn.start` 不带来源，回合来源取开始前最后一次 `prompt.submit` 的 origin。测试替身里插件调用 `$.command.run` 不带 `origin`，读时要容错。
- 企微长连接握手区分请求头大小写：只认 `Sec-WebSocket-Key`，小写返回 404。Node 自带 WebSocket（undici）改不了头名。
- 企微卡片点击事件：`event_key`、`task_id` 在 `body.event.template_card_event` 下，官方 SDK 1.0.7 类型写在 `body.event` 下。更新卡片要在 5 秒内用**该事件的 req_id** 发 `aibot_respond_update_msg`。
- 审批编号每次启动从 1 计，卡片 `task_id` 带启动随机前缀，点击时校验，旧卡片不生效。
- 审批不能挂在 mod 的 `tool.check`：auto 模式下普通命令也判为 `ask`，之后由分类器放行。要用 settings 的 `PermissionRequest`（只在真要弹框时触发；在 Desktop 里与本地弹框并行，先答者生效）。
- 本机有组织安全策略插件 `cc-plugin-sec-default`，排在用户 mod 之前，会把 `classic.*` 事件直接放过，mod 收不到（如读 `permission_mode`）。
- mod 在上一回合未结束时就可能取到 IM 消息：识别 IM 回合要在 `turn.start` 按提示词标记记回合 id，不能在取信时计数。
- 本机 shell 有 http/https 代理环境变量，curl 走代理（看到 127.0.0.1）；Node 的连接不走代理，排查网络问题时注意两者不同。
