import type { EngineInterface, Register } from 'claude-code'

const PLUGIN = 'cc-im-bridge'
const VERSION = '0.2.1'
const POLL_MS = 2000
const MAX_REPLY_CHARS = 4000
const NAME_PATTERN = /^[\w.\-一-龥]{1,32}$/
// 提交进会话的 IM 消息都带这个开头；回合开始时据此认出由 IM 发起的回合。
const IM_MARKER = '[来自 IM 的消息'
// 审批等待：中转每次最多挂 25 秒，循环 24 次约 10 分钟；按次数而非时钟计，中转异常地立即返回时也会结束。
const LONG_POLL_MS = 25_000
const MAX_APPROVAL_POLLS = 24
const MAX_SUMMARY_CHARS = 1000
// 这两类必须本人在本地操作，hook 的 allow 关不掉对话框（见 ToolCheckResult.decision 的说明）。
const PERSON_ONLY_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
// 只在会弹框问人的权限模式下转发。auto 模式的 ask 本该由分类器决定，转出去会把每次调用都推到 IM；
// bypassPermissions、dontAsk 不问人。还没读到模式时也不转，保持本地原样。
const FORWARD_MODES = new Set(['default', 'acceptEdits', 'plan'])

type PushMode = 'im' | 'all' | 'off'
type RelayAnswer = {
  status: number
  ok: boolean
  error?: string
  messages?: { text: string }[]
  id?: number
  approval?: { id: number; state: string; reason: string }
}
type ImVerdict = { decision: 'allow' | 'deny'; reason: string }

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
  // 由 IM 消息开启、还没结束的回合 id：这些回合的回复要发回 IM。
  // 按回合 id 认，而不是在取信时计数：取信时上一回合可能还没结束。
  imTurnIds: new Set<string>(),
  // 主循环当前回合；审批时据此判断这一回合是不是 IM 发起的（人可能不在电脑前）。
  currentTurnId: '',
  // 开启后本地发起的回合也把审批转到 IM。
  isAway: false,
  // 从经典钩子事件的公共字段 permission_mode 读到的当前权限模式。
  permissionMode: '',
}

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
    const r = await call($, '/mod/poll', { sessionId: bridge.sessionId })
    if (r.status === 404) {
      // 中转重启后登记表清空，下一轮重新登记。
      bridge.isRegistered = false
      return
    }
    if (!r.ok) throw new Error(`取信失败：${r.error ?? r.status}`)
    report($, undefined)
    for (const m of r.messages ?? []) {
      await $.prompt.submit({
        text: `${IM_MARKER}，本轮最终回复会自动发回 IM，请简洁]\n${m.text}`,
      })
    }
  } catch (err) {
    bridge.isRegistered = false
    report($, `中转未连接（${describe(err)}）`)
  } finally {
    bridge.isPolling = false
  }
}

async function sendToIm($: EngineInterface, text: string) {
  const body = text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}\n…（已截断）` : text
  const r = await call($, '/mod/reply', { sessionId: bridge.sessionId, text: body })
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

async function start($: EngineInterface, cwd: string) {
  const home = await $.env.get('HOME')
  bridge.socketPath = `${home}/.cc-im-bridge/relay.sock`
  bridge.sessionId = await $.session.id()
  bridge.cwd = cwd
  const storedName = await $.store.get(`name:${bridge.sessionId}`)
  bridge.name = String(storedName ?? cwd.split('/').filter(Boolean).pop() ?? 'session')
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
    description: '离开电脑时开启：本地发起的回合需要批准时也发到 IM。/im-away on | off',
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
  const fromIm = bridge.imTurnIds.delete(turnId)
  if (bridge.pushMode === 'off' || (bridge.pushMode === 'im' && !fromIm)) return
  const text = isAborted ? '（本轮被中断）' : answer.trim() || '（本轮没有文字回复）'
  try {
    await sendToIm($, text)
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
    ['command', 'file_path', 'url', 'path', 'pattern']
      .map(k => fields[k])
      .find((v): v is string => typeof v === 'string') ?? JSON.stringify(input ?? {})
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text
}

function shouldAskViaIm(tool: string, toolUseId: string | undefined) {
  if (!toolUseId || !bridge.isRegistered || PERSON_ONLY_TOOLS.has(tool)) return false
  if (!FORWARD_MODES.has(bridge.permissionMode)) return false
  return bridge.isAway || bridge.imTurnIds.has(bridge.currentTurnId)
}

// 把审批发到 IM 并等答复；没等到（超时、中断、中转出错）返回 undefined，交回本地审批。
async function askViaIm($: EngineInterface, tool: string, input: unknown, signal: AbortSignal): Promise<ImVerdict | undefined> {
  const req = await call($, '/mod/approval/request', { sessionId: bridge.sessionId, tool, summary: summarize(input) })
  if (!req.ok || req.id === undefined) {
    report($, `审批转发失败：${req.error ?? req.status}`)
    return undefined
  }
  const id = req.id
  $.ui.status(`IM：等待 IM 审批 #${id}`)
  try {
    for (let i = 0; i < MAX_APPROVAL_POLLS && !signal.aborted; i++) {
      const r = await call($, '/mod/approval/wait', { id, timeoutMs: LONG_POLL_MS })
      if (!r.ok || !r.approval) throw new Error(`查询审批 #${id} 失败：${r.error ?? r.status}`)
      const { state, reason } = r.approval
      if (state === 'approved') return { decision: 'allow', reason: `用户已在 IM 批准（#${id}）` }
      if (state === 'denied') return { decision: 'deny', reason: `用户在 IM 拒绝了（#${id}）${reason ? `：${reason}` : ''}` }
      if (state !== 'pending') return undefined
    }
    await call($, '/mod/approval/cancel', { id, why: signal.aborted ? '会话已中断' : '10 分钟未答复，转回电脑上审批' })
    return undefined
  } finally {
    $.ui.status(`IM：${bridge.name}`)
  }
}

async function setAway($: EngineInterface, wanted: string) {
  if (wanted !== 'on' && wanted !== 'off') {
    return `当前：${bridge.isAway ? 'on' : 'off'}。on：本地发起的回合也把审批转到 IM；off：只转 IM 发起的回合`
  }
  bridge.isAway = wanted === 'on'
  await $.store.set(`away:${bridge.sessionId}`, bridge.isAway)
  return bridge.isAway ? '已开启：需要批准时都会发到 IM' : '已关闭：只有 IM 发起的回合会把审批发到 IM'
}

function statusText() {
  return [
    `名字：${bridge.name}`,
    `会话：${bridge.sessionId}`,
    `中转：${bridge.socketPath}`,
    `状态：${bridge.problem ?? (bridge.isRegistered ? '已连接' : '未连接')}`,
    `回传：${bridge.pushMode}`,
    `离开模式：${bridge.isAway ? 'on' : 'off'}`,
    `权限模式：${bridge.permissionMode || '未知'}（${FORWARD_MODES.has(bridge.permissionMode) ? '会' : '不会'}转发审批）`,
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
      bridge.currentTurnId = e.turnId
      if (e.text.includes(IM_MARKER)) bridge.imTurnIds.add(e.turnId)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) {
      if (bridge.currentTurnId === e.turnId) bridge.currentTurnId = ''
      await forwardAnswer($, e.turnId, e.answer, e.isAborted)
    }
    return done
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.permission_mode) bridge.permissionMode = e.permission_mode
    return next(e)
  })

  on('classic.PreToolUse', async ($, e, next) => {
    // 公共字段在运行时都有，但按工具收窄后的类型没有列出，所以按通用形状读。
    const mode = (e as { permission_mode?: string }).permission_mode
    if (mode) bridge.permissionMode = mode
    return next(e)
  })

  // 引擎判定要问人时，若人可能不在电脑前，就把这次审批转到 IM；IM 没答复则照常本地弹框。
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || !shouldAskViaIm(e.tool, e.tool_use_id)) return verdict
    const answer = await askViaIm($, e.tool, e.input, next.signal)
    return answer ?? verdict
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'im-status' }, async () => ({ text: statusText() }))
  on('command.run', { command: 'im-name' }, async ($, e) => ({ text: await rename($, e.args.trim()) }))
  on('command.run', { command: 'im-push' }, async ($, e) => ({ text: await setPushMode($, e.args.trim()) }))
  on('command.run', { command: 'im-away' }, async ($, e) => ({ text: await setAway($, e.args.trim()) }))

  on('session.end', async ($, e, next) => {
    await stop($)
    return next(e)
  })
}
