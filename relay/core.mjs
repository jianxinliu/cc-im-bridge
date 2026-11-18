// 中转的路由逻辑：会话登记、按会话排队、解析 IM 侧的命令。不做任何 I/O，便于测试。

export const ONLINE_WINDOW_MS = 15_000
export const APPROVAL_TTL_MS = 15 * 60_000
const MAX_QUEUE = 50
const MAX_LOG = 500

export const STATUS_TEXT = { pending: '待批', approved: '已批准', denied: '已拒绝', cancelled: '已作废', expired: '已超时' }
// 只有一条待批时，单独回这些词当作批准或拒绝（去掉标点后整句精确匹配，避免把闲聊当成批准）。
// 批准词只收明确的肯定；拒绝方向放宽一些，误判也只是不执行。
const APPROVE_WORDS = new Set(['好', '好的', '好啊', '可以', '行', '批准', '同意', '确认', 'ok'])
const DENY_WORDS = ['不行', '不可以', '不要', '不用', '拒绝', '不同意', '先别', '别', '不', 'no', 'n']
const LIST_PHRASES = new Set(['/list', '/ls', '会话', '会话列表', '有哪些会话', '列一下会话', '列出会话', '看看会话'])
const USE_PATTERN = /^(?:\/use|切到|切换到|换到)\s*(.+)$/

// titleOf(sessionId)：会话在 Desktop 侧边栏上的标题（读不到返回 undefined），企微里优先用它显示和匹配。
export function createRelay({ now = () => Date.now(), titleOf = () => undefined } = {}) {
  const sessions = new Map() // sessionId -> { sessionId, name, cwd, lastSeen, queue: [] }
  const log = [] // 发往 IM 的消息与收到的 IM 消息，供 IM 适配器按序号拉取
  let seq = 0
  let target = null // 当前默认投递的 sessionId
  const outgoingListeners = [] // IM 适配器：每条发往 IM 的消息都通知它们
  const approvals = new Map() // id -> { id, sessionId, name, tool, summary, status, reason, createdAt }
  const approvalListeners = [] // 审批状态变化时通知等待者
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
      forward: existing?.forward ?? false,
    })
    return { ok: true, name }
  }

  function unregister({ sessionId }) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: false, status: 404, error: `未登记的会话 ${sessionId}` }
    sessions.delete(sessionId)
    if (target === sessionId) target = null
    return { ok: true }
  }

  // 会话取信，同时上报「需要批准时是否转到 IM」（IM 发起的回合或离开模式下为 true）。
  function poll({ sessionId, forward }) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: false, status: 404, error: `未登记的会话 ${sessionId}` }
    s.lastSeen = now()
    if (typeof forward === 'boolean') s.forward = forward
    const messages = s.queue.splice(0)
    return { ok: true, messages }
  }

  function reply({ sessionId, text }) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: false, status: 404, error: `未登记的会话 ${sessionId}` }
    if (!text?.trim()) return { ok: false, status: 400, error: 'text 为空' }
    s.lastSeen = now()
    pushLog({ dir: 'out', from: label(s), text })
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
    }))
  }

  function deliver(s, text) {
    if (s.queue.length >= MAX_QUEUE) {
      tell(`${label(s)} 的待投递消息已满 ${MAX_QUEUE} 条，本条未投递`)
      return
    }
    s.queue.push({ id: `m${seq + 1}`, text, ts: now() })
    target = s.sessionId
    tell(isOnline(s) ? `→ ${label(s)}` : `→ ${label(s)}（会话离线，已排队，上线后投递）`)
  }

  // IM 侧发来的一条消息：命令、@指定会话，或发给当前会话。
  function handleIncoming(raw) {
    const text = String(raw ?? '').trim()
    if (!text) return
    pushLog({ dir: 'in', from: 'me', text })

    if (LIST_PHRASES.has(text)) {
      const rows = list()
      if (rows.length === 0) return tell('没有已登记的会话')
      pushLog({
        dir: 'out',
        from: 'relay',
        text: rows.map(r => `${r.current ? '*' : ' '} ${r.num}. ${r.name}${r.online ? '' : '（离线）'}  ${r.cwd}`).join('\n'),
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

    if (naturalDecision(text)) return

    if (text === '/pending') {
      const pending = pendingApprovals()
      return tell(pending.length === 0 ? '没有待批的请求' : pending.map(a => `#${a.id} ${a.name}：${a.tool} ${a.summary.split('\n')[0]}`).join('\n'))
    }

    if (text === '/help') {
      return tell('发「会话」点选要聊的会话，或说「切到 名字」；「名字：内容」直接发给某个会话；其余内容发给当前会话。审批：点卡片按钮，或回「好」「不行，原因」；/pending 查看待批')
    }

    const at = text.match(/^@(\S+)\s+([\s\S]+)$/)
    if (at) {
      const { session: s, error } = resolve(at[1])
      if (!s) return tell(error)
      return deliver(s, at[2])
    }

    // 「api：跑一下测试」：冒号前是某个会话的完整名字或编号时，发给它；
    // 只认完整名字，避免「注意：xxx」这类普通句子被误当成会话名。
    const named = text.match(/^([^:：\n]{1,40}?)\s*[：:]\s*([\s\S]+)$/)
    if (named) {
      const key = named[1].trim().toLowerCase()
      const s = [...sessions.values()].find(x => namesOf(x).includes(key) || String(x.num) === key)
      if (s) return deliver(s, named[2])
    }

    let s = target ? sessions.get(target) : undefined
    if (!s) {
      const online = [...sessions.values()].filter(isOnline)
      if (online.length === 1) s = online[0]
    }
    if (!s) return tell('不确定发给哪个会话：发「会话」点选一个，或说「切到 名字」')
    deliver(s, text)
  }

  // 切换之后不带会话名的消息发给谁。ref 可以是编号、名字或唯一前缀。
  function useSession(ref) {
    const { session: s, error } = resolve(String(ref))
    if (!s) return { ok: false, error }
    target = s.sessionId
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

  function requestApproval({ sessionId, tool, summary }) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: false, status: 404, error: `未登记的会话 ${sessionId}` }
    if (!tool) return { ok: false, status: 400, error: 'tool 必填' }
    expireOld()
    const a = { id: ++approvalSeq, sessionId, name: label(s), tool, summary: summary ?? '', status: 'pending', reason: '', createdAt: now() }
    approvals.set(a.id, a)
    pushLog({
      dir: 'out',
      from: a.name,
      text: `请求批准 #${a.id}：${tool}\n${a.summary}\n回复「好」批准，「不行」拒绝`.replace(/\n\n/g, '\n'),
      // IM 适配器据此画成带按钮的卡片；网页窗口仍显示 text。
      approval: { id: a.id, name: a.name, tool, summary: a.summary },
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
  function hookPermission({ sessionId, tool, summary }) {
    const s = sessions.get(sessionId)
    if (!s || !isOnline(s) || !s.forward) return { ok: true, forward: false }
    return { ...requestApproval({ sessionId, tool, summary }), forward: true }
  }

  // 工具已经开始运行（说明已在电脑上批准）或回合已结束时，作废这个会话还挂着的审批。
  // 给了 tool 和 summary 时只作废对得上的那条，避免并行的其他审批被误伤。
  function settleLocal({ sessionId, tool, summary }) {
    let count = 0
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

  const decidedText = a => `#${a.id} ${STATUS_TEXT[a.status]}（${a.name}：${a.tool}）`

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
    tell,
    setForward,
    hookPermission,
    settleLocal,
  }
}
