// 最小的 WebSocket 客户端（RFC 6455），只覆盖本项目所需：文本消息、分片、ping/pong、关闭。
// 不用 Node 自带的 WebSocket，是因为它的握手请求头名一律小写（sec-websocket-key），
// 而企微长连接服务端按大小写匹配，只认 Sec-WebSocket-Key，否则返回 404（2026-11-17 实测）。
import { createHash, randomBytes } from 'node:crypto'
import https from 'node:https'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024
const CLOSE_TIMEOUT_MS = 2000
export const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 }

export function acceptFor(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

// 客户端发出的帧必须加掩码（RFC 6455 5.3）。
export function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = true, maskKey = randomBytes(4) } = {}) {
  const len = payload.length
  const lenBytes = len < 126 ? 0 : len < 65536 ? 2 : 8
  const header = Buffer.alloc(2 + lenBytes + (mask ? 4 : 0))
  header[0] = 0x80 | opcode
  header[1] = (mask ? 0x80 : 0) | (lenBytes === 0 ? len : lenBytes === 2 ? 126 : 127)
  if (lenBytes === 2) header.writeUInt16BE(len, 2)
  if (lenBytes === 8) header.writeBigUInt64BE(BigInt(len), 2)
  if (!mask) return Buffer.concat([header, payload])
  maskKey.copy(header, 2 + lenBytes)
  const body = Buffer.alloc(len)
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ maskKey[i % 4]
  return Buffer.concat([header, body])
}

// 把字节流切成帧：每凑齐一帧调用 onFrame({ fin, opcode, payload })。
export function createFrameParser(onFrame) {
  let buffer = Buffer.alloc(0)
  return function push(chunk) {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const fin = (buffer[0] & 0x80) !== 0
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let len = buffer[1] & 0x7f
      let offset = 2
      if (len === 126) {
        if (buffer.length < 4) return
        len = buffer.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (buffer.length < 10) return
        const big = buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error(`帧长度 ${big} 超过上限 ${MAX_MESSAGE_BYTES}`)
        len = Number(big)
        offset = 10
      }
      const maskKey = masked ? buffer.subarray(offset, offset + 4) : null
      if (masked) offset += 4
      if (buffer.length < offset + len) return
      let payload = buffer.subarray(offset, offset + len)
      if (maskKey) payload = Buffer.from(payload.map((b, i) => b ^ maskKey[i % 4]))
      buffer = buffer.subarray(offset + len)
      onFrame({ fin, opcode, payload: Buffer.from(payload) })
    }
  }
}

// 接口与浏览器 WebSocket 的子集一致：addEventListener('open'|'message'|'error'|'close')、send、close。
export class MiniWebSocket {
  #listeners = {}
  #socket = null
  #isClosed = false
  #closeSent = false
  #fragments = []
  #fragmentBytes = 0

  constructor(url, { request = https.request } = {}) {
    const target = new URL(url)
    if (target.protocol !== 'wss:') throw new Error(`只支持 wss://，收到 ${url}`)
    const key = randomBytes(16).toString('base64')
    const req = request({
      host: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      servername: target.hostname,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    })
    req.on('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== acceptFor(key)) {
        socket.destroy()
        return this.#fail(`握手校验失败：Sec-WebSocket-Accept 不匹配（${url}）`)
      }
      this.#socket = socket
      const push = createFrameParser(frame => this.#onFrame(frame))
      const feed = chunk => {
        try {
          push(chunk)
        } catch (err) {
          this.#emit('error', { type: 'error', message: err.message })
          socket.destroy()
        }
      }
      socket.on('data', feed)
      socket.on('error', err => this.#emit('error', { type: 'error', message: err.message }))
      socket.on('close', () => this.#finish(1006))
      this.#emit('open', { type: 'open' })
      if (head?.length) feed(head)
    })
    req.on('response', res => {
      res.resume()
      this.#fail(`握手被拒绝：HTTP ${res.statusCode}（${url}）`)
    })
    req.on('error', err => this.#fail(`连接 ${url} 失败：${err.message}`))
    req.end()
  }

  addEventListener(type, fn) {
    ;(this.#listeners[type] ??= []).push(fn)
  }

  send(text) {
    if (!this.#socket || this.#isClosed) throw new Error('WebSocket 未连接')
    this.#socket.write(encodeFrame(OPCODE.text, Buffer.from(String(text), 'utf8')))
  }

  close(code = 1000) {
    if (this.#isClosed) return
    if (!this.#socket) return this.#finish(code)
    this.#sendClose(code)
    // 等对端回关闭帧；不回就强制断开。
    setTimeout(() => this.#socket?.destroy(), CLOSE_TIMEOUT_MS).unref?.()
  }

  #emit(type, ev) {
    for (const fn of this.#listeners[type] ?? []) fn(ev)
  }

  #fail(message) {
    this.#emit('error', { type: 'error', message })
    this.#finish(1006)
  }

  #finish(code) {
    if (this.#isClosed) return
    this.#isClosed = true
    this.#emit('close', { type: 'close', code })
  }

  #sendClose(code) {
    if (this.#closeSent) return
    this.#closeSent = true
    const payload = Buffer.alloc(2)
    payload.writeUInt16BE(code)
    this.#socket.write(encodeFrame(OPCODE.close, payload))
  }

  #onFrame({ fin, opcode, payload }) {
    if (opcode === OPCODE.ping) return this.#socket.write(encodeFrame(OPCODE.pong, payload))
    if (opcode === OPCODE.pong) return
    if (opcode === OPCODE.close) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      this.#sendClose(code === 1005 ? 1000 : code)
      // 先上报服务端给的关闭码；end() 会同步触发 socket 的 close，那里只会补报 1006。
      this.#finish(code)
      this.#socket.end()
      return
    }
    if (opcode === OPCODE.text || opcode === OPCODE.binary || opcode === OPCODE.continuation) {
      this.#fragments.push(payload)
      this.#fragmentBytes += payload.length
      if (this.#fragmentBytes > MAX_MESSAGE_BYTES) {
        this.#emit('error', { type: 'error', message: `消息超过 ${MAX_MESSAGE_BYTES} 字节` })
        return this.close(1009)
      }
      if (!fin) return
      const data = Buffer.concat(this.#fragments).toString('utf8')
      this.#fragments = []
      this.#fragmentBytes = 0
      this.#emit('message', { type: 'message', data })
    }
  }
}
