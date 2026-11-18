import type { EngineInterface, Register } from 'claude-code'

const PLUGIN = 'cc-im-bridge'
const VERSION = '0.5.0'
const POLL_MS = 2000
const MAX_REPLY_CHARS = 4000
const NAME_PATTERN = /^[\w.\-一-龥]{1,32}$/
// 提交进会话的 IM 消息都带这个开头；回合开始时据此认出由 IM 发起的回合。
const IM_MARKER = '[来自 IM 的消息'
const IM_MESSAGE_ID = /^\[来自 IM 的消息 (m\d+)/
// 与仓库 relay/summary.mjs 一致：审批摘要，用来作废「已在电脑上处理」的那条审批。
const MAX_SUMMARY_CHARS = 1000
const SUMMARY_FIELDS = ['command', 'file_path', 'url', 'path', 'pattern']

type PushMode = 'im' | 'all' | 'off'
type RelayAnswer = {
  status: number
  ok: boolean
  error?: string
  messages?: { id: string; text: string }[]
  controls?: Control[]
}
type Control = { type: 'abort' } | { type: 'away'; on: boolean }

// 模块每个会话加载一份，这里的状态就是本会话的状态；重载后由 session.start 重新填。
const bridge = {
  socketPath: '',
  sessionId: '',
  cwd: '',
  name: '',
  pushMode: 'im' as PushMode,
  isRegistered: false,
  isPolling: false,
  problem: undefined as string | undefined,
  // 由 IM 消息开启、还没结束的回合：回合 id -> 那条 IM 消息的 id（回复按它接到那条消息的流式回复上）。
  // 按回合 id 认，而不是在取信时计数：取信时上一回合可能还没结束。
  imTurns: new Map<string, string>(),
  // 主循环当前回合对应的 IM 消息 id；不是 IM 发起的回合为空，此时不报进度。
  currentMsgId: '',
  // 主循环当前回合是不是 IM 发起的：是的话人可能不在电脑前，审批要转到 IM。
  isImTurn: false,
  // 离开模式：人不在电脑前。本会话所有回合的回复、审批、提问都发到 IM。
  isAway: false,
  // 主循环正在跑的回合 id，IM 里说「停」时中断它。
  runningTurnId: '',
}

// 审批真正发生在 settings 的 PermissionRequest 钩子里；mod 只告诉中转现在该不该转。
const shouldForward = () => bridge.isAway || bridge.isImTurn

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function call($: EngineInterface, path: string, body: unknown): Promise<RelayAnswer> {
  const res = await $.http.fetch(`http://relay${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    socketPath: bridge.socketPath,
  })
  try {
    return { status: res.status, ...JSON.parse(res.text) }
  } catch {
    return { status: res.status, ok: false, error: `中转返回的不是 JSON：${res.text.slice(0, 200)}` }
  }
}

async function ensureRegistered($: EngineInterface) {
  const { sessionId, cwd } = bridge
  let r = await call($, '/mod/register', { sessionId, name: bridge.name, cwd, version: VERSION })
  if (r.status === 409) {
    // 同名会话在线时，带上会话 id 前缀区分。
    bridge.name = `${bridge.name}-${sessionId.slice(0, 4)}`
    r = await call($, '/mod/register', { sessionId, name: bridge.name, cwd, version: VERSION })
  }
  if (!r.ok) throw new Error(`登记会话 ${bridge.name} 失败：${r.error ?? r.status}`)
  bridge.isRegistered = true
}

function report($: EngineInterface, problem: string | undefined) {
  if (problem === bridge.problem) return
  bridge.problem = problem
  $.ui.status(problem ? `IM：${problem}` : `IM：${bridge.name}`)
}

async function tick($: EngineInterface) {
  if (bridge.isPolling) return
  bridge.isPolling = true
  try {
    if (!bridge.isRegistered) await ensureRegistered($)
    const r = await call($, '/mod/poll', { sessionId: bridge.sessionId, forward: shouldForward() })
    if (r.status === 404) {
      // 中转重启后登记表清空，下一轮重新登记。
      bridge.isRegistered = false
      return
    }
    if (!r.ok) throw new Error(`取信失败：${r.error ?? r.status}`)
    report($, undefined)
    for (const c of r.controls ?? []) await applyControl($, c)
    for (const m of r.messages ?? []) {
      await $.prompt.submit({
        text: `${IM_MARKER} ${m.id}，本轮最终回复会自动发回 IM，请简洁]\n${m.text}`,
      })
    }
  } catch (err) {
    bridge.isRegistered = false
    report($, `中转未连接（${describe(err)}）`)
  } finally {
    bridge.isPolling = false
  }
}

async function sendToIm($: EngineInterface, text: string, msgId?: string) {
  const body = text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}\n…（已截断）` : text
  const r = await call($, '/mod/reply', { sessionId: bridge.sessionId, text: body, ...(msgId ? { msgId } : {}) })
  if (!r.ok) throw new Error(`发往 IM 失败：${r.error ?? r.status}`)
}

async function rename($: EngineInterface, wanted: string) {
  if (!NAME_PATTERN.test(wanted)) {
    return '名字为 1–32 个字母、数字、中文、点、下划线或短横线，例如 /im-name api'
  }
  const previous = bridge.name
  bridge.name = wanted
  try {
    await ensureRegistered($)
  } catch (err) {
    bridge.name = previous
    return `改名失败：${describe(err)}`
  }
  await $.store.set(`name:${bridge.sessionId}`, bridge.name)
  bridge.problem = undefined
  $.ui.status(`IM：${bridge.name}`)
  return `本会话在 IM 里的名字改为 ${bridge.name}`
}

async function setPushMode($: EngineInterface, wanted: string) {
  if (wanted !== 'im' && wanted !== 'all' && wanted !== 'off') {
    return `当前：${bridge.pushMode}。可选 im | all | off`
  }
  bridge.pushMode = wanted
  await $.store.set(`push:${bridge.sessionId}`, wanted)
  return `回传模式改为 ${wanted}`
}

const lastSegment = (path: string) => path.split('/').filter(Boolean).pop() ?? ''

// 默认名字取目录名。worktree 的目录名是随机生成的（如 musing-meitner-591696），
// 看不出属于哪个项目，改成「仓库名-worktree 名第一段」。
export function defaultName(cwd: string, repoRoot: string | undefined) {
  const dir = lastSegment(cwd) || 'session'
  if (!repoRoot || repoRoot === cwd) return dir
  const repo = lastSegment(repoRoot)
  return repo ? `${repo}-${dir.split('-')[0]}` : dir
}

async function start($: EngineInterface, cwd: string) {
  const home = await $.env.get('HOME')
  bridge.socketPath = `${home}/.cc-im-bridge/relay.sock`
  bridge.sessionId = await $.session.id()
  bridge.cwd = cwd
  const storedName = await $.store.get(`name:${bridge.sessionId}`)
  const repo = storedName === undefined ? await $.session.repo() : null
  bridge.name = String(storedName ?? defaultName(cwd, repo?.root))
  const storedMode = await $.store.get(`push:${bridge.sessionId}`)
  bridge.pushMode = storedMode === 'all' || storedMode === 'off' ? storedMode : 'im'
  bridge.isAway = (await $.store.get(`away:${bridge.sessionId}`)) === true

  await $.command.register({ name: 'im-status', description: '查看本会话的 IM 连接状态' })
  await $.command.register({ name: 'im-name', description: '设置本会话在 IM 里的名字：/im-name <名字>' })
  await $.command.register({
    name: 'im-push',
    description: '哪些回复发回 IM：/im-push im（默认，仅 IM 发起的）| all | off',
  })
  await $.command.register({
    name: 'im-away',
    description: '离开模式：本会话的回复、审批、提问都发到 IM。/im-away on | off（IM 里也可说「离开」「回来了」）',
  })
  await $.tool.register({
    name: 'send',
    description:
      '给用户的 IM（企业微信等）发一条消息。用于任务完成、出错或需要用户决定时主动通知；IM 发来的消息你正常回复即可，会自动发回，不必再调用本工具。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '消息内容，简洁' } },
      required: ['text'],
    },
    isDeferred: false,
  })
  $.clock.every(POLL_MS, () => void tick($))
}

async function forwardAnswer($: EngineInterface, turnId: string, answer: string, isAborted: boolean) {
  const msgId = bridge.imTurns.get(turnId)
  const fromIm = msgId !== undefined
  bridge.imTurns.delete(turnId)
  // 离开模式下每一轮都发；否则按 /im-push。
  if (!bridge.isAway && (bridge.pushMode === 'off' || (bridge.pushMode === 'im' && !fromIm))) return
  const text = isAborted ? '（本轮被中断）' : answer.trim() || '（本轮没有文字回复）'
  try {
    await sendToIm($, text, msgId || undefined)
  } catch (err) {
    report($, describe(err))
  }
}

// 报一行进度到 IM（只在 IM 发起的回合里）；失败不影响工具运行。
async function reportProgress($: EngineInterface, tool: string, summary: string) {
  if (!bridge.currentMsgId || !bridge.isRegistered) return
  try {
    await call($, '/mod/progress', { sessionId: bridge.sessionId, msgId: bridge.currentMsgId, tool, summary })
  } catch (err) {
    report($, describe(err))
  }
}

async function sendFromTool($: EngineInterface, text: string) {
  if (!text) return { deny: 'text 不能为空' }
  try {
    await sendToIm($, text)
    return { result: '已发送到 IM' }
  } catch (err) {
    return { deny: describe(err) }
  }
}

async function stop($: EngineInterface) {
  if (!bridge.isRegistered) return
  try {
    await call($, '/mod/unregister', { sessionId: bridge.sessionId })
  } catch (err) {
    // 中转不可达时无需补救：它在 15 秒没有心跳后自然把会话标为离线。
    $.ui.log(`${PLUGIN}：注销会话失败：${describe(err)}`)
  }
}

function summarize(input: unknown) {
  const fields = (input ?? {}) as Record<string, unknown>
  const text =
    SUMMARY_FIELDS.map(k => fields[k]).find((v): v is string => typeof v === 'string') ?? JSON.stringify(input ?? {})
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text
}

// 转发状态变化时立即告诉中转，不等下一次取信；失败无妨，下一次取信会带上。
async function pushForward($: EngineInterface) {
  if (!bridge.isRegistered) return
  try {
    await call($, '/mod/forward', { sessionId: bridge.sessionId, forward: shouldForward() })
  } catch (err) {
    report($, describe(err))
  }
}

async function settleLocal($: EngineInterface, body: { tool?: string; summary?: string }) {
  if (!bridge.isRegistered) return
  try {
    await call($, '/mod/approval/settle-local', { sessionId: bridge.sessionId, ...body })
  } catch (err) {
    report($, describe(err))
  }
}

async function setAway($: EngineInterface, wanted: string) {
  if (wanted !== 'on' && wanted !== 'off') {
    return `当前：${bridge.isAway ? 'on' : 'off'}。on：离开电脑，本会话的回复、审批、提问都发到 IM；off：只有 IM 发起的回合才发`
  }
  bridge.isAway = wanted === 'on'
  await $.store.set(`away:${bridge.sessionId}`, bridge.isAway)
  await pushForward($)
  $.ui.status(bridge.isAway ? `IM：${bridge.name}（离开模式）` : `IM：${bridge.name}`)
  return bridge.isAway ? '已开启离开模式：回复、审批、提问都会发到 IM' : '已关闭离开模式'
}

// IM 里说「停」「离开」「回来了」，由中转随取信转来。
async function applyControl($: EngineInterface, control: Control) {
  try {
    if (control.type === 'away') {
      await setAway($, control.on ? 'on' : 'off')
      return
    }
    if (control.type === 'abort') {
      if (!bridge.runningTurnId) {
        await sendToIm($, '当前没有在运行的回合')
        return
      }
      // 中断后 turn.complete 以「本轮被中断」发回 IM，这里不用另发确认。
      await $.turn.abort({ turnId: bridge.runningTurnId })
    }
  } catch (err) {
    report($, `执行 IM 指令失败：${describe(err)}`)
  }
}

function statusText() {
  return [
    `名字：${bridge.name}`,
    `会话：${bridge.sessionId}`,
    `中转：${bridge.socketPath}`,
    `状态：${bridge.problem ?? (bridge.isRegistered ? '已连接' : '未连接')}`,
    `回传：${bridge.pushMode}`,
    `离开模式：${bridge.isAway ? 'on' : 'off'}`,
    `审批转发：${shouldForward() ? '开（需要批准时发到 IM）' : '关'}`,
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await start($, e.cwd)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__cc-im-bridge__send' }, ($, e) =>
    sendFromTool($, String((e as { text?: unknown }).text ?? '').trim()),
  ).catch(() => ({ deny: `${PLUGIN}：发送失败，钩子出错` }))

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      bridge.runningTurnId = e.turnId
      bridge.isImTurn = e.text.includes(IM_MARKER)
      // 提示词开头形如「[来自 IM 的消息 m12，…」，m12 是那条 IM 消息的 id；旧格式没有 id 时记为空串。
      const msgId = bridge.isImTurn ? (IM_MESSAGE_ID.exec(e.text)?.[1] ?? '') : ''
      if (bridge.isImTurn) bridge.imTurns.set(e.turnId, msgId)
      bridge.currentMsgId = msgId
      await pushForward($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) {
      bridge.isImTurn = false
      if (bridge.runningTurnId === e.turnId) {
        bridge.runningTurnId = ''
        bridge.currentMsgId = ''
      }
      await pushForward($)
      await settleLocal($, {})
      await forwardAnswer($, e.turnId, e.answer, e.isAborted)
    }
    return done
  })

  // 工具开始运行说明已获批准；若这是在电脑上批的，作废 IM 里对应那条还在等的审批。
  on('tool.call', async ($, e, next) => {
    if (!e.agentId && e.tool !== 'mcp__cc-im-bridge__send') {
      const { tool, tool_use_id: _id, agentId: _agent, ...input } = e as unknown as Record<string, unknown>
      const summary = summarize(input)
      void settleLocal($, { tool: String(tool), summary })
      void reportProgress($, String(tool), summary)
    }
    return next(e)
  })

  on('command.run', { command: 'im-status' }, async () => ({ text: statusText() }))
  on('command.run', { command: 'im-name' }, async ($, e) => ({ text: await rename($, e.args.trim()) }))
  on('command.run', { command: 'im-push' }, async ($, e) => ({ text: await setPushMode($, e.args.trim()) }))
  on('command.run', { command: 'im-away' }, async ($, e) => ({ text: await setAway($, e.args.trim()) }))

  on('session.end', async ($, e, next) => {
    await stop($)
    return next(e)
  })
}
