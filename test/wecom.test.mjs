import assert from 'node:assert/strict'
import { test } from 'node:test'

import { approvalCard, createWecomAdapter, sessionsCard, extractText, formatOutgoing, loadWecomConfig, parseCardKey, splitByBytes } from '../relay/wecom.mjs'

// 假 WebSocket：记录发出的帧，测试用 serverSays 模拟服务端下发。
function fakeSocketFactory() {
  const sockets = []
  class FakeSocket {
    constructor(url) {
      this.url = url
      this.sent = []
      this.listeners = {}
      this.closed = false
      sockets.push(this)
    }
    addEventListener(type, fn) {
      ;(this.listeners[type] ??= []).push(fn)
    }
    emit(type, ev = {}) {
      for (const fn of this.listeners[type] ?? []) fn(ev)
    }
    send(data) {
      this.sent.push(JSON.parse(data))
    }
    close() {
      if (this.closed) return
      this.closed = true
      this.emit('close')
    }
    serverSays(frame) {
      this.emit('message', { data: JSON.stringify(frame) })
    }
    lastSent() {
      return this.sent.at(-1)
    }
  }
  return { FakeSocket, sockets }
}

// 手动推进的定时器。
function fakeTimers() {
  let now = 0
  let id = 0
  const tasks = new Map()
  const add = (fn, ms, every) => {
    tasks.set(++id, { fn, at: now + ms, every: every ? ms : 0 })
    return id
  }
  return {
    setTimeout: (fn, ms) => add(fn, ms, false),
    setInterval: (fn, ms) => add(fn, ms, true),
    clearTimeout: i => tasks.delete(i),
    clearInterval: i => tasks.delete(i),
    advance(ms) {
      const end = now + ms
      for (;;) {
        const due = [...tasks.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [key, task] = due
        now = task.at
        if (task.every) task.at += task.every
        else tasks.delete(key)
        task.fn()
      }
      now = end
    },
  }
}

const silentLog = () => {
  const lines = []
  const push = level => msg => lines.push(`${level} ${msg}`)
  return { lines, log: push('log'), warn: push('warn'), error: push('error') }
}

function setup(overrides = {}) {
  const { FakeSocket, sockets } = fakeSocketFactory()
  const timers = fakeTimers()
  const logger = silentLog()
  const received = []
  const chatIds = []
  const adapter = createWecomAdapter({
    botId: 'bot-1',
    secret: 's3cret',
    allowUsers: ['alice'],
    onText: (text, meta) => received.push({ text, ...meta }),
    onChatId: id => chatIds.push(id),
    log: logger,
    WebSocketImpl: FakeSocket,
    timers,
    ...overrides,
  })
  adapter.start()
  const socket = () => sockets.at(-1)
  const authOk = () => {
    socket().emit('open')
    const sub = socket().lastSent()
    socket().serverSays({ headers: { req_id: sub.headers.req_id }, errcode: 0, errmsg: 'ok' })
  }
  return { adapter, sockets, socket, timers, logger, received, chatIds, authOk }
}

const textFrame = (from, content, extra = {}) => ({
  cmd: 'aibot_msg_callback',
  headers: { req_id: `cb_${Math.random()}` },
  body: { msgid: `m_${Math.random()}`, chattype: 'single', from: { userid: from }, msgtype: 'text', text: { content }, ...extra },
})

test('连上后发送订阅帧，带 bot_id 和 secret', () => {
  const { socket } = setup()
  socket().emit('open')
  const sub = socket().lastSent()
  assert.equal(sub.cmd, 'aibot_subscribe')
  assert.deepEqual(sub.body, { bot_id: 'bot-1', secret: 's3cret' })
  assert.match(sub.headers.req_id, /^aibot_subscribe_/)
})

test('白名单用户的文字消息交给中转，并记住 chatid', () => {
  const { socket, authOk, received, chatIds, adapter } = setup()
  authOk()
  socket().serverSays(textFrame('alice', ' @api 跑测试 '))
  assert.deepEqual(received, [{ text: '@api 跑测试', userId: 'alice', chatId: 'alice' }])
  assert.deepEqual(chatIds, ['alice'])
  assert.equal(adapter.chatId, 'alice')
})

test('同一 msgid 重复推送只处理一次', () => {
  const { socket, authOk, received } = setup()
  authOk()
  const frame = textFrame('alice', 'hi')
  socket().serverSays(frame)
  socket().serverSays(frame)
  assert.equal(received.length, 1)
})

test('白名单外用户：不进会话，回告其 userid', async () => {
  const { socket, authOk, received } = setup()
  authOk()
  socket().serverSays(textFrame('mallory', 'rm -rf ~'))
  await new Promise(r => setImmediate(r))
  assert.equal(received.length, 0)
  const reply = socket().lastSent()
  assert.equal(reply.cmd, 'aibot_send_msg')
  assert.equal(reply.body.chatid, 'mallory')
  assert.match(reply.body.markdown.content, /你的 userid 是 mallory/)
})

test('非文字消息回告暂不支持', async () => {
  const { socket, authOk, received } = setup()
  authOk()
  socket().serverSays(textFrame('alice', '', { msgtype: 'image', image: { url: 'x' } }))
  await new Promise(r => setImmediate(r))
  assert.equal(received.length, 0)
  assert.match(socket().lastSent().body.markdown.content, /暂只支持文字消息/)
})

test('发送：按 chatid 发 markdown，等回执后才发下一段', async () => {
  const { socket, authOk, adapter } = setup()
  authOk()
  socket().serverSays(textFrame('alice', 'hi'))
  const long = 'a'.repeat(2500)
  const done = adapter.send(long)
  await Promise.resolve()
  await Promise.resolve()
  const first = socket().lastSent()
  assert.equal(first.cmd, 'aibot_send_msg')
  assert.equal(first.body.chatid, 'alice')
  assert.equal(first.body.markdown.content.length, 2000)
  const countBefore = socket().sent.length
  socket().serverSays({ headers: { req_id: first.headers.req_id }, errcode: 0 })
  await new Promise(r => setImmediate(r))
  const second = socket().lastSent()
  assert.equal(socket().sent.length, countBefore + 1)
  assert.equal(second.body.markdown.content.length, 500)
  socket().serverSays({ headers: { req_id: second.headers.req_id }, errcode: 0 })
  await done
})

test('发送：企微返回错误码时报错，含错误码', async () => {
  const { socket, authOk, adapter } = setup()
  authOk()
  socket().serverSays(textFrame('alice', 'hi'))
  const done = adapter.send('x')
  await new Promise(r => setImmediate(r))
  socket().serverSays({ headers: { req_id: socket().lastSent().headers.req_id }, errcode: 45009, errmsg: 'freq limit' })
  await assert.rejects(done, /errcode=45009/)
})

test('发送：5 秒无回执超时报错；还不知道 chatid 时直接报错', async () => {
  const { socket, authOk, adapter, timers } = setup()
  authOk()
  await assert.rejects(adapter.send('x'), /先在企微里给机器人发一条消息/)
  socket().serverSays(textFrame('alice', 'hi'))
  const done = adapter.send('x')
  await new Promise(r => setImmediate(r))
  timers.advance(5000)
  await assert.rejects(done, /5 秒内无回执/)
})

test('心跳：每 30 秒 ping；连续两次没回应就断开重连', () => {
  const { socket, sockets, authOk, timers } = setup()
  authOk()
  timers.advance(30_000)
  assert.equal(socket().lastSent().cmd, 'ping')
  timers.advance(30_000)
  timers.advance(30_000) // 第三个周期发现已漏两次回应
  assert.equal(sockets[0].closed, true)
  timers.advance(1_000)
  assert.equal(sockets.length, 2, '1 秒后重连')
})

test('心跳有回应时不断开', () => {
  const { socket, authOk, timers } = setup()
  authOk()
  for (let i = 0; i < 5; i++) {
    timers.advance(30_000)
    socket().serverSays({ headers: { req_id: socket().lastSent().headers.req_id }, errcode: 0 })
  }
  assert.equal(socket().closed, false)
})

test('断线后指数退避重连，最长 30 秒', () => {
  const { sockets, timers, logger } = setup()
  const delays = [1, 2, 4, 8, 16, 30, 30]
  for (const d of delays) {
    sockets.at(-1).close()
    const before = sockets.length
    timers.advance(d * 1000 - 1)
    assert.equal(sockets.length, before, `${d} 秒前不重连`)
    timers.advance(1)
    assert.equal(sockets.length, before + 1, `${d} 秒时重连`)
  }
  assert.ok(logger.lines.some(l => l.includes('30 秒后重连')))
})

test('认证失败连续 5 次后停止重连并报错', () => {
  const { sockets, timers, logger } = setup()
  for (let i = 0; i < 5; i++) {
    const s = sockets.at(-1)
    s.emit('open')
    s.serverSays({ headers: { req_id: s.lastSent().headers.req_id }, errcode: 40001, errmsg: 'invalid secret' })
    timers.advance(60_000)
  }
  const count = sockets.length
  timers.advance(600_000)
  assert.equal(sockets.length, count)
  assert.ok(logger.lines.some(l => l.startsWith('error') && l.includes('停止重连')))
  assert.ok(!logger.lines.some(l => l.includes('s3cret')), '日志不含 secret')
})

test('收到 disconnected_event 后不再重连', () => {
  const { socket, sockets, authOk, timers, logger } = setup()
  authOk()
  socket().serverSays({ cmd: 'aibot_event_callback', headers: { req_id: 'e1' }, body: { event: { eventtype: 'disconnected_event' } } })
  timers.advance(600_000)
  assert.equal(sockets.length, 1)
  assert.ok(logger.lines.some(l => l.includes('不再重连')))
})

test('extractText：群聊去掉开头 @机器人；语音取转写文字；图片返回 null', () => {
  assert.equal(extractText({ msgtype: 'text', chattype: 'group', text: { content: '@助手 @api 跑测试' } }), '@api 跑测试')
  assert.equal(extractText({ msgtype: 'text', chattype: 'single', text: { content: '@api 跑测试' } }), '@api 跑测试')
  assert.equal(extractText({ msgtype: 'voice', voice: { content: '你好' } }), '你好')
  assert.equal(extractText({ msgtype: 'image' }), null)
  assert.equal(
    extractText({ msgtype: 'mixed', mixed: { msg_item: [{ msgtype: 'text', text: { content: 'a' } }, { msgtype: 'image' }] } }),
    'a',
  )
})

test('splitByBytes 按 UTF-8 字节切分，不切断字符', () => {
  const parts = splitByBytes('中'.repeat(1000), 2000)
  assert.deepEqual(parts.map(p => p.length), [666, 334])
  assert.equal(parts.join(''), '中'.repeat(1000))
  assert.deepEqual(splitByBytes(''), [])
})

test('formatOutgoing：会话回复标会话名，中转提示原样', () => {
  assert.equal(formatOutgoing({ from: 'api', text: '完成' }), '**[api]**\n完成')
  assert.equal(formatOutgoing({ from: 'relay', text: '→ api' }), '→ api')
})

test('loadWecomConfig：缺文件返回 null；权限过宽、字段缺失时报错且不带出 secret', () => {
  const enoent = Object.assign(new Error('no'), { code: 'ENOENT' })
  const deps = (mode, content) => ({ stat: () => ({ mode }), readFile: () => content })
  assert.equal(loadWecomConfig('/x', { stat: () => { throw enoent }, readFile: () => '' }), null)
  assert.throws(() => loadWecomConfig('/x', deps(0o100644, '{}')), /权限是 644/)
  assert.throws(() => loadWecomConfig('/x', deps(0o100600, '{"botId":"b"}')), /缺少字段：secret/)
  assert.throws(() => loadWecomConfig('/x', deps(0o100600, '{"botId":"b","secret":"zz-secret"}')), err => {
    assert.match(err.message, /缺少 allowUsers/)
    assert.doesNotMatch(err.message, /zz-secret/)
    return true
  })
  assert.deepEqual(loadWecomConfig('/x', deps(0o100600, '{"botId":"b","secret":"s","allowUsers":["u1"]}')), {
    botId: 'b',
    secret: 's',
    allowUsers: ['u1'],
  })
})

const ackLast = s => s.serverSays({ headers: { req_id: s.lastSent().headers.req_id }, errcode: 0 })
const tick = () => new Promise(r => setImmediate(r))
const approval = { id: 3, name: 'api', tool: 'Bash', summary: 'npm publish' }
// 按企微实测的形状：按钮 key 与 task_id 在 event.template_card_event 里。
const cardEvent = (from, key, extra = {}, taskId = 't') => ({
  cmd: 'aibot_event_callback',
  headers: { req_id: `evt_${Math.random()}` },
  body: {
    msgid: `e_${Math.random()}`,
    from: { userid: from },
    msgtype: 'event',
    event: { eventtype: 'template_card_event', template_card_event: { card_type: 'button_interaction', event_key: key, task_id: taskId } },
    ...extra,
  },
})

test('审批卡片：带批准/拒绝按钮，标题写会话名与编号', () => {
  const card = approvalCard(approval, 'ccim_x')
  assert.equal(card.card_type, 'button_interaction')
  assert.deepEqual(card.main_title, { title: 'api 请求批准', desc: '#3 · Bash' })
  assert.equal(card.sub_title_text, 'npm publish')
  assert.deepEqual(card.button_list.map(b => [b.text, b.key]), [['批准', 'appr:3:y'], ['拒绝', 'appr:3:n']])
  assert.equal(card.task_id, 'ccim_x_3')
  assert.match(card.task_id, /^[\w\-@]{1,128}$/)

  const done = approvalCard(approval, 'ccim_x', 'denied')
  assert.equal(done.main_title.desc, '#3 · Bash · 已拒绝')
  assert.deepEqual(done.button_list.map(b => [b.text, b.key]), [['已拒绝', 'appr:3:done']])
  assert.equal(done.task_id, card.task_id, '更新时 task_id 不变')

  assert.equal(approvalCard({ ...approval, summary: 'x'.repeat(500) }, 'p').sub_title_text.length, 401)
})

test('parseCardKey 只认审批按钮', () => {
  assert.deepEqual(parseCardKey('appr:12:y'), { id: 12, approve: true })
  assert.deepEqual(parseCardKey('appr:12:n'), { id: 12, approve: false })
  for (const k of ['appr:12:done', 'appr:x:y', 'other', undefined]) assert.equal(parseCardKey(k), null)
})

test('发审批卡片：按 chatid 发 template_card', async () => {
  const { socket, authOk, adapter } = setup()
  authOk()
  socket().serverSays(textFrame('alice', 'hi'))
  const done = adapter.sendApprovalCard(approval, '文字备用')
  await tick()
  const frame = socket().lastSent()
  assert.equal(frame.cmd, 'aibot_send_msg')
  assert.equal(frame.body.chatid, 'alice')
  assert.equal(frame.body.msgtype, 'template_card')
  assert.equal(frame.body.template_card.button_list[0].key, 'appr:3:y')
  ackLast(socket())
  await done
})

test('卡片发不出去时退回文字', async () => {
  const { socket, authOk, adapter } = setup()
  authOk()
  socket().serverSays(textFrame('alice', 'hi'))
  const done = adapter.sendApprovalCard(approval, '请求批准 #3 文字版')
  await tick()
  socket().serverSays({ headers: { req_id: socket().lastSent().headers.req_id }, errcode: 40058, errmsg: 'bad card' })
  await tick()
  const fallback = socket().lastSent()
  assert.equal(fallback.body.msgtype, 'markdown')
  assert.equal(fallback.body.markdown.content, '请求批准 #3 文字版')
  ackLast(socket())
  await done
})

test('点批准按钮：交给中转决定，并用事件的 req_id 把卡片更新成结论', async () => {
  const actions = []
  const { socket, authOk, adapter } = setup({
    onCardAction: a => {
      actions.push(a)
      return { ...approval, status: a.approve ? 'approved' : 'denied' }
    },
  })
  authOk()
  socket().serverSays(textFrame('alice', 'hi'))
  const sending = adapter.sendApprovalCard(approval, 'x')
  await tick()
  ackLast(socket())
  await sending

  const taskId = socket().sent.find(f => f.body?.msgtype === 'template_card').body.template_card.task_id
  const evt = cardEvent('alice', 'appr:3:y', {}, taskId)
  socket().serverSays(evt)
  assert.deepEqual(actions, [{ id: 3, approve: true }])
  const update = socket().lastSent()
  assert.equal(update.cmd, 'aibot_respond_update_msg')
  assert.equal(update.headers.req_id, evt.headers.req_id)
  assert.equal(update.body.response_type, 'update_template_card')
  assert.equal(update.body.template_card.main_title.desc, '#3 · Bash · 已批准')
  assert.equal(update.body.template_card.task_id.endsWith('_3'), true)

  socket().serverSays(evt)
  assert.equal(actions.length, 1, '同一事件重复推送只处理一次')
})

test('卡片点击：白名单外用户、非审批按钮、「已批准」灰按钮都忽略', async () => {
  const actions = []
  const { socket, authOk } = setup({ onCardAction: a => (actions.push(a), null) })
  authOk()
  const before = socket().sent.length
  socket().serverSays(cardEvent('mallory', 'appr:3:y'))
  socket().serverSays(cardEvent('alice', 'appr:3:done'))
  socket().serverSays(cardEvent('alice', 'something'))
  assert.equal(actions.length, 0)
  assert.equal(socket().sent.length, before)
})

test('卡片更新失败时补发一条文字结论', async () => {
  const { socket, authOk, adapter } = setup({ onCardAction: () => ({ ...approval, status: 'approved' }) })
  authOk()
  socket().serverSays(textFrame('alice', 'hi'))
  const sending = adapter.sendApprovalCard(approval, 'x')
  await tick()
  ackLast(socket())
  await sending
  const taskId = socket().sent.find(f => f.body?.msgtype === 'template_card').body.template_card.task_id
  const evt = cardEvent('alice', 'appr:3:y', {}, taskId)
  socket().serverSays(evt)
  socket().serverSays({ headers: { req_id: evt.headers.req_id }, errcode: 60020, errmsg: 'expired' })
  await tick()
  await tick()
  assert.equal(socket().lastSent().body.markdown.content, '#3 · Bash · 已批准')
})

test('卡片点击：旧卡片（中转重启前发的，编号撞上）不生效，并提示已过期', async () => {
  const actions = []
  const { socket, authOk } = setup({ onCardAction: a => (actions.push(a), null) })
  authOk()
  socket().serverSays(textFrame('alice', 'hi'))
  socket().serverSays({
    cmd: 'aibot_event_callback',
    headers: { req_id: 'evt_nested' },
    body: {
      msgid: 'nested1',
      from: { userid: 'alice' },
      msgtype: 'event',
      event: { eventtype: 'template_card_event', template_card_event: { card_type: 'button_interaction', event_key: 'appr:5:n', task_id: 'ccim_x_5' } },
    },
  })
  assert.deepEqual(actions, [], 'task_id 不是本次启动发的卡片，不认')
  await tick()
  assert.match(socket().lastSent()?.body?.markdown?.content ?? '', /卡片已过期/)
})

test('卡片点击：旧版 SDK 写法（key 直接在 event 下）也能识别', async () => {
  const actions = []
  const { socket, authOk, adapter } = setup({ onCardAction: a => (actions.push(a), null) })
  authOk()
  socket().serverSays(textFrame('alice', 'hi'))
  const sending = adapter.sendApprovalCard(approval, 'x')
  await tick()
  const taskId = socket().lastSent().body.template_card.task_id
  ackLast(socket())
  await sending
  socket().serverSays({
    cmd: 'aibot_event_callback',
    headers: { req_id: 'evt_flat' },
    body: { msgid: 'flat1', from: { userid: 'alice' }, msgtype: 'event', event: { eventtype: 'template_card_event', event_key: 'appr:3:n', task_id: taskId } },
  })
  assert.deepEqual(actions, [{ id: 3, approve: false }])
})

const rows = [
  { num: 1, name: 'api', cwd: '/w/api', online: true, current: false },
  { num: 2, name: 'web-frontend-long-name', cwd: '/w/web', online: false, current: true },
]

test('会话卡片：按钮只放编号（名字太长会被截断），当前会话标 ✓，最多 6 个', () => {
  const card = sessionsCard(rows, 'p_s1')
  assert.equal(card.card_type, 'button_interaction')
  assert.equal(card.main_title.desc, '当前：2. web-frontend-long-name')
  assert.equal(card.sub_title_text, '1. api\n2. web-frontend-long-name（离线）')
  assert.deepEqual(card.button_list.map(b => [b.text, b.key, b.style]), [['1', 'use:1', 2], ['✓ 2', 'use:2', 1]])
  const many = Array.from({ length: 8 }, (_, i) => ({ num: i + 1, name: `s${i + 1}`, cwd: '', online: true, current: false }))
  const big = sessionsCard(many, 'p_s2')
  assert.equal(big.button_list.length, 6)
  assert.match(big.sub_title_text, /还有 2 个，说「切到 名字」/)
})

test('点会话按钮：切换会话，并用事件 req_id 把卡片重画成新的当前会话', async () => {
  const picks = []
  const { socket, authOk, adapter } = setup({
    onUseSession: num => (picks.push(num), rows.map(r => ({ ...r, current: r.num === num }))),
  })
  authOk()
  socket().serverSays(textFrame('alice', 'hi'))
  const sending = adapter.sendSessionsCard(rows, 'x')
  await tick()
  const taskId = socket().lastSent().body.template_card.task_id
  ackLast(socket())
  await sending

  const evt = cardEvent('alice', 'use:1', {}, taskId)
  socket().serverSays(evt)
  assert.deepEqual(picks, [1])
  const update = socket().lastSent()
  assert.equal(update.cmd, 'aibot_respond_update_msg')
  assert.equal(update.headers.req_id, evt.headers.req_id)
  assert.equal(update.body.template_card.main_title.desc, '当前：1. api')
  assert.equal(update.body.template_card.task_id, taskId)
})

test('点会话按钮：旧卡片不生效；会话已不存在时提示重新发「会话」', async () => {
  const picks = []
  const { socket, authOk } = setup({ onUseSession: num => (picks.push(num), null) })
  authOk()
  socket().serverSays(textFrame('alice', 'hi'))
  socket().serverSays(cardEvent('alice', 'use:1', {}, 'ccim_old_s1'))
  await tick()
  assert.deepEqual(picks, [])
  assert.match(socket().lastSent().body.markdown.content, /会话卡片已过期/)
  ackLast(socket())
})
