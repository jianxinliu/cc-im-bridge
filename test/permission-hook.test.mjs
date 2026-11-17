// 起真实中转，用真实钩子脚本（子进程、stdin 输入）走一遍审批转发。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const RELAY = new URL('../relay/relay.mjs', import.meta.url).pathname
const HOOK = new URL('../hooks/permission-request.mjs', import.meta.url).pathname
const home = mkdtempSync(join(tmpdir(), 'ccim-'))
const socketPath = join(home, 'relay.sock')
const port = 19000 + Math.floor(Math.random() * 1000)
let relay
let token

function request({ socket, path, method = 'POST', body }) {
  return new Promise((resolve, reject) => {
    const target = socket ? { socketPath } : { host: '127.0.0.1', port }
    const headers = { 'content-type': 'application/json', 'x-token': token ?? '' }
    const req = http.request({ ...target, path, method, headers }, res => {
      let text = ''
      res.on('data', c => (text += c))
      res.on('end', () => resolve(JSON.parse(text)))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

function runHook(event, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, CC_IM_HOME: home, CC_IM_LONG_POLL_MS: '200', CC_IM_MAX_POLLS: '10', ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', c => (stdout += c))
    child.stderr.on('data', c => (stderr += c))
    child.on('exit', code => resolve({ code, stdout, stderr }))
    child.stdin.end(typeof event === 'string' ? event : JSON.stringify(event))
  })
}

const pendingIds = async () => {
  const { events } = await request({ path: '/api/events?since=0', method: 'GET' })
  return events.map(e => e.text.match(/^请求批准 #(\d+)/)?.[1]).filter(Boolean)
}
const waitForApproval = async count => {
  for (let i = 0; i < 100; i++) {
    const ids = await pendingIds()
    if (ids.length >= count) return ids.at(-1)
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('等不到审批请求')
}

const event = (sessionId, extra = {}) => ({
  session_id: sessionId,
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'npm publish', description: '发版' },
  permission_mode: 'default',
  ...extra,
})

before(async () => {
  relay = spawn(process.execPath, [RELAY], { env: { ...process.env, CC_IM_HOME: home, CC_IM_WEB_PORT: String(port) } })
  await new Promise((resolve, reject) => {
    let out = ''
    relay.stdout.on('data', c => {
      out += c
      if (out.includes('聊天窗口：http')) resolve()
    })
    relay.once('exit', code => reject(new Error(`中转退出 ${code}`)))
  })
  token = new URL(readFileSync(join(home, 'web-url'), 'utf8').trim()).searchParams.get('token')
  await request({ socket: true, path: '/mod/register', body: { sessionId: 'on', name: 'api', cwd: '' } })
  await request({ socket: true, path: '/mod/poll', body: { sessionId: 'on', forward: true } })
  await request({ socket: true, path: '/mod/register', body: { sessionId: 'off', name: 'web', cwd: '' } })
})

after(() => {
  relay?.kill('SIGTERM')
  rmSync(home, { recursive: true, force: true })
})

test('没开转发的会话：立即退出、不输出，交回本地', async () => {
  const started = Date.now()
  const r = await runHook(event('off'))
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''])
  assert.ok(Date.now() - started < 2000)
})

test('开了转发：IM 里 /y 批准 → 输出 allow', async () => {
  const before = (await pendingIds()).length
  const running = runHook(event('on'))
  const id = await waitForApproval(before + 1)
  await request({ path: '/api/send', body: { text: `/y ${id}` } })
  const r = await running
  assert.equal(r.code, 0)
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
})

test('开了转发：IM 里 /n 带原因 → 输出 deny，原因告诉 Claude', async () => {
  const before = (await pendingIds()).length
  const running = runHook(event('on'))
  const id = await waitForApproval(before + 1)
  await request({ path: '/api/send', body: { text: `/n ${id} 先别发` } })
  const r = await running
  assert.deepEqual(JSON.parse(r.stdout).hookSpecificOutput.decision, { behavior: 'deny', message: `用户在 IM 拒绝了（#${id}）：先别发` })
})

test('在电脑上先处理了：审批被作废，钩子不输出', async () => {
  const before = (await pendingIds()).length
  const running = runHook(event('on'))
  await waitForApproval(before + 1)
  await request({ socket: true, path: '/mod/approval/settle-local', body: { sessionId: 'on', tool: 'Bash', summary: 'npm publish' } })
  const r = await running
  assert.deepEqual([r.code, r.stdout], [0, ''])
})

test('一直没人答：轮询到上限后作废并交回本地', async () => {
  const r = await runHook(event('on'), { CC_IM_LONG_POLL_MS: '50', CC_IM_MAX_POLLS: '3' })
  assert.deepEqual([r.code, r.stdout], [0, ''])
  const { events } = await request({ path: '/api/events?since=0', method: 'GET' })
  assert.match(events.at(-1).text, /已作废：10 分钟未答复/)
})

test('提问/批准计划、子代理里的调用：不转', async () => {
  for (const extra of [{ tool_name: 'AskUserQuestion' }, { tool_name: 'ExitPlanMode' }, { agent_id: 'a1' }]) {
    const r = await runHook(event('on', extra))
    assert.deepEqual([r.code, r.stdout], [0, ''])
  }
})

test('中转没在跑、输入坏了：不输出，退出码 0', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'ccim-none-'))
  const down = await runHook(event('on'), { CC_IM_HOME: empty })
  assert.deepEqual([down.code, down.stdout, down.stderr], [0, '', ''])
  rmSync(empty, { recursive: true })
  const bad = await runHook('{oops')
  assert.deepEqual([bad.code, bad.stdout], [0, ''])
  assert.match(bad.stderr, /读不懂钩子输入/)
})
