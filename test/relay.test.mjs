// 起一个真实的中转进程，经 Unix socket 和网页接口走一遍收发。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const RELAY = new URL('../relay/relay.mjs', import.meta.url).pathname
// 放在 /tmp 下，避免 socket 路径超过约 100 字节的上限。
const home = mkdtempSync(join(tmpdir(), 'ccim-'))
const socketPath = join(home, 'relay.sock')
const port = 18000 + Math.floor(Math.random() * 1000)
let child
let webUrl

function request({ socket, path, method = 'GET', body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      socket
        ? { socketPath, path, method, headers: { 'content-type': 'application/json', ...headers } }
        : { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
      res => {
        let text = ''
        res.on('data', c => (text += c))
        res.on('end', () => {
          const isJson = String(res.headers['content-type']).startsWith('application/json')
          resolve({ status: res.statusCode, body: isJson ? JSON.parse(text) : null, text })
        })
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

before(async () => {
  child = spawn(process.execPath, [RELAY], {
    env: { ...process.env, CC_IM_HOME: home, CC_IM_WEB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', c => (stderr += c))
  await new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`中转 5 秒内没起来：${out}${stderr}`)), 5000)
    child.stdout.on('data', c => {
      out += c
      if (out.includes('mod 接口') && out.includes('聊天窗口：http')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once('exit', code => reject(new Error(`中转提前退出 code=${code}：${stderr}`)))
  })
  webUrl = readFileSync(join(home, 'web-url'), 'utf8').trim()
})

after(() => {
  child?.kill('SIGTERM')
  rmSync(home, { recursive: true, force: true })
})

const token = () => new URL(webUrl).searchParams.get('token')

test('socket 与目录只有本人可访问', () => {
  assert.equal(statSync(home).mode & 0o777, 0o700)
  assert.equal(statSync(socketPath).mode & 0o777, 0o600)
})

test('网页发消息 → 会话取到 → 会话回复 → 网页看到', async () => {
  const reg = await request({ socket: true, path: '/mod/register', method: 'POST', body: { sessionId: 's1', name: 'api', cwd: '/w' } })
  assert.equal(reg.status, 200)

  const sent = await request({ path: '/api/send', method: 'POST', body: { text: '你好' }, headers: { 'x-token': token() } })
  assert.equal(sent.status, 200)

  const listed = await request({ socket: true, path: '/mod/sessions' })
  assert.equal(listed.body.sessions[0].name, 'api')

  const polled = await request({ socket: true, path: '/mod/poll', method: 'POST', body: { sessionId: 's1' } })
  assert.deepEqual(polled.body.messages.map(m => m.text), ['你好'])

  await request({ socket: true, path: '/mod/reply', method: 'POST', body: { sessionId: 's1', text: '收到' } })
  const events = await request({ path: '/api/events?since=0', headers: { 'x-token': token() } })
  assert.deepEqual(
    events.body.events.map(e => [e.dir, e.from, e.text]),
    [
      ['in', 'me', '你好'],
      ['out', 'relay', '→ api'],
      ['out', 'api', '收到'],
    ],
  )
})

test('网页接口缺 token 或 Host 不对时拒绝', async () => {
  assert.equal((await request({ path: '/api/send', method: 'POST', body: { text: 'x' } })).status, 403)
  assert.equal((await request({ path: '/' })).status, 403)
  const rebinding = await request({ path: '/api/events', headers: { 'x-token': token(), host: `evil.example:${port}` } })
  assert.equal(rebinding.status, 403)
  const page = await request({ path: `/?token=${token()}` })
  assert.equal(page.status, 200)
})

test('坏请求返回带上下文的错误', async () => {
  const bad = await request({ socket: true, path: '/mod/poll', method: 'POST', body: '{oops' })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /POST \/mod\/poll 失败：请求体不是合法 JSON/)
  const unknown = await request({ socket: true, path: '/mod/nope', method: 'POST', body: {} })
  assert.equal(unknown.status, 404)
})

test('已有中转在跑时，第二个实例拒绝启动', async () => {
  const second = spawn(process.execPath, [RELAY], {
    env: { ...process.env, CC_IM_HOME: home, CC_IM_WEB_PORT: String(port + 1) },
  })
  let stderr = ''
  second.stderr.on('data', c => (stderr += c))
  const code = await new Promise(resolve => second.once('exit', resolve))
  assert.equal(code, 1)
  assert.match(stderr, /已有中转在运行/)
})
