// 中转重启后仍记得当前会话。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const RELAY = new URL('../relay/relay.mjs', import.meta.url).pathname
const home = mkdtempSync(join(tmpdir(), 'ccim-'))
const port = 20000 + Math.floor(Math.random() * 1000)
const children = new Set()
// 断言失败时也要关掉起过的中转，否则测试进程等它退出而一直挂着。
after(() => {
  for (const child of children) child.kill('SIGKILL')
  rmSync(home, { recursive: true, force: true })
})

async function startRelay() {
  const child = spawn(process.execPath, [RELAY], { env: { ...process.env, CC_IM_HOME: home, CC_IM_WEB_PORT: String(port) } })
  children.add(child)
  child.once('exit', () => children.delete(child))
  await new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', c => {
      out += c
      if (out.includes('聊天窗口：http')) resolve()
    })
    child.once('exit', code => reject(new Error(`中转退出 ${code}`)))
  })
  const token = new URL(readFileSync(join(home, 'web-url'), 'utf8').trim()).searchParams.get('token')
  return { child, token }
}

function call({ socket, path, body, token }) {
  return new Promise((resolve, reject) => {
    const target = socket ? { socketPath: join(home, 'relay.sock') } : { host: '127.0.0.1', port }
    const req = http.request({ ...target, path, method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token ?? '' } }, res => {
      let text = ''
      res.on('data', c => (text += c))
      res.on('end', () => resolve(JSON.parse(text)))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

const stop = child => new Promise(r => (child.once('exit', r), child.kill('SIGTERM')))

test('选过的会话写入 relay-state.json（600），重启后不用重选', async () => {
  let relay = await startRelay()
  for (const [sessionId, name] of [['s1', 'api'], ['s2', 'web']]) {
    await call({ socket: true, path: '/mod/register', body: { sessionId, name, cwd: '' } })
  }
  await call({ path: '/api/send', body: { text: '切到 web' }, token: relay.token })
  assert.equal(statSync(join(home, 'relay-state.json')).mode & 0o777, 0o600)
  await stop(relay.child)

  relay = await startRelay()
  for (const [sessionId, name] of [['s1', 'api'], ['s2', 'web']]) {
    await call({ socket: true, path: '/mod/register', body: { sessionId, name, cwd: '' } })
  }
  await call({ path: '/api/send', body: { text: '重启后接着说' }, token: relay.token })
  const polled = await call({ socket: true, path: '/mod/poll', body: { sessionId: 's2' } })
  assert.deepEqual(polled.messages.map(m => m.text), ['重启后接着说'])
  await stop(relay.child)
})
