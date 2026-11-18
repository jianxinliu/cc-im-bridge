// 中转的路由逻辑：会话登记、按会话排队、解析 IM 侧的命令。不做任何 I/O，便于测试。

export const ONLINE_WINDOW_MS = 15_000
export const APPROVAL_TTL_MS = 15 * 60_000
const MAX_QUEUE = 50
const MAX_LOG = 500

import { describeTool } from './describe.mjs'

const PROGRESS_CHARS = 60

export const STATUS_TEXT = { pending: '待批', approved: '已批准', denied: '已拒绝', cancelled: '已作废', expired: '已超时' }
// 只有一条待批时，单独回这些词当作批准或拒绝（去掉标点后整句精确匹配，避免把闲聊当成批准）。
// 批准词只收明确的肯定；拒绝方向放宽一些，误判也只是不执行。
const APPROVE_WORDS = new Set(['好', '好的', '好啊', '可以', '行', '批准', '同意', '确认', 'ok'])
const DENY_WORDS = ['不行', '不可以', '不要', '不用', '拒绝', '不同意', '先别', '别', '不', 'no', 'n']
const LIST_PHRASES = new Set(['/list', '/ls', '会话', '会话列表', '有哪些会话', '列一下会话', '列出会话', '看看会话'])
const SUGGEST_PHRASES = new Set(['建议', '接下来做什么', '下一步', '有什么建议'])
const SUGGESTION_TTL_MS = 10 * 60_000
const MAX_SUGGESTIONS = 4
const HELP_PHRASES = new Set(['/help', '用法', '帮助', 'help', '?', '？'])
const HELP_TEXT = [
  '会话：点选会话',
  '切到 名字：之后发给它',
  '名字：内容：只发这一条',
  '停：中断当前这一轮',
  '离开：选一个会话遥控（离开 2：直接指定）',
  '回来了：所有会话退出遥控',
  '好 / 不行，原因：批准或拒绝',
  '建议：按会话上下文给几个下一步，点编号发送',
  '/pending：查看待批',
].join('\n')
const STOP_PHRASES = new Set(['停', '停止', '停下', '中断', '别做了', 'stop'])
const AWAY_PHRASES = new Set(['离开', '我走了', '我离开了', '离开模式', '出门了', '遥控'])
const AWAY_WITH_TARGET = /^(?:离开|遥控)\s+(.+)$/
const BACK_PHRASES = new Set(['回来了', '我回来了', '回来', '关闭离开模式'])
const USE_PATTERN = /^(?:\/use|切到|切换到|换到)\s*(.+)$/

// titleOf(sessionId)：会话在 Desktop 侧边栏上的标题（读不到返回 undefined），企微里优先用它显示和匹配。
// initialTarget / onTargetChange：当前会话的持久化，让中转重启后不用重新选会话。
export function createRelay({ now = () => Date.now(), titleOf = () => undefined, initialTarget = null, onTargetChange = () => {} } = {}) {
  const sessions = new Map() // sessionId -> { sessionId, name, cwd, lastSeen, queue: [] }
  const log = [] // 发往 IM 的消息与收到的 IM 消息，供 IM 适配器按序号拉取
  let seq = 0
  let target = initialTarget // 当前默认投递的 sessionId
  function setTarget(sessionId) {
    if (sessionId === target) return
    target = sessionId
    onTargetChange(target)
  }
  const outgoingListeners = [] // IM 适配器：每条发往 IM 的消息都通知它们
  const approvals = new Map() // id -> { id, sessionId, name, tool, summary, status, reason, createdAt }
  const approvalListeners = [] // 审批状态变化时通知等待者
  const questions = new Map() // id -> { id, sessionId, name, items, answers, status, createdAt }
  const questionListeners = []
  let questionSeq = 0
  let messageSeq = 0
  // 最近一次的「下一步建议」：{ id, sessionId, items, createdAt }。回复编号或点卡片按钮即发送对应那条。
  let latestSuggestions = null
  let suggestionSeq = 0
  let approvalSeq = 0

  const isOnline = s => now() - s.lastSeen <= ONLINE_WINDOW_MS
  const byName = name => [...sessions.values()].find(s => s.name === name)

  // 企微里显示的名字：侧边栏标题，读不到时用插件登记的名字。
  function label(s) {
    try {
      return titleOf(s.sessionId) || s.name
    } catch {
      return s.name
    }
  }
  const namesOf = s => [label(s), s.name].map(n => n.toLowerCase())

  // 每个会话一个在登记期间不变的小编号，IM 里可以用 @2、/use 2 指代。
  function freeNumber() {
    const used = new Set([...sessions.values()].map(s => s.num))
    let n = 1
    while (used.has(n)) n++
    return n
  }

  // 按编号、完整名字或唯一前缀找会话；找不到或有歧义时返回给 IM 的提示。
  function resolve(ref) {
    const all = [...sessions.values()]
    if (/^\d+$/.test(ref)) {
      const s = all.find(x => x.num === Number(ref))
      return s ? { session: s } : { error: `没有编号 ${ref} 的会话，发 /list 查看` }
    }
    const lower = ref.trim().toLowerCase()
    const exact = all.filter(x => namesOf(x).includes(lower))
    if (exact.length === 1) return { session: exact[0] }
    const matches = exact.length > 1 ? exact : all.filter(x => namesOf(x).some(n => n.startsWith(lower)))
    if (matches.length === 1) return { session: matches[0] }
    if (matches.length > 1) {
      return { error: `${ref} 能匹配多个会话：${matches.map(x => `${x.num}.${label(x)}`).join('、')}，用编号或写长一点` }
    }
    return { error: `没有名为 ${ref} 的会话，发 /list 查看` }
  }

  function pushLog(entry) {
    const record = { seq: ++seq, ts: now(), ...entry }
    log.push(record)
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG)
    if (record.dir === 'out') for (const listener of outgoingListeners) listener(record)
  }
  const tell = text => pushLog({ dir: 'out', from: 'relay', text })

  function register({ sessionId, name, cwd, version }) {
    if (!sessionId || !name) return { ok: false, status: 400, error: 'sessionId 和 name 必填' }
    const holder = byName(name)
    if (holder && holder.sessionId !== sessionId && isOnline(holder)) {
      return { ok: false, status: 409, error: `名字 ${name} 已被在线会话占用` }
    }
    let inherited
    if (holder && holder.sessionId !== sessionId) {
      inherited = holder.num
      sessions.delete(holder.sessionId)
    }
    const existing = sessions.get(sessionId)
    sessions.set(sessionId, {
      sessionId,
      num: existing?.num ?? inherited ?? freeNumber(),
      name,
      cwd: cwd ?? '',
      version: version ?? '',
      lastSeen: now(),
      queue: existing?.queue ?? [],
      // 给会话插件的控制指令（中断、开关离开模式），随取信一起拿走。
      controls: existing?.controls ?? [],
      forward: existing?.forward ?? false,
      // 会话插件上报的离开模式状态，用于在会话列表上标「遥控中」。
      away: existing?.away ?? false,
    })
    return { ok: true, name }
  }

  function unregister({ sessionId }) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: false, status: 404, error: `未登记的会话 ${sessionId}` }
    sessions.delete(sessionId)
    if (target === sessionId) setTarget(null)
    return { ok: true }
  }

  // 会话取信，同时上报「需要批准时是否转到 IM」（IM 发起的回合或离开模式下为 true）。
  function poll({ sessionId, forward, away }) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: false, status: 404, error: `未登记的会话 ${sessionId}` }
    s.lastSeen = now()
    if (typeof forward === 'boolean') s.forward = forward
    if (typeof away === 'boolean') s.away = away
    const messages = s.queue.splice(0)
    const controls = s.controls.splice(0)
    return { ok: true, messages, controls }
  }

  // msgId：这条回复对应的企微消息（会话插件从提示词里认出）。带上时 IM 适配器把它作为那条消息的流式回复收尾。
  function reply({ sessionId, text, msgId }) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: false, status: 404, error: `未登记的会话 ${sessionId}` }
    if (!text?.trim()) return { ok: false, status: 400, error: 'text 为空' }
    s.lastSeen = now()
    pushLog({ dir: 'out', from: label(s), text, ...(msgId ? { stream: { key: msgId, phase: 'final' } } : {}) })
    return { ok: true }
  }

  // 会话要发一个本机文件到 IM。路径、大小、按图片还是文件发，由中转进程在调用前核对好。
  function fileOut({ sessionId, path, name, kind, caption }) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: false, status: 404, error: `未登记的会话 ${sessionId}` }
    s.lastSeen = now()
    const text = [String(caption ?? '').trim(), `[${kind === 'image' ? '图片' : '文件'}] ${name}`].filter(Boolean).join('\n')
    pushLog({ dir: 'out', from: label(s), text, file: { path, name, kind } })
    return { ok: true }
  }

  // 企微发起的回合里每调用一个工具，会话插件报一行进度，IM 适配器刷新到那条消息的流式回复里。
  function progress({ sessionId, msgId, tool, summary }) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: false, status: 404, error: `未登记的会话 ${sessionId}` }
    if (!msgId || !tool) return { ok: false, status: 400, error: 'msgId 和 tool 必填' }
    const brief = String(summary ?? '').replace(/\s+/g, ' ').trim()
    const line = `${describeTool(tool)}${brief ? `：${brief.length > PROGRESS_CHARS ? `${brief.slice(0, PROGRESS_CHARS)}…` : brief}` : ''}`
    pushLog({ dir: 'out', from: label(s), text: line, stream: { key: msgId, phase: 'progress' } })
    return { ok: true }
  }

  function list() {
    return [...sessions.values()]
      .sort((a, b) => a.num - b.num)
      .map(s => ({
      num: s.num,
      name: label(s),
      alias: s.name,
      cwd: s.cwd,
      version: s.version,
      online: isOnline(s),
      queued: s.queue.length,
      current: s.sessionId === target,
      away: s.away,
    }))
  }

  // meta.reqId：企微这条消息的回调 req_id；有它时回执改为流式回复的开头，之后的进度与最终回复都刷新在同一条里。
  function deliver(s, text, meta = {}) {
    if (s.queue.length >= MAX_QUEUE) {
      tell(`${label(s)} 的待投递消息已满 ${MAX_QUEUE} 条，本条未投递`)
      return
    }
    const id = `m${++messageSeq}`
    s.queue.push({ id, text, ts: now() })
    setTarget(s.sessionId)
    const receipt = isOnline(s) ? `→ ${label(s)}` : `→ ${label(s)}（会话离线，已排队，上线后投递）`
    if (meta.reqId) pushLog({ dir: 'out', from: 'relay', text: receipt, stream: { key: id, reqId: meta.reqId, phase: 'start', title: label(s) } })
    else tell(receipt)
  }

  // IM 侧发来的一条消息：命令、@指定会话，或发给当前会话。meta 见 deliver。
  function handleIncoming(raw, meta = {}) {
    const text = String(raw ?? '').trim()
    if (!text) return
    pushLog({ dir: 'in', from: 'me', text })

    if (LIST_PHRASES.has(text)) {
      const rows = list()
      if (rows.length === 0) return tell('没有已登记的会话')
      pushLog({
        dir: 'out',
        from: 'relay',
        text: rows.map(r => `${r.current ? '*' : ' '} ${r.num}. ${r.name}${r.online ? '' : '（离线）'}${r.away ? '（遥控中）' : ''}  ${r.cwd}`).join('\n'),
        // IM 适配器据此画成每个会话一个按钮的卡片。
        sessions: rows,
      })
      return
    }

    const use = text.match(USE_PATTERN)
    if (use) {
      const r = useSession(use[1])
      return tell(r.ok ? `之后的消息发给 ${r.name}` : r.error)
    }

    const decision = text.match(/^\/(y|n)(?:\s+([\s\S]*))?$/)
    if (decision) return decideFromIm(decision[1] === 'y', decision[2] ?? '')

    if (answerFromText(text)) return

    if (SUGGEST_PHRASES.has(text)) {
      const s = currentSession()
      if (!s) return tell('先选一个会话：发「会话」点选')
      if (!isOnline(s)) return tell(`${label(s)} 不在线`)
      requestSuggestions(s)
      return tell(`正在让 ${label(s)} 想几个下一步…`)
    }

    // 刚给过建议时，单独回一个编号就发送那条。
    if (/^\d$/.test(text) && latestSuggestions && now() - latestSuggestions.createdAt <= SUGGESTION_TTL_MS) {
      const r = sendSuggestion({ id: latestSuggestions.id, n: Number(text) })
      if (!r.ok) tell(r.error)
      return
    }

    if (naturalDecision(text)) return

    if (STOP_PHRASES.has(text.toLowerCase())) {
      const s = currentSession()
      if (!s) return tell('不确定要停哪个会话：发「会话」点选一个')
      s.controls.push({ type: 'abort' })
      return tell(`已让 ${label(s)} 停下当前这一轮`)
    }

    // 「离开 2」「离开 名字」：直接遥控指定会话。
    const awayTarget = text.match(AWAY_WITH_TARGET)
    if (awayTarget) {
      const r = awaySession(awayTarget[1])
      return tell(r.ok ? r.message : r.error)
    }

    // 「离开」：只有一个在线会话就直接遥控它；多个时回一张卡片让你选。
    if (AWAY_PHRASES.has(text)) {
      const online = [...sessions.values()].filter(isOnline)
      if (online.length === 0) return tell('没有在线的会话')
      if (online.length === 1) return tell(awaySession(online[0].num).message)
      const rows = list()
      pushLog({
        dir: 'out',
        from: 'relay',
        text: ['选择要遥控的会话（回「离开 编号」）：', ...rows.map(r => `${r.num}. ${r.name}${r.away ? '（遥控中）' : ''}`)].join('\n'),
        awayPicker: rows,
      })
      return
    }

    // 回到电脑前：所有会话都恢复原样。
    if (BACK_PHRASES.has(text)) {
      const remote = [...sessions.values()].filter(s => s.away)
      for (const s of sessions.values()) {
        s.controls.push({ type: 'away', on: false })
        s.away = false
      }
      return tell(remote.length ? `已关闭离开模式：${remote.map(label).join('、')}` : '没有开着离开模式的会话')
    }

    if (text === '/pending') {
      const pending = pendingApprovals()
      return tell(pending.length === 0 ? '没有待批的请求' : pending.map(a => `#${a.id} ${a.name}：${a.toolLabel} ${a.detail.split('\n')[0]}`).join('\n'))
    }

    if (HELP_PHRASES.has(text.toLowerCase())) return tell(HELP_TEXT)

    const at = text.match(/^@(\S+)\s+([\s\S]+)$/)
    if (at) {
      const { session: s, error } = resolve(at[1])
      if (!s) return tell(error)
      return deliver(s, at[2], meta)
    }

    // 「api：跑一下测试」：冒号前是某个会话的完整名字或编号时，发给它；
    // 只认完整名字，避免「注意：xxx」这类普通句子被误当成会话名。
    const named = text.match(/^([^:：\n]{1,40}?)\s*[：:]\s*([\s\S]+)$/)
    if (named) {
      const key = named[1].trim().toLowerCase()
      const s = [...sessions.values()].find(x => namesOf(x).includes(key) || String(x.num) === key)
      if (s) return deliver(s, named[2], meta)
    }

    const s = currentSession()
    if (!s) return tell('不确定发给哪个会话：发「会话」点选一个，或说「切到 名字」')
    deliver(s, text, meta)
  }

  // 不带会话名的消息发给谁：选过的会话；没选过且只有一个在线时就是它。
  function currentSession() {
    const chosen = target ? sessions.get(target) : undefined
    if (chosen) return chosen
    const online = [...sessions.values()].filter(isOnline)
    return online.length === 1 ? online[0] : undefined
  }

  // 让会话插件按上下文生成几条下一步建议（插件调模型，结果经 suggestions() 回来）。
  function requestSuggestions(s) {
    if (!isOnline(s) || s.controls.some(c => c.type === 'suggest')) return
    s.controls.push({ type: 'suggest' })
  }

  function suggestions({ sessionId, items, error }) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: false, status: 404, error: `未登记的会话 ${sessionId}` }
    if (error) {
      tell(`${label(s)}：${error}`)
      return { ok: true }
    }
    const clean = (Array.isArray(items) ? items : [])
      .map(t => String(t).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, MAX_SUGGESTIONS)
    if (clean.length === 0) {
      tell(`${label(s)}：没想出合适的下一步`)
      return { ok: true }
    }
    latestSuggestions = { id: ++suggestionSeq, sessionId, items: clean, createdAt: now() }
    pushLog({
      dir: 'out',
      from: label(s),
      text: ['接下来可以：', ...clean.map((t, i) => `${i + 1}. ${t}`), '回复编号发送'].join('\n'),
      suggestions: { id: latestSuggestions.id, name: label(s), items: clean },
    })
    return { ok: true }
  }

  // 发送第 n 条建议（从 1 起），像用户自己说的一样投给会话。
  function sendSuggestion({ id, n }) {
    const sug = latestSuggestions
    if (!sug || sug.id !== Number(id) || now() - sug.createdAt > SUGGESTION_TTL_MS) {
      return { ok: false, error: '这组建议已过期，发「建议」重新生成' }
    }
    const text = sug.items[n - 1]
    const s = sessions.get(sug.sessionId)
    if (!text) return { ok: false, error: `没有第 ${n} 条建议` }
    if (!s) return { ok: false, error: '会话已不存在' }
    // 发出一条后这组建议就用掉了，免得之后回的数字又被当成选建议。
    latestSuggestions = null
    deliver(s, text)
    return { ok: true, text }
  }

  // 遥控一个会话：它进入离开模式并成为当前会话；同一时间只遥控一个，其他会话退出离开模式，
  // 否则多个会话的回复会一起涌进 IM。
  function awaySession(ref) {
    const { session: s, error } = resolve(String(ref))
    if (!s) return { ok: false, error }
    const released = []
    for (const other of sessions.values()) {
      if (other === s || !other.away) continue
      other.controls.push({ type: 'away', on: false })
      other.away = false
      released.push(label(other))
    }
    if (!s.away) s.controls.push({ type: 'away', on: true })
    s.away = true
    setTarget(s.sessionId)
    requestSuggestions(s)
    const switched = released.length ? `（${released.join('、')} 已退出遥控）` : ''
    return {
      ok: true,
      name: label(s),
      rows: list(),
      message: `正在遥控 ${label(s)}：它每一轮的回复、审批、提问都发到这里${switched}。回到电脑说「回来了」`,
    }
  }

  // 切换之后不带会话名的消息发给谁。ref 可以是编号、名字或唯一前缀。
  function useSession(ref) {
    const { session: s, error } = resolve(String(ref))
    if (!s) return { ok: false, error }
    setTarget(s.sessionId)
    requestSuggestions(s)
    return { ok: true, name: label(s), num: s.num }
  }

  const since = n => log.filter(e => e.seq > n)

  const onOutgoing = listener => outgoingListeners.push(listener)

  // ---- 审批 ----
  function settle(a, status, reason) {
    a.status = status
    a.reason = reason
    for (const listener of approvalListeners) listener(a)
  }

  function expireOld() {
    for (const a of approvals.values()) {
      if (a.status === 'pending' && now() - a.createdAt > APPROVAL_TTL_MS) settle(a, 'expired', '超时')
    }
  }

  // summary 用于匹配（与 mod 一致）；detail 是给人看的多行说明，没有就用 summary。
  function requestApproval({ sessionId, tool, summary, detail }) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: false, status: 404, error: `未登记的会话 ${sessionId}` }
    if (!tool) return { ok: false, status: 400, error: 'tool 必填' }
    expireOld()
    const a = {
      id: ++approvalSeq,
      sessionId,
      name: label(s),
      tool,
      toolLabel: describeTool(tool),
      summary: summary ?? '',
      detail: detail || summary || '',
      status: 'pending',
      reason: '',
      createdAt: now(),
    }
    approvals.set(a.id, a)
    pushLog({
      dir: 'out',
      from: a.name,
      text: `请求批准 #${a.id}：${a.toolLabel}\n${a.detail}\n回复「好」批准，「不行」拒绝`.replace(/\n\n/g, '\n'),
      // IM 适配器据此画成带按钮的卡片；网页窗口仍显示 text。
      approval: { id: a.id, name: a.name, tool: a.toolLabel, summary: a.detail },
    })
    return { ok: true, id: a.id }
  }

  function getApproval({ id }) {
    expireOld()
    const a = approvals.get(Number(id))
    if (!a) return { ok: false, status: 404, error: `没有审批 #${id}` }
    return { ok: true, status: 200, approval: { id: a.id, state: a.status, reason: a.reason } }
  }

  // 会话那边不再等了（本地处理、中断、超时），作废这条审批。
  function setForward({ sessionId, forward }) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: false, status: 404, error: `未登记的会话 ${sessionId}` }
    s.forward = Boolean(forward)
    return { ok: true }
  }

  // settings 的 PermissionRequest 钩子来问：这个会话现在要不要把审批转到 IM。
  // 未登记、离线或没开转发的会话直接答「不转」，让本地照常弹框。
  function hookPermission({ sessionId, tool, summary, detail }) {
    const s = sessions.get(sessionId)
    if (!s || !isOnline(s) || !s.forward) return { ok: true, forward: false }
    return { ...requestApproval({ sessionId, tool, summary, detail }), forward: true }
  }

  // 工具已经开始运行（说明已在电脑上批准）或回合已结束时，作废这个会话还挂着的审批。
  // 给了 tool 和 summary 时只作废对得上的那条，避免并行的其他审批被误伤。
  // 提问只有一种来源（AskUserQuestion），工具开始运行或回合结束都说明已在电脑上答过。
  function settleLocal({ sessionId, tool, summary }) {
    let count = 0
    if (tool === undefined || tool === 'AskUserQuestion') {
      for (const q of questions.values()) {
        if (q.sessionId !== sessionId || q.status !== 'pending') continue
        settleQuestion(q, 'cancelled')
        tell(`提问 Q${q.id} 已在电脑上回答，无需再回复`)
        count++
      }
    }
    for (const a of approvals.values()) {
      if (a.sessionId !== sessionId || a.status !== 'pending') continue
      if (tool !== undefined && (a.tool !== tool || a.summary !== summary)) continue
      settle(a, 'cancelled', '已在电脑上处理')
      tell(`审批 #${a.id} 已在电脑上处理，无需再回复`)
      count++
    }
    return { ok: true, cancelled: count }
  }

  function cancelApproval({ id, why }) {
    const a = approvals.get(Number(id))
    if (!a) return { ok: false, status: 404, error: `没有审批 #${id}` }
    if (a.status === 'pending') {
      settle(a, 'cancelled', why ?? '')
      tell(`审批 #${a.id} 已作废${why ? `：${why}` : ''}`)
    }
    return { ok: true }
  }

  function pendingApprovals() {
    expireOld()
    return [...approvals.values()].filter(a => a.status === 'pending')
  }

  // 按编号批准或拒绝。已经有结果的不再改，返回当前结果，供卡片按钮显示最终状态。
  function decideApproval({ id, approve, reason = '' }) {
    expireOld()
    const a = approvals.get(Number(id))
    if (!a) return { ok: false, status: 404, error: `没有审批 #${id}` }
    if (a.status !== 'pending') {
      return { ok: false, status: 409, state: a.status, approval: a, error: `审批 #${a.id} 已是「${STATUS_TEXT[a.status]}」，不能再改` }
    }
    settle(a, approve ? 'approved' : 'denied', reason)
    return { ok: true, state: a.status, approval: a }
  }

  const decidedText = a => `#${a.id} ${STATUS_TEXT[a.status]}（${a.name}：${a.toolLabel}）`

  // IM 里的 /y [编号]、/n [编号] [原因]，或「好」「不行，原因」；只有一条待批时可省略编号。
  function decideFromIm(isApprove, rest) {
    const m = rest.match(/^(\d+)?\s*([\s\S]*)$/)
    const pending = pendingApprovals()
    let id
    if (m[1]) {
      id = Number(m[1])
    } else if (pending.length === 1) {
      id = pending[0].id
    } else {
      return tell(pending.length === 0 ? '没有待批的请求' : `有 ${pending.length} 条待批，请点卡片上的按钮，或带编号：${pending.map(p => `#${p.id}`).join(' ')}`)
    }
    const r = decideApproval({ id, approve: isApprove, reason: (m[2] ?? '').trim() })
    tell(r.ok ? decidedText(r.approval) : r.error)
  }

  // 「好」「不行」「不行，先别发」这类口语答复。只在恰好一条待批时生效，否则返回 false 交给后续处理。
  function naturalDecision(text) {
    if (pendingApprovals().length !== 1) return false
    const trimmed = text.replace(/[。！!.~～\s]+$/u, '')
    const bare = trimmed.toLowerCase()
    if (APPROVE_WORDS.has(bare)) {
      decideFromIm(true, '')
      return true
    }
    for (const word of DENY_WORDS) {
      if (bare === word) {
        decideFromIm(false, '')
        return true
      }
      const withReason = trimmed.match(new RegExp(`^${word}[，,：:\\s]+([\\s\\S]+)$`, 'iu'))
      if (withReason) {
        decideFromIm(false, withReason[1].trim())
        return true
      }
    }
    return false
  }

  const onApprovalChange = listener => approvalListeners.push(listener)

  // ---- 提问（AskUserQuestion）----
  function settleQuestion(q, status) {
    q.status = status
    for (const listener of questionListeners) listener(q)
  }

  function pendingQuestions() {
    for (const q of questions.values()) {
      if (q.status === 'pending' && now() - q.createdAt > APPROVAL_TTL_MS) settleQuestion(q, 'expired')
    }
    return [...questions.values()].filter(q => q.status === 'pending')
  }

  // 一次提问最多 4 个问题；每个问题一张卡片，编号与卡片按钮一致。
  function askQuestions({ sessionId, questions: items }) {
    const s = sessions.get(sessionId)
    if (!s || !isOnline(s) || !s.forward) return { ok: true, forward: false }
    if (!Array.isArray(items) || items.length === 0) return { ok: false, status: 400, error: 'questions 不能为空' }
    const q = {
      id: ++questionSeq,
      sessionId,
      name: label(s),
      items: items.map(it => ({
        question: String(it.question ?? ''),
        header: String(it.header ?? ''),
        multiSelect: Boolean(it.multiSelect),
        options: (it.options ?? []).map(o => ({ label: String(o.label ?? ''), description: String(o.description ?? '') })),
      })),
      answers: {},
      status: 'pending',
      createdAt: now(),
    }
    questions.set(q.id, q)
    q.items.forEach((item, index) => {
      const card = { id: q.id, index, total: q.items.length, name: q.name, ...item }
      pushLog({ dir: 'out', from: q.name, text: questionText(card), question: card })
    })
    return { ok: true, forward: true, id: q.id }
  }

  function questionText(card) {
    const head = `提问 Q${card.id}${card.total > 1 ? `（${card.index + 1}/${card.total}）` : ''}${card.header ? `：${card.header}` : ''}`
    const options = card.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`)
    const how = card.multiSelect ? '回复编号，可多选，用空格分开（如 1 3）' : '点编号或回复编号'
    return [head, card.question, ...options, `${how}；也可回「答：其他内容」`].join('\n')
  }

  function getQuestion({ id }) {
    pendingQuestions()
    const q = questions.get(Number(id))
    if (!q) return { ok: false, status: 404, error: `没有提问 Q${id}` }
    return { ok: true, question: { id: q.id, state: q.status, answers: q.answers } }
  }

  function cancelQuestion({ id, why }) {
    const q = questions.get(Number(id))
    if (!q) return { ok: false, status: 404, error: `没有提问 Q${id}` }
    if (q.status === 'pending') {
      settleQuestion(q, 'cancelled')
      tell(`提问 Q${q.id} 已作废${why ? `：${why}` : ''}`)
    }
    return { ok: true }
  }

  // 回答第 index 个问题。choice 是选项编号数组（从 1 起），或 { text } 自填答案。
  function answerQuestion({ id, index, choice }) {
    pendingQuestions()
    const q = questions.get(Number(id))
    if (!q) return { ok: false, status: 404, error: `没有提问 Q${id}` }
    const item = q.items[index]
    if (!item) return { ok: false, status: 400, error: `提问 Q${id} 没有第 ${index + 1} 个问题` }
    if (q.status !== 'pending') return { ok: false, status: 409, question: q, error: `提问 Q${q.id} 已${q.status === 'answered' ? '回答' : '作废'}` }
    let answer
    if (Array.isArray(choice)) {
      if (choice.length === 0) return { ok: false, status: 400, error: '没有选任何选项' }
      if (!item.multiSelect && choice.length > 1) return { ok: false, status: 400, error: '这个问题只能选一个' }
      const bad = choice.find(n => !item.options[n - 1])
      if (bad !== undefined) return { ok: false, status: 400, error: `没有选项 ${bad}` }
      answer = [...new Set(choice)].map(n => item.options[n - 1].label).join(', ')
    } else {
      answer = String(choice?.text ?? '').trim()
      if (!answer) return { ok: false, status: 400, error: '答案为空' }
    }
    q.answers[item.question] = answer
    const remaining = q.items.filter(it => !(it.question in q.answers)).length
    if (remaining === 0) settleQuestion(q, 'answered')
    return { ok: true, question: q, index, answer, remaining }
  }

  // 只有一个提问在等时，文字回复可以直接作答：编号、选项原文，或「答：内容」。
  // 作答对象是它第一个还没回答的问题。
  function answerFromText(text) {
    const pending = pendingQuestions()
    if (pending.length !== 1) return false
    const q = pending[0]
    const index = q.items.findIndex(it => !(it.question in q.answers))
    const item = q.items[index]
    const free = text.match(/^答[：:]\s*([\s\S]+)$/)
    let choice
    if (free) choice = { text: free[1] }
    else if (/^\d+([\s,，、]+\d+)*$/.test(text)) choice = text.split(/[\s,，、]+/).map(Number)
    else {
      const n = item.options.findIndex(o => o.label.toLowerCase() === text.toLowerCase())
      if (n === -1) return false
      choice = [n + 1]
    }
    const r = answerQuestion({ id: q.id, index, choice })
    tell(r.ok ? answeredText(r) : r.error)
    return true
  }

  const answeredText = r =>
    `Q${r.question.id} 已回答：${r.answer}${r.remaining > 0 ? `（还有 ${r.remaining} 个问题）` : ''}`

  // 卡片按钮点选：回答并返回结果，供卡片更新。
  function pickQuestionOption({ id, index, option }) {
    const r = answerQuestion({ id, index, choice: [option] })
    if (r.ok) tell(answeredText(r))
    return r
  }

  const onQuestionChange = listener => questionListeners.push(listener)

  return {
    register,
    unregister,
    poll,
    reply,
    list,
    handleIncoming,
    since,
    onOutgoing,
    requestApproval,
    getApproval,
    cancelApproval,
    onApprovalChange,
    decideApproval,
    useSession,
    awaySession,
    suggestions,
    sendSuggestion,
    fileOut,
    tell,
    setForward,
    hookPermission,
    settleLocal,
    progress,
    askQuestions,
    getQuestion,
    cancelQuestion,
    answerQuestion,
    pickQuestionOption,
    onQuestionChange,
  }
}
