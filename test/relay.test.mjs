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

test('审批长轮询：待批时挂起，IM 批准后立即返回', async () => {
  await request({ socket: true, path: '/mod/register', method: 'POST', body: { sessionId: 's9', name: 'appr', cwd: '' } })
  const { body } = await request({ socket: true, path: '/mod/approval/request', method: 'POST', body: { sessionId: 's9', tool: 'Bash', summary: 'ls' } })
  const started = Date.now()
  const waiting = request({ socket: true, path: '/mod/approval/wait', method: 'POST', body: { id: body.id, timeoutMs: 5000 } })
  await new Promise(r => setTimeout(r, 200))
  await request({ path: '/api/send', method: 'POST', body: { text: `/y ${body.id}` }, headers: { 'x-token': token() } })
  const decided = await waiting
  assert.equal(decided.body.approval.state, 'approved')
  assert.ok(Date.now() - started < 3000, '批准后不必等到超时')

  const timedOut = await request({ socket: true, path: '/mod/approval/request', method: 'POST', body: { sessionId: 's9', tool: 'Bash', summary: 'ls' } })
  const pending = await request({ socket: true, path: '/mod/approval/wait', method: 'POST', body: { id: timedOut.body.id, timeoutMs: 100 } })
  assert.equal(pending.body.approval.state, 'pending')
})

test('会话发文件：核对绝对路径、文件存在、大小；合格的记入发往 IM 的消息', async () => {
  const { writeFileSync } = await import('node:fs')
  await request({ socket: true, path: '/mod/register', method: 'POST', body: { sessionId: 'sf', name: 'files', cwd: '' } })
  const ok = join(home, 'shot.png')
  writeFileSync(ok, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const cases = [
    [{ path: 'relative.png' }, 400, /绝对路径/],
    [{ path: join(home, 'nope.png') }, 400, /读不到文件/],
    [{ path: home }, 400, /不是普通文件/],
  ]
  for (const [body, status, re] of cases) {
    const r = await request({ socket: true, path: '/mod/file', method: 'POST', body: { sessionId: 'sf', ...body } })
    assert.equal(r.status, status)
    assert.match(r.body.error, re)
  }
  const r = await request({ socket: true, path: '/mod/file', method: 'POST', body: { sessionId: 'sf', path: ok, caption: '截图' } })
  assert.equal(r.status, 200)
  const { events } = (await request({ path: '/api/events?since=0', headers: { 'x-token': token() } })).body
  assert.deepEqual([events.at(-1).from, events.at(-1).text], ['files', '截图\n[图片] shot.png'])
})
