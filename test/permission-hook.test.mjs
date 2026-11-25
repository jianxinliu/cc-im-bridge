// 起真实中转，用真实钩子脚本（子进程、stdin 输入）走一遍审批转发。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  // 从「人在手机上」开始（上次运行留下的状态）；也顺带验证中转重启后沿用这个状态。
  writeFileSync(join(home, 'relay-state.json'), JSON.stringify({ present: false }))
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

test('子代理里的调用：不转', async () => {
  const r = await runHook(event('on', { agent_id: 'a1' }))
  assert.deepEqual([r.code, r.stdout], [0, ''])
})

const askEvent = sessionId =>
  event(sessionId, {
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        { question: '用哪个框架？', header: '框架', multiSelect: false, options: [{ label: 'React' }, { label: 'Vue' }] },
        { question: '要哪些功能？', header: '功能', multiSelect: true, options: [{ label: '登录' }, { label: '支付' }, { label: '搜索' }] },
      ],
    },
  })

const lastText = async () => (await request({ path: '/api/events?since=0', method: 'GET' })).events.at(-1).text
// 只看 since 之后的新事件，避免匹配到前一个测试留下的同类卡片。
const lastSeq = async () => (await request({ path: '/api/events?since=0', method: 'GET' })).events.at(-1)?.seq ?? 0
async function waitForEvent(re, since) {
  for (let i = 0; i < 100; i++) {
    const { events } = await request({ path: `/api/events?since=${since}`, method: 'GET' })
    const hit = events.filter(e => re.test(e.text)).at(-1)
    if (hit) return hit
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`等不到 ${re}`)
}

test('提问：企微里按编号回答两个问题（单选 + 多选）→ 带 answers 放行', async () => {
  const since = await lastSeq()
  const running = runHook(askEvent('on'))
  const first = await waitForEvent(/提问 Q\d+（1\/2）/, since)
  assert.ok(first.question, '带结构化字段供画卡片')
  await request({ path: '/api/send', body: { text: '2' } })
  assert.match(await lastText(), /已回答：Vue（还有 1 个问题）/)
  await request({ path: '/api/send', body: { text: '1 3' } })
  const r = await running
  const out = JSON.parse(r.stdout).hookSpecificOutput.decision
  assert.equal(out.behavior, 'allow')
  assert.deepEqual(out.updatedInput.answers, { '用哪个框架？': 'Vue', '要哪些功能？': '登录, 搜索' })
  assert.equal(out.updatedInput.questions.length, 2, '原问题原样带回')
})

test('提问：「答：」自填答案；在电脑上先答了则不输出', async () => {
  let since = await lastSeq()
  let running = runHook(askEvent('on'))
  await waitForEvent(/提问 Q\d+（2\/2）/, since)
  await request({ path: '/api/send', body: { text: 'React' } })
  await request({ path: '/api/send', body: { text: '答：先只做登录' } })
  let r = await running
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.decision.updatedInput.answers['要哪些功能？'], '先只做登录')

  since = await lastSeq()
  running = runHook(askEvent('on'))
  await waitForEvent(/提问 Q\d+（2\/2）/, since)
  await request({ socket: true, path: '/mod/approval/settle-local', body: { sessionId: 'on', tool: 'AskUserQuestion', summary: 'x' } })
  r = await running
  assert.deepEqual([r.code, r.stdout], [0, ''])
})

test('提问：没开转发的会话不转', async () => {
  const r = await runHook(askEvent('off'))
  assert.deepEqual([r.code, r.stdout], [0, ''])
})

test('批准计划：卡片显示计划正文；批准后带回原输入放行', async () => {
  const before = (await pendingIds()).length
  const input = { plan: '## 计划\n1. 改接口\n2. 补测试', planFilePath: '/tmp/plan.md' }
  const running = runHook(event('on', { tool_name: 'ExitPlanMode', tool_input: input }))
  const id = await waitForApproval(before + 1)
  assert.match(await lastText(), /请求批准 #\d+：批准计划\n## 计划\n1\. 改接口/)
  await request({ path: '/api/send', body: { text: `/y ${id}` } })
  const r = await running
  assert.deepEqual(JSON.parse(r.stdout).hookSpecificOutput.decision, { behavior: 'allow', updatedInput: input })
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

test('人回到电脑前（任一会话报告在电脑上发了消息）：审批不再转到 IM；从 IM 发消息后恢复', async () => {
  await request({ socket: true, path: '/mod/typed', body: { sessionId: 'off' } })
  assert.match(await lastText(), /^你在电脑上给 web 发了消息，之后不再往这里发/)
  const started = Date.now()
  const r = await runHook(event('on'))
  assert.deepEqual([r.code, r.stdout], [0, ''])
  assert.ok(Date.now() - started < 2000, '不转就立即交回本地')
  assert.equal(JSON.parse(readFileSync(join(home, 'relay-state.json'), 'utf8')).present, true, '状态已保存')

  await request({ path: '/api/send', body: { text: '我又出门了' } })
  const before = (await pendingIds()).length
  const running = runHook(event('on'))
  const id = await waitForApproval(before + 1)
  await request({ path: '/api/send', body: { text: `/y ${id}` } })
  assert.equal(JSON.parse((await running).stdout).hookSpecificOutput.decision.behavior, 'allow')
})
