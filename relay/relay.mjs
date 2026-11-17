#!/usr/bin/env node
// 本地中转：Unix socket 给各会话的 mod 用；IM 端是企业微信（配置了 wecom.json 时）和 127.0.0.1 上的网页聊天窗口。
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRelay } from './core.mjs'
import { createWecomAdapter, formatOutgoing, loadWecomConfig } from './wecom.mjs'
import { MiniWebSocket } from './ws-client.mjs'

const HOME = process.env.CC_IM_HOME ?? join(homedir(), '.cc-im-bridge')
const SOCKET = join(HOME, 'relay.sock')
const WEB_PORT = Number(process.env.CC_IM_WEB_PORT ?? 8788)
const MAX_BODY = 1 << 20
const PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'web.html'), 'utf8')

const relay = createRelay()

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error(`请求体超过 ${MAX_BODY} 字节`), { status: 413 }))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(Object.assign(new Error(`请求体不是合法 JSON：${err.message}`), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function answer(res, result) {
  const { status = result.ok ? 200 : 500, ...body } = result
  send(res, status, body)
}

// ---- 给 mod 用的 Unix socket ----
const modRoutes = {
  'POST /mod/register': relay.register,
  'POST /mod/unregister': relay.unregister,
  'POST /mod/poll': relay.poll,
  'POST /mod/reply': relay.reply,
}

const modServer = http.createServer(async (req, res) => {
  const route = `${req.method} ${req.url}`
  if (route === 'GET /mod/health') return send(res, 200, { ok: true })
  if (route === 'GET /mod/sessions') return send(res, 200, { ok: true, sessions: relay.list() })
  const handler = modRoutes[route]
  if (!handler) return send(res, 404, { ok: false, error: `没有这个接口：${route}` })
  try {
    answer(res, handler(await readJson(req)))
  } catch (err) {
    send(res, err.status ?? 500, { ok: false, error: `${route} 失败：${err.message}` })
  }
})

// ---- 网页聊天窗口（IM 端的本地替身）----
// 只听 127.0.0.1，并要求随机 token：防止别的网页借浏览器向本机发请求，把内容注入会话。
const TOKEN = randomBytes(16).toString('hex')
const allowedHosts = new Set([`127.0.0.1:${WEB_PORT}`, `localhost:${WEB_PORT}`])

const webServer = http.createServer(async (req, res) => {
  if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 403, { ok: false, error: 'Host 不允许' })
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'GET' && url.pathname === '/') {
    if (url.searchParams.get('token') !== TOKEN) return send(res, 403, { ok: false, error: 'token 不对' })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(PAGE)
  }
  if (req.headers['x-token'] !== TOKEN) return send(res, 403, { ok: false, error: 'token 不对' })

  if (req.method === 'GET' && url.pathname === '/api/events') {
    return send(res, 200, { ok: true, events: relay.since(Number(url.searchParams.get('since') ?? 0)) })
  }
  if (req.method === 'POST' && url.pathname === '/api/send') {
    try {
      const { text } = await readJson(req)
      relay.handleIncoming(text)
      return send(res, 200, { ok: true })
    } catch (err) {
      return send(res, err.status ?? 500, { ok: false, error: err.message })
    }
  }
  send(res, 404, { ok: false, error: `没有这个接口：${req.method} ${url.pathname}` })
})

// 上次异常退出会留下 socket 文件；能连上说明已有中转在跑，不能连上才清理。
function prepareSocket() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  chmodSync(HOME, 0o700)
  if (!existsSync(SOCKET)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const probe = net.connect(SOCKET)
    probe.once('connect', () => {
      probe.destroy()
      reject(new Error(`${SOCKET} 上已有中转在运行`))
    })
    probe.once('error', () => {
      unlinkSync(SOCKET)
      resolve()
    })
  })
}

try {
  await prepareSocket()
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

modServer.listen(SOCKET, () => {
  chmodSync(SOCKET, 0o600)
  console.log(`mod 接口：${SOCKET}`)
})
webServer.listen(WEB_PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${WEB_PORT}/?token=${TOKEN}`
  writeFileSync(join(HOME, 'web-url'), url + '\n', { mode: 0o600 })
  console.log(`聊天窗口：${url}`)
})
webServer.on('error', err => {
  console.error(`聊天窗口无法监听 127.0.0.1:${WEB_PORT}：${err.message}`)
  process.exit(1)
})

// ---- 企业微信 ----
const WECOM_CONFIG = join(HOME, 'wecom.json')
const WECOM_STATE = join(HOME, 'wecom-state.json')
let wecom = null
try {
  const config = loadWecomConfig(WECOM_CONFIG, { readFile: readFileSync, stat: statSync })
  if (!config) {
    console.log(`未找到 ${WECOM_CONFIG}，只启用网页聊天窗口`)
  } else {
    // 记住最近对话的 chatid，重启后会话主动发消息也知道发给谁。
    let initialChatId = ''
    try {
      initialChatId = JSON.parse(readFileSync(WECOM_STATE, 'utf8')).chatId ?? ''
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`读取 ${WECOM_STATE} 失败，忽略：${err.message}`)
    }
    wecom = createWecomAdapter({
      ...config,
      initialChatId,
      WebSocketImpl: MiniWebSocket,
      onText: text => relay.handleIncoming(text),
      onChatId: chatId => writeFileSync(WECOM_STATE, JSON.stringify({ chatId }) + '\n', { mode: 0o600 }),
    })
    relay.onOutgoing(entry =>
      wecom.send(formatOutgoing(entry)).catch(err => console.error(`发往企微失败：${err.message}`)),
    )
    wecom.start()
    console.log(`企微：白名单 ${config.allowUsers.length} 人，正在连接`)
  }
} catch (err) {
  console.error(`企微未启用：${err.message}`)
  process.exit(1)
}

const shutdown = () => {
  wecom?.stop()
  modServer.close()
  webServer.close()
  try {
    unlinkSync(SOCKET)
  } catch {
    // 已被删除时无需处理
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
