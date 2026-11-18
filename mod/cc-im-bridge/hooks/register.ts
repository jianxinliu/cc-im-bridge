import type { EngineInterface, Register } from 'claude-code'

const PLUGIN = 'cc-im-bridge'
const VERSION = '0.7.1'
const POLL_MS = 2000
const MAX_REPLY_CHARS = 4000
const MAX_NAME_CHARS = 32
// 冒号用作「名字：内容」的分隔，不能出现在名字里。
const NAME_FORBIDDEN = /[:：\p{Cc}]/u
// 提交进会话的 IM 消息都带「[企微 m12] 」开头：回合开始时据此认出由 IM 发起的回合，
// m12 是那条 IM 消息的 id，用来把进度和回复接到它的流式回复上。
const IM_MESSAGE_ID = /^\[企微(?: (m\d+))?\] /
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
type Control = { type: 'abort' } | { type: 'away'; on: boolean } | { type: 'suggest' }

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
  // 正在生成下一步建议：一次只生成一组。
  isSuggesting: false,
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
    const r = await call($, '/mod/poll', { sessionId: bridge.sessionId, forward: shouldForward(), away: bridge.isAway })
    if (r.status === 404) {
      // 中转重启后登记表清空，下一轮重新登记。
      bridge.isRegistered = false
      return
    }
    if (!r.ok) throw new Error(`取信失败：${r.error ?? r.status}`)
    report($, undefined)
    for (const c of r.controls ?? []) await applyControl($, c)
    for (const m of r.messages ?? []) {
      // asUser：按用户自己的话提交，不套 Claude Code 默认的「某插件发来一条消息」说明。
      await $.prompt.submit({ text: `[企微${m.id ? ` ${m.id}` : ''}] ${m.text}`, asUser: true })
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

export function normalizeName(raw: string) {
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name || [...name].length > MAX_NAME_CHARS || NAME_FORBIDDEN.test(name)) return undefined
  return name
}

async function rename($: EngineInterface, raw: string) {
  const wanted = normalizeName(raw)
  if (!wanted) return `名字为 1–${MAX_NAME_CHARS} 个字，可以有空格，不能含冒号，例如 /im-name 后端 API`
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
      '给用户的 IM（企业微信）发一条消息或一个本机文件。用于任务完成、出错、需要用户决定时主动通知，或把截图、报告等文件发到用户手机（PNG/JPG 不超过 10MB 按图片发，其他不超过 20MB 按文件发）。IM 发来的消息你正常回复即可，会自动发回，不必再调用本工具。用户从 IM 发来的图片和文件已存在本机，消息里会给出「[图片] 路径」「[文件] 路径」，直接读取即可。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '消息内容，简洁；发文件时作为说明，可省略' },
        file: { type: 'string', description: '要发送的本机文件的绝对路径，可省略' },
      },
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

async function sendFromTool($: EngineInterface, text: string, file: string) {
  if (!text && !file) return { deny: 'text 和 file 至少给一个' }
  try {
    if (file) {
      const r = await call($, '/mod/file', { sessionId: bridge.sessionId, path: file, caption: text })
      if (!r.ok) return { deny: `文件没发出：${r.error ?? r.status}` }
      return { result: `已交给 IM 发送：${file}` }
    }
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

// source：local 为在电脑上执行 /im-away，要通知 IM；im 为 IM 里说的，中转已经回复过。
async function setAway($: EngineInterface, wanted: string, source: 'local' | 'im' = 'local') {
  if (wanted !== 'on' && wanted !== 'off') {
    return `当前：${bridge.isAway ? 'on' : 'off'}。on：离开电脑，本会话的回复、审批、提问都发到 IM；off：只有 IM 发起的回合才发`
  }
  const changed = bridge.isAway !== (wanted === 'on')
  bridge.isAway = wanted === 'on'
  await $.store.set(`away:${bridge.sessionId}`, bridge.isAway)
  await pushForward($)
  if (source === 'local' && changed && bridge.isRegistered) {
    try {
      await call($, '/mod/away', { sessionId: bridge.sessionId, on: bridge.isAway })
    } catch (err) {
      report($, `通知 IM 失败：${describe(err)}`)
    }
  }
  $.ui.status(bridge.isAway ? `IM：${bridge.name}（离开模式）` : `IM：${bridge.name}`)
  return bridge.isAway ? '已开启离开模式：回复、审批、提问都会发到 IM' : '已关闭离开模式'
}

// 不指定推理强度：指定一个与会话不同的强度时，部分模型要把整段对话重新写一遍缓存，对话越长越贵。
// 改为在提示里要求直接作答。
const SUGGEST_PROMPT = [
  '（这是 IM 桥接插件的后台请求，不是用户在对话。不要调用工具，不要思考过程，直接作答。）',
  '根据以上对话，列出用户接下来最可能让你做的 3 到 4 件事。',
  '每条写成用户会直接发给你的一句话，不超过 25 个字。',
  '只输出一个 JSON 字符串数组，例如 ["跑一下全部测试","把改动提交"]，不要其他内容。',
].join('\n')
const MAX_SUGGESTIONS = 4

// 从模型回复里取出建议：优先按 JSON 数组解析，不行就按行拆、去掉编号和符号。
export function parseSuggestions(text: string) {
  const json = /\[[\s\S]*\]/.exec(text)?.[0]
  if (json) {
    try {
      const list: unknown = JSON.parse(json)
      if (Array.isArray(list)) {
        return list.map(item => String(item).trim()).filter(Boolean).slice(0, MAX_SUGGESTIONS)
      }
    } catch {
      // 不是合法 JSON 时按行拆
    }
  }
  return text
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-*•·]|\d+[.、)）])\s*/, '').replace(/^["“]|["”]$/g, '').trim())
    .filter(Boolean)
    .slice(0, MAX_SUGGESTIONS)
}

async function suggestNext($: EngineInterface) {
  if (bridge.isSuggesting) return
  bridge.isSuggesting = true
  try {
    const r = await $.model.fork({ prompt: SUGGEST_PROMPT })
    let body: { items?: string[]; error?: string }
    if (r.isAnswered) {
      const items = parseSuggestions(r.text)
      body = items.length ? { items } : { error: '没想出合适的下一步' }
    } else if (r.reason === 'nothing-to-fork') {
      body = { error: '这个会话还没有可参考的上下文，先聊一轮' }
    } else {
      body = { error: `生成建议失败（${r.reason}）` }
    }
    await call($, '/mod/suggestions', { sessionId: bridge.sessionId, ...body })
  } catch (err) {
    report($, `生成建议失败：${describe(err)}`)
  } finally {
    bridge.isSuggesting = false
  }
}

// IM 里说「停」「离开」「回来了」，由中转随取信转来。
async function applyControl($: EngineInterface, control: Control) {
  try {
    if (control.type === 'away') {
      await setAway($, control.on ? 'on' : 'off', 'im')
      return
    }
    if (control.type === 'suggest') {
      // 调模型要几秒到十几秒，不能占着取信。
      void suggestNext($)
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
    sendFromTool(
      $,
      String((e as { text?: unknown }).text ?? '').trim(),
      String((e as { file?: unknown }).file ?? '').trim(),
    ),
  ).catch(() => ({ deny: `${PLUGIN}：发送失败，钩子出错` }))

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      bridge.runningTurnId = e.turnId
      const imMatch = IM_MESSAGE_ID.exec(e.text)
      // 没有消息 id 时（中转没给）仍算 IM 回合，只是无法接到流式回复上。
      const msgId = imMatch ? (imMatch[1] ?? '') : undefined
      bridge.isImTurn = msgId !== undefined
      if (msgId !== undefined) bridge.imTurns.set(e.turnId, msgId)
      bridge.currentMsgId = msgId ?? ''
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
