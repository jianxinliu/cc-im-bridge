import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { MiniWebSocket, OPCODE, acceptFor, createFrameParser, encodeFrame } from '../relay/ws-client.mjs'

const parseAll = buf => {
  const frames = []
  createFrameParser(f => frames.push(f))(buf)
  return frames
}

test('编解码往返：短、126 档、127 档长度，带掩码与不带掩码', () => {
  for (const size of [0, 5, 125, 126, 65535, 65536, 70000]) {
    const payload = Buffer.alloc(size, 0x61)
    for (const mask of [true, false]) {
      const [frame] = parseAll(encodeFrame(OPCODE.text, payload, { mask }))
      assert.equal(frame.opcode, OPCODE.text)
      assert.equal(frame.fin, true)
      assert.equal(frame.payload.length, size, `size=${size} mask=${mask}`)
      assert.ok(frame.payload.equals(payload))
    }
  }
})

test('客户端帧确实加了掩码：线上字节不等于明文', () => {
  const frame = encodeFrame(OPCODE.text, Buffer.from('hello'), { maskKey: Buffer.from([1, 2, 3, 4]) })
  assert.equal(frame[1] & 0x80, 0x80)
  assert.notEqual(frame.subarray(6).toString(), 'hello')
})

test('字节流被任意切开也能拼出完整帧', () => {
  const wire = Buffer.concat([
    encodeFrame(OPCODE.text, Buffer.from('第一条'), { mask: false }),
    encodeFrame(OPCODE.text, Buffer.alloc(300, 0x62), { mask: false }),
  ])
  const frames = []
  const push = createFrameParser(f => frames.push(f))
  for (const byte of wire) push(Buffer.from([byte]))
  assert.deepEqual(frames.map(f => f.payload.length), [9, 300])
  assert.equal(frames[0].payload.toString(), '第一条')
})

test('超大帧长度直接报错', () => {
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(1n << 40n, 2)
  assert.throws(() => createFrameParser(() => {})(header), /超过上限/)
})

// 假的 https.request：测试控制握手结果，并拿到假 socket 模拟服务端。
function fakeRequest(behave) {
  const sent = { headers: null, socket: null }
  const request = options => {
    sent.headers = options.headers
    const req = new EventEmitter()
    req.end = () => queueMicrotask(() => behave(req, options, sent))
    return req
  }
  return { request, sent }
}

function fakeSocket() {
  const socket = new EventEmitter()
  socket.written = []
  socket.write = buf => socket.written.push(...parseAll(buf))
  socket.end = () => socket.emit('close')
  socket.destroy = () => socket.emit('close')
  socket.serverSends = (opcode, payload, fin = true) => {
    const frame = encodeFrame(opcode, Buffer.from(payload), { mask: false })
    if (!fin) frame[0] &= 0x7f
    socket.emit('data', frame)
  }
  return socket
}

function connected() {
  const socket = fakeSocket()
  const { request, sent } = fakeRequest((req, options) => {
    const key = options.headers['Sec-WebSocket-Key']
    req.emit('upgrade', { headers: { 'sec-websocket-accept': acceptFor(key) } }, socket, Buffer.alloc(0))
  })
  const ws = new MiniWebSocket('wss://example.test/path?a=1', { request })
  const events = []
  for (const type of ['open', 'message', 'error', 'close']) ws.addEventListener(type, ev => events.push({ type, ...ev }))
  return { ws, socket, sent, events, ready: new Promise(r => ws.addEventListener('open', r)) }
}

test('握手请求头名按大小写写成 Sec-WebSocket-Key 等（企微服务端区分大小写）', async () => {
  const { sent, ready } = connected()
  await ready
  assert.deepEqual(Object.keys(sent.headers), ['Connection', 'Upgrade', 'Sec-WebSocket-Version', 'Sec-WebSocket-Key'])
})

test('收发文本、分片拼接、ping 自动回 pong', async () => {
  const { ws, socket, events, ready } = connected()
  await ready
  ws.send('{"cmd":"ping"}')
  assert.equal(socket.written.at(-1).payload.toString(), '{"cmd":"ping"}')

  socket.serverSends(OPCODE.text, '你', false)
  socket.serverSends(OPCODE.continuation, '好')
  assert.deepEqual(events.filter(e => e.type === 'message').map(e => e.data), ['你好'])

  socket.serverSends(OPCODE.ping, 'hb')
  const pong = socket.written.at(-1)
  assert.equal(pong.opcode, OPCODE.pong)
  assert.equal(pong.payload.toString(), 'hb')
})

test('服务端发关闭帧：回关闭帧并触发 close，带服务端的关闭码', async () => {
  const { socket, events, ready } = connected()
  await ready
  const payload = Buffer.alloc(2)
  payload.writeUInt16BE(4000)
  socket.emit('data', encodeFrame(OPCODE.close, payload, { mask: false }))
  assert.equal(socket.written.at(-1).opcode, OPCODE.close)
  const closes = events.filter(e => e.type === 'close')
  assert.equal(closes.length, 1, 'close 只触发一次')
  assert.equal(closes[0].code, 4000)
})

test('握手被拒（HTTP 404）：error 带状态码，随后 close', async () => {
  const { request } = fakeRequest(req => {
    const res = new EventEmitter()
    res.statusCode = 404
    res.resume = () => {}
    req.emit('response', res)
  })
  const ws = new MiniWebSocket('wss://example.test/', { request })
  const events = []
  ws.addEventListener('error', e => events.push(`error ${e.message}`))
  ws.addEventListener('close', e => events.push(`close ${e.code}`))
  await new Promise(r => ws.addEventListener('close', r))
  assert.match(events[0], /握手被拒绝：HTTP 404/)
  assert.equal(events[1], 'close 1006')
})

test('Sec-WebSocket-Accept 不匹配时拒绝连接', async () => {
  const socket = fakeSocket()
  const { request } = fakeRequest(req => req.emit('upgrade', { headers: { 'sec-websocket-accept': 'bad' } }, socket, Buffer.alloc(0)))
  const ws = new MiniWebSocket('wss://example.test/', { request })
  const errors = []
  ws.addEventListener('error', e => errors.push(e.message))
  await new Promise(r => ws.addEventListener('close', r))
  assert.match(errors[0], /Sec-WebSocket-Accept 不匹配/)
})

test('只接受 wss://', () => {
  assert.throws(() => new MiniWebSocket('ws://example.test/'), /只支持 wss/)
})
