// 中转的路由逻辑：会话登记、按会话排队、解析 IM 侧的命令。不做任何 I/O，便于测试。

export const ONLINE_WINDOW_MS = 15_000
const MAX_QUEUE = 50
const MAX_LOG = 500

export function createRelay({ now = () => Date.now() } = {}) {
  const sessions = new Map() // sessionId -> { sessionId, name, cwd, lastSeen, queue: [] }
  const log = [] // 发往 IM 的消息与收到的 IM 消息，供 IM 适配器按序号拉取
  let seq = 0
  let target = null // 当前默认投递的 sessionId

  const isOnline = s => now() - s.lastSeen <= ONLINE_WINDOW_MS
  const byName = name => [...sessions.values()].find(s => s.name === name)

  function pushLog(entry) {
    log.push({ seq: ++seq, ts: now(), ...entry })
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG)
  }
  const tell = text => pushLog({ dir: 'out', from: 'relay', text })

  function register({ sessionId, name, cwd, version }) {
    if (!sessionId || !name) return { ok: false, status: 400, error: 'sessionId 和 name 必填' }
    const holder = byName(name)
    if (holder && holder.sessionId !== sessionId && isOnline(holder)) {
      return { ok: false, status: 409, error: `名字 ${name} 已被在线会话占用` }
    }
    if (holder && holder.sessionId !== sessionId) sessions.delete(holder.sessionId)
    const existing = sessions.get(sessionId)
    sessions.set(sessionId, {
      sessionId,
      name,
      cwd: cwd ?? '',
      version: version ?? '',
      lastSeen: now(),
      queue: existing?.queue ?? [],
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

  // 会话取信，同时视为心跳。
  function poll({ sessionId }) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: false, status: 404, error: `未登记的会话 ${sessionId}` }
    s.lastSeen = now()
    const messages = s.queue.splice(0)
    return { ok: true, messages }
  }

  function reply({ sessionId, text }) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: false, status: 404, error: `未登记的会话 ${sessionId}` }
    if (!text?.trim()) return { ok: false, status: 400, error: 'text 为空' }
    s.lastSeen = now()
    pushLog({ dir: 'out', from: s.name, text })
    return { ok: true }
  }

  function list() {
    return [...sessions.values()].map(s => ({
      name: s.name,
      cwd: s.cwd,
      version: s.version,
      online: isOnline(s),
      queued: s.queue.length,
      current: s.sessionId === target,
    }))
  }

  function deliver(s, text) {
    if (s.queue.length >= MAX_QUEUE) {
      tell(`${s.name} 的待投递消息已满 ${MAX_QUEUE} 条，本条未投递`)
      return
    }
    s.queue.push({ id: `m${seq + 1}`, text, ts: now() })
    target = s.sessionId
    tell(isOnline(s) ? `→ ${s.name}` : `→ ${s.name}（会话离线，已排队，上线后投递）`)
  }

  // IM 侧发来的一条消息：命令、@指定会话，或发给当前会话。
  function handleIncoming(raw) {
    const text = String(raw ?? '').trim()
    if (!text) return
    pushLog({ dir: 'in', from: 'me', text })

    if (text === '/list' || text === '/ls') {
      const rows = list()
      tell(
        rows.length === 0
          ? '没有已登记的会话'
          : rows
              .map(r => `${r.current ? '*' : ' '} ${r.name}${r.online ? '' : '（离线）'}  ${r.cwd}`)
              .join('\n'),
      )
      return
    }

    const use = text.match(/^\/use\s+(\S+)$/)
    if (use) {
      const s = byName(use[1])
      if (!s) return tell(`没有名为 ${use[1]} 的会话，发 /list 查看`)
      target = s.sessionId
      return tell(`之后的消息默认发给 ${s.name}`)
    }

    if (text === '/help') {
      return tell('/list 列出会话；/use <名字> 切换默认会话；@名字 内容 发给指定会话；其余内容发给默认会话')
    }

    const at = text.match(/^@(\S+)\s+([\s\S]+)$/)
    if (at) {
      const s = byName(at[1])
      if (!s) return tell(`没有名为 ${at[1]} 的会话，发 /list 查看`)
      return deliver(s, at[2])
    }

    let s = target ? sessions.get(target) : undefined
    if (!s) {
      const online = [...sessions.values()].filter(isOnline)
      if (online.length === 1) s = online[0]
    }
    if (!s) return tell('不确定发给哪个会话：先 /use <名字>，或用 @名字 开头。发 /list 查看')
    deliver(s, text)
  }

  const since = n => log.filter(e => e.seq > n)

  return { register, unregister, poll, reply, list, handleIncoming, since }
}
