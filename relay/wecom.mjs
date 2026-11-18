// 企业微信智能机器人长连接适配器。
// 协议依据：官方 SDK @wecom/aibot-node-sdk 1.0.7 的实现（帧格式、心跳 30 秒、回执超时 5 秒、
// 新连接建立后服务端向旧连接发 disconnected_event 并断开）。用 Node 自带的 WebSocket，不引第三方依赖。

export const WECOM_WS_URL = 'wss://openws.work.weixin.qq.com'
const HEARTBEAT_MS = 30_000
const MAX_MISSED_PONGS = 2
const ACK_TIMEOUT_MS = 5_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const MAX_AUTH_FAILURES = 5
// 官方未写明 aibot_send_msg 的长度上限（被动回复是 20480 字节），按 cc-connect 的做法保守地切成 2000 字节一段。
export const CHUNK_BYTES = 2000
const DEDUP_SIZE = 500
const CARD_SUMMARY_CHARS = 600
const CARD_KEY = /^appr:(\d+):(y|n)$/

// 审批卡片：标题写会话名，按钮 key 带审批编号。task_id 每台机器人内不能重复，
// 中转重启后审批编号从 1 重新计，所以前面加一段启动时的随机串。
export function approvalCard({ id, name, tool, summary }, taskPrefix, state = 'pending') {
  const text = summary.length > CARD_SUMMARY_CHARS ? `${summary.slice(0, CARD_SUMMARY_CHARS)}…` : summary
  const status = { pending: '', approved: '已批准', denied: '已拒绝', cancelled: '已作废', expired: '已超时' }[state] ?? state
  const card = {
    card_type: 'button_interaction',
    source: { desc: 'cc-im-bridge' },
    main_title: { title: `${name} 请求批准`, desc: `#${id} · ${tool}${status ? ` · ${status}` : ''}` },
    sub_title_text: text || ' ',
    card_action: { type: 0 },
    task_id: `${taskPrefix}_${id}`,
  }
  card.button_list =
    state === 'pending'
      ? [
          { text: '批准', style: 1, key: `appr:${id}:y` },
          { text: '拒绝', style: 3, key: `appr:${id}:n` },
        ]
      : // 结果定了只留一个灰色按钮显示结论；再点会被忽略。
        [{ text: status, style: 2, key: `appr:${id}:done` }]
  return card
}

export function parseCardKey(key) {
  const m = CARD_KEY.exec(key ?? '')
  return m ? { id: Number(m[1]), approve: m[2] === 'y' } : null
}

const MAX_SESSION_BUTTONS = 6 // 企微按钮卡片最多 6 个按钮
const SESSION_KEY = /^use:(\d+)$/
const QUESTION_KEY = /^q:(\d+):(\d+):(\d+)$/

// 提问卡片：单选且选项不超过 6 个时，每个选项一个编号按钮；多选或选项多时用文字回复编号。
export function questionCard(card, taskPrefix, chosen) {
  const options = card.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`)
  const position = card.total > 1 ? ` · ${card.index + 1}/${card.total}` : ''
  const canClick = !card.multiSelect && card.options.length > 0 && card.options.length <= MAX_SESSION_BUTTONS
  const hint = chosen
    ? `已回答：${chosen}`
    : canClick
      ? '点编号作答；也可回「答：其他内容」'
      : `回复编号${card.multiSelect ? '，可多选，用空格分开（如 1 3）' : ''}；也可回「答：其他内容」`
  const result = {
    card_type: canClick ? 'button_interaction' : 'text_notice',
    source: { desc: 'cc-im-bridge' },
    main_title: { title: `${card.name} 提问`, desc: `Q${card.id}${position}${card.header ? ` · ${card.header}` : ''}` },
    sub_title_text: [card.question, ...options, hint].join('\n').slice(0, 1000),
    card_action: { type: 0 },
    task_id: `${taskPrefix}_q${card.id}_${card.index}`,
  }
  if (canClick) {
    result.button_list = chosen
      ? [{ text: '已回答', style: 2, key: `q:${card.id}:${card.index}:done` }]
      : card.options.map((_, i) => ({ text: String(i + 1), style: 2, key: `q:${card.id}:${card.index}:${i + 1}` }))
  }
  return result
}

// 会话列表卡片：每个会话一个按钮，当前会话标 ✓。
export function sessionsCard(rows, taskId) {
  const shown = rows.slice(0, MAX_SESSION_BUTTONS)
  const extra = rows.length - shown.length
  const current = rows.find(r => r.current)
  return {
    card_type: 'button_interaction',
    source: { desc: 'cc-im-bridge' },
    main_title: { title: '选择会话', desc: current ? `当前：${current.num}. ${current.name}` : '点编号，之后的消息发给它' },
    sub_title_text:
      rows.map(r => `${r.num}. ${r.name}${r.online ? '' : '（离线）'}`).join('\n') +
      (extra > 0 ? `\n还有 ${extra} 个，说「切到 名字」` : ''),
    card_action: { type: 0 },
    task_id: taskId,
    // 一行三个按钮时只显示得下三四个字符，名字会被截断；按钮只放编号，名字在上面的列表里。
    button_list: shown.map(r => ({
      text: `${r.current ? '✓ ' : ''}${r.num}`,
      style: r.current ? 1 : 2,
      key: `use:${r.num}`,
    })),
  }
}

export function splitByBytes(text, maxBytes = CHUNK_BYTES) {
  const encoder = new TextEncoder()
  const chunks = []
  let current = ''
  let size = 0
  for (const ch of text) {
    const n = encoder.encode(ch).length
    if (size + n > maxBytes && current) {
      chunks.push(current)
      current = ''
      size = 0
    }
    current += ch
    size += n
  }
  if (current) chunks.push(current)
  return chunks
}

// 从 aibot_msg_callback 的 body 里取出文字；群聊里去掉开头 @机器人 的部分。
// 只返回文字，图片、文件等返回 null。
export function extractText(body) {
  let text = null
  if (body?.msgtype === 'text') text = body.text?.content ?? ''
  else if (body?.msgtype === 'voice') text = body.voice?.content || body.voice?.text || ''
  else if (body?.msgtype === 'mixed') {
    const parts = (body.mixed?.msg_item ?? []).filter(i => i.msgtype === 'text').map(i => i.text?.content ?? '')
    text = parts.length ? parts.join('\n') : null
  }
  if (text === null) return null
  text = text.trim()
  if (body.chattype === 'group') text = text.replace(/^@\S+\s*/, '')
  return text
}

export function createWecomAdapter({
  botId,
  secret,
  allowUsers = [],
  onText,
  // 用户点了审批卡片的按钮：({ id, approve }) => 当前审批对象（含 status），用于把卡片更新成结论。
  onCardAction = () => null,
  // 用户点了会话卡片的按钮：(num) => 最新的会话列表（含 current），用于重画卡片；切换失败返回 null。
  onUseSession = () => null,
  // 用户点了提问卡片的选项：({ id, index, option }) => { ok, answer }。
  onQuestionPick = () => ({ ok: false }),
  onChatId = () => {},
  initialChatId = '',
  log = console,
  url = WECOM_WS_URL,
  WebSocketImpl = globalThis.WebSocket,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
}) {
  if (!botId || !secret) throw new Error('企微配置缺少 botId 或 secret')
  const allowed = new Set(allowUsers)
  const seen = []
  const pendingAcks = new Map() // req_id -> { resolve, reject, timer }
  let ws = null
  let seq = 0
  let heartbeat = null
  let missedPongs = 0
  let reconnectTimer = null
  let reconnectAttempts = 0
  let authFailures = 0
  let isStopped = false
  let isAuthenticated = false
  let chatId = initialChatId
  let sendChain = Promise.resolve()
  const taskPrefix = `ccim_${Math.random().toString(36).slice(2, 10)}`
  const cards = new Map() // 审批编号 -> 发出时的卡片内容，用于点按钮后更新
  const questionCards = new Map() // `${id}:${index}` -> 发出时的提问卡片内容
  let sessionCardSeq = 0

  const reqId = prefix => `${prefix}_${Date.now()}_${++seq}`
  const write = frame => ws.send(JSON.stringify(frame))

  function stopHeartbeat() {
    if (heartbeat) timers.clearInterval(heartbeat)
    heartbeat = null
  }

  function failPending(reason) {
    for (const [id, p] of pendingAcks) {
      timers.clearTimeout(p.timer)
      p.reject(new Error(`${reason}（req_id=${id}）`))
    }
    pendingAcks.clear()
  }

  function scheduleReconnect() {
    if (isStopped || reconnectTimer) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS)
    reconnectAttempts++
    log.warn(`企微：${delay / 1000} 秒后重连（第 ${reconnectAttempts} 次）`)
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function handleCallback(frame) {
    const body = frame.body ?? {}
    if (body.msgid) {
      if (seen.includes(body.msgid)) return
      seen.push(body.msgid)
      if (seen.length > DEDUP_SIZE) seen.shift()
    }
    const userId = body.from?.userid ?? ''
    const replyTo = body.chatid || userId
    if (!allowed.has(userId)) {
      log.warn(`企微：拒绝白名单外用户 ${userId} 的消息`)
      sendTo(replyTo, `你的 userid 是 ${userId}，不在白名单里。管理员把它加进 ~/.cc-im-bridge/wecom.json 的 allowUsers 并重启中转后才能使用。`).catch(
        err => log.error(`企微：回复白名单外用户失败：${err.message}`),
      )
      return
    }
    const text = extractText(body)
    if (replyTo && replyTo !== chatId) {
      chatId = replyTo
      onChatId(chatId)
    }
    if (text === null) {
      send(`暂只支持文字消息，收到的是 ${body.msgtype}`).catch(err => log.error(`企微：${err.message}`))
      return
    }
    if (text) onText(text, { userId, chatId: replyTo })
  }

  // 点审批卡片的按钮。要在 5 秒内用事件的 req_id 回 update_template_card，卡片才会变成结论。
  function handleCardEvent(frame) {
    const body = frame.body ?? {}
    if (body.msgid) {
      if (seen.includes(body.msgid)) return
      seen.push(body.msgid)
      if (seen.length > DEDUP_SIZE) seen.shift()
    }
    const userId = body.from?.userid ?? ''
    if (!allowed.has(userId)) {
      log.warn(`企微：忽略白名单外用户 ${userId} 的卡片点击`)
      return
    }
    // 实测（2026-11-17）按钮 key 在 event.template_card_event 里；官方 SDK 类型写在 event 下，两处都认。
    const detail = body.event?.template_card_event ?? {}
    const eventKey = detail.event_key ?? body.event?.event_key
    // 结论定了之后卡片上只剩一个灰色按钮，点它不做任何事。
    if (/^appr:\d+:done$/.test(eventKey ?? '')) return
    const taskId = detail.task_id ?? body.event?.task_id
    const useMatch = SESSION_KEY.exec(eventKey ?? '')
    if (useMatch) return handleSessionPick(frame, Number(useMatch[1]), taskId)
    if (/^q:\d+:\d+:done$/.test(eventKey ?? '')) return
    const qMatch = QUESTION_KEY.exec(eventKey ?? '')
    if (qMatch) return handleQuestionPick(frame, Number(qMatch[1]), Number(qMatch[2]), Number(qMatch[3]), taskId)
    const action = parseCardKey(eventKey)
    if (!action) {
      log.warn(`企微：卡片点击无法识别 event_key=${JSON.stringify(eventKey)} 内层字段=${Object.keys(detail).join(',')}`)
      return
    }
    // 审批编号每次启动中转都从 1 重新计，旧卡片的按钮 key 会和新审批撞上；
    // 只认本次启动发出的卡片（task_id 带本次的随机前缀）。
    if (taskId !== `${taskPrefix}_${action.id}`) {
      log.warn(`企微：忽略过期卡片的点击 task_id=${JSON.stringify(taskId)} key=${eventKey}`)
      send('这张卡片已过期（中转重启过），不会生效，请用最新的卡片').catch(err => log.warn(`企微：${err.message}`))
      return
    }
    log.log(`企微：卡片点击 #${action.id} ${action.approve ? '批准' : '拒绝'}`)
    const approval = onCardAction(action)
    const sent = approval && cards.get(action.id)
    if (!sent) return
    const card = approvalCard(sent, taskPrefix, approval.status)
    writeAndWait('aibot_respond_update_msg', frame.headers?.req_id, {
      response_type: 'update_template_card',
      template_card: card,
    }).catch(err => {
      log.warn(`企微：更新审批卡片 #${action.id} 失败：${err.message}`)
      // 卡片没能变样时，用一条文字告诉结论，免得用户以为没点上。
      send(card.main_title.desc).catch(e => log.warn(`企微：补发审批结论失败：${e.message}`))
    })
  }

  // 点会话卡片的按钮：切到该会话，并把卡片重画成新的当前会话。
  // 编号在会话登记期间不变，但中转重启后会重排，所以同样只认本次启动发出的卡片。
  function handleSessionPick(frame, num, taskId) {
    if (!String(taskId ?? '').startsWith(`${taskPrefix}_s`)) {
      log.warn(`企微：忽略过期会话卡片的点击 task_id=${JSON.stringify(taskId)}`)
      send('这张会话卡片已过期（中转重启过），请重新发「会话」').catch(err => log.warn(`企微：${err.message}`))
      return
    }
    const rows = onUseSession(num)
    if (!rows) {
      send(`会话 ${num} 已不存在，请重新发「会话」`).catch(err => log.warn(`企微：${err.message}`))
      return
    }
    writeAndWait('aibot_respond_update_msg', frame.headers?.req_id, {
      response_type: 'update_template_card',
      template_card: sessionsCard(rows, taskId),
    }).catch(err => {
      log.warn(`企微：更新会话卡片失败：${err.message}`)
      const current = rows.find(r => r.current)
      send(`之后的消息发给 ${current?.name ?? num}`).catch(e => log.warn(`企微：${e.message}`))
    })
  }

  function handleQuestionPick(frame, id, index, option, taskId) {
    const sent = questionCards.get(`${id}:${index}`)
    // 只认本次启动发出的卡片：中转重启后提问编号会重新从 1 计。
    if (!sent || taskId !== `${taskPrefix}_q${id}_${index}`) {
      log.warn(`企微：忽略过期提问卡片的点击 task_id=${JSON.stringify(taskId)}`)
      send('这张提问卡片已过期（中转重启过），不会生效').catch(err => log.warn(`企微：${err.message}`))
      return
    }
    const r = onQuestionPick({ id, index, option })
    if (!r.ok) {
      send(r.error ?? `Q${id} 作答失败`).catch(err => log.warn(`企微：${err.message}`))
      return
    }
    writeAndWait('aibot_respond_update_msg', frame.headers?.req_id, {
      response_type: 'update_template_card',
      template_card: questionCard(sent, taskPrefix, r.answer),
    }).catch(err => log.warn(`企微：更新提问卡片 Q${id} 失败：${err.message}`))
  }

  function handleFrame(frame) {
    if (frame.cmd === 'aibot_msg_callback') return handleCallback(frame)
    if (frame.cmd === 'aibot_event_callback') {
      const event = frame.body?.event ?? {}
      // 只记事件类型与字段名，便于排查企微推送的形状；不记内容。
      log.log(`企微：收到事件 ${event.eventtype ?? '(无类型)'} 字段=${Object.keys(event).join(',')} body字段=${Object.keys(frame.body ?? {}).join(',')}`)
      if (event.eventtype === 'template_card_event') return handleCardEvent(frame)
      if (frame.body?.event?.eventtype === 'disconnected_event') {
        // 同一机器人建立了新连接，服务端会断开本连接；重连只会互相踢，所以停下等人处理。
        log.error('企微：同一机器人在别处建立了新连接，本中转已断开且不再重连。确认只有一个中转在用这个机器人后重启中转。')
        isStopped = true
        stopHeartbeat()
        failPending('企微连接被新连接取代')
        ws?.close()
      }
      return
    }
    const id = frame.headers?.req_id ?? ''
    if (id.startsWith('aibot_subscribe')) {
      if (frame.errcode !== 0) {
        authFailures++
        log.error(`企微：认证失败 errcode=${frame.errcode} errmsg=${frame.errmsg}（第 ${authFailures} 次）`)
        if (authFailures >= MAX_AUTH_FAILURES) {
          log.error(`企微：连续 ${MAX_AUTH_FAILURES} 次认证失败，停止重连。检查 wecom.json 里的 botId 和 secret。`)
          isStopped = true
        }
        ws?.close()
        return
      }
      isAuthenticated = true
      authFailures = 0
      reconnectAttempts = 0
      missedPongs = 0
      log.log('企微：已连接')
      stopHeartbeat()
      heartbeat = timers.setInterval(() => {
        if (missedPongs >= MAX_MISSED_PONGS) {
          log.warn(`企微：连续 ${missedPongs} 次心跳无回应，断开重连`)
          ws?.close()
          return
        }
        missedPongs++
        write({ cmd: 'ping', headers: { req_id: reqId('ping') } })
      }, HEARTBEAT_MS)
      return
    }
    if (id.startsWith('ping')) {
      missedPongs = 0
      return
    }
    const pending = pendingAcks.get(id)
    if (pending) {
      pendingAcks.delete(id)
      timers.clearTimeout(pending.timer)
      if (frame.errcode && frame.errcode !== 0) {
        pending.reject(new Error(`企微拒绝发送 errcode=${frame.errcode} errmsg=${frame.errmsg}`))
      } else pending.resolve()
    }
  }

  function connect() {
    if (isStopped) return
    isAuthenticated = false
    const socket = new WebSocketImpl(url)
    ws = socket
    socket.addEventListener('open', () => {
      write({ cmd: 'aibot_subscribe', headers: { req_id: reqId('aibot_subscribe') }, body: { bot_id: botId, secret } })
    })
    socket.addEventListener('message', ev => {
      let frame
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch (err) {
        log.warn(`企微：收到无法解析的帧：${err.message}`)
        return
      }
      handleFrame(frame)
    })
    socket.addEventListener('error', ev => log.warn(`企微：连接出错：${ev.message ?? ev.type}`))
    socket.addEventListener('close', () => {
      if (ws !== socket) return
      ws = null
      isAuthenticated = false
      stopHeartbeat()
      failPending('企微连接已断开')
      scheduleReconnect()
    })
  }

  // 发一帧并等回执。主动发消息用新 req_id；回应事件（更新卡片）要沿用事件的 req_id。
  function writeAndWait(cmd, id, body) {
    return new Promise((resolve, reject) => {
      if (!ws || !isAuthenticated) return reject(new Error('企微未连接，消息未发出'))
      if (!id) return reject(new Error(`${cmd} 缺 req_id`))
      const timer = timers.setTimeout(() => {
        pendingAcks.delete(id)
        reject(new Error(`企微 ${cmd} ${ACK_TIMEOUT_MS / 1000} 秒内无回执（req_id=${id}）`))
      }, ACK_TIMEOUT_MS)
      pendingAcks.set(id, { resolve, reject, timer })
      write({ cmd, headers: { req_id: id }, body })
    })
  }

  const sendChunk = (target, content) =>
    writeAndWait('aibot_send_msg', reqId('aibot_send_msg'), { chatid: target, msgtype: 'markdown', markdown: { content } })

  // 审批请求发成带「批准」「拒绝」按钮的卡片；卡片发不出去时退回文字。
  function sendApprovalCard(approval, fallbackText) {
    const run = sendChain.then(async () => {
      if (!chatId) throw new Error('还不知道发给谁：先在企微里给机器人发一条消息')
      cards.set(approval.id, approval)
      if (cards.size > DEDUP_SIZE) cards.delete(cards.keys().next().value)
      try {
        await writeAndWait('aibot_send_msg', reqId('aibot_send_msg'), {
          chatid: chatId,
          msgtype: 'template_card',
          template_card: approvalCard(approval, taskPrefix),
        })
      } catch (err) {
        log.warn(`企微：审批卡片 #${approval.id} 发送失败，改发文字：${err.message}`)
        for (const chunk of splitByBytes(fallbackText)) await sendChunk(chatId, chunk)
      }
    })
    sendChain = run.catch(() => {})
    return run
  }

  // 按顺序逐段发送并等回执；某段失败就放弃本条剩余部分。
  function sendTo(target, text) {
    const run = sendChain.then(async () => {
      if (!target) throw new Error('还不知道发给谁：先在企微里给机器人发一条消息')
      for (const chunk of splitByBytes(text)) await sendChunk(target, chunk)
    })
    sendChain = run.catch(() => {})
    return run
  }

  const send = text => sendTo(chatId, text)

  function sendQuestionCard(card, fallbackText) {
    const run = sendChain.then(async () => {
      if (!chatId) throw new Error('还不知道发给谁：先在企微里给机器人发一条消息')
      questionCards.set(`${card.id}:${card.index}`, card)
      if (questionCards.size > DEDUP_SIZE) questionCards.delete(questionCards.keys().next().value)
      try {
        await writeAndWait('aibot_send_msg', reqId('aibot_send_msg'), {
          chatid: chatId,
          msgtype: 'template_card',
          template_card: questionCard(card, taskPrefix),
        })
      } catch (err) {
        log.warn(`企微：提问卡片 Q${card.id} 发送失败，改发文字：${err.message}`)
        for (const chunk of splitByBytes(fallbackText)) await sendChunk(chatId, chunk)
      }
    })
    sendChain = run.catch(() => {})
    return run
  }

  function sendSessionsCard(rows, fallbackText) {
    const run = sendChain.then(async () => {
      if (!chatId) throw new Error('还不知道发给谁：先在企微里给机器人发一条消息')
      try {
        await writeAndWait('aibot_send_msg', reqId('aibot_send_msg'), {
          chatid: chatId,
          msgtype: 'template_card',
          template_card: sessionsCard(rows, `${taskPrefix}_s${++sessionCardSeq}`),
        })
      } catch (err) {
        log.warn(`企微：会话卡片发送失败，改发文字：${err.message}`)
        for (const chunk of splitByBytes(fallbackText)) await sendChunk(chatId, chunk)
      }
    })
    sendChain = run.catch(() => {})
    return run
  }

  function stop() {
    isStopped = true
    if (reconnectTimer) timers.clearTimeout(reconnectTimer)
    stopHeartbeat()
    failPending('中转已停止')
    ws?.close()
  }

  return {
    start: connect,
    stop,
    send,
    sendApprovalCard,
    sendSessionsCard,
    sendQuestionCard,
    get isConnected() {
      return isAuthenticated
    },
    get chatId() {
      return chatId
    },
  }
}

// 读 wecom.json。文件不存在返回 null（只用网页窗口）；权限过宽或字段不全时报错，不带出密钥内容。
export function loadWecomConfig(path, { readFile, stat }) {
  let st
  try {
    st = stat(path)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw new Error(`读取 ${path} 失败：${err.message}`)
  }
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`${path} 的权限是 ${(st.mode & 0o777).toString(8)}，含 secret，必须只有本人可读：chmod 600 ${path}`)
  }
  let config
  try {
    config = JSON.parse(readFile(path, 'utf8'))
  } catch (err) {
    throw new Error(`${path} 不是合法 JSON：${err.message}`)
  }
  const missing = ['botId', 'secret'].filter(k => typeof config[k] !== 'string' || !config[k])
  if (missing.length) throw new Error(`${path} 缺少字段：${missing.join('、')}`)
  if (!Array.isArray(config.allowUsers)) {
    throw new Error(`${path} 缺少 allowUsers（企微 userid 数组）；不知道自己的 userid 时先填 []，给机器人发条消息就会收到`)
  }
  return { botId: config.botId, secret: config.secret, allowUsers: config.allowUsers.map(String) }
}

// 发往企微的文字：中转自己的提示原样发，会话的回复前面标上会话名。
export function formatOutgoing({ from, text }) {
  return from === 'relay' ? text : `**[${from}]**\n${text}`
}
