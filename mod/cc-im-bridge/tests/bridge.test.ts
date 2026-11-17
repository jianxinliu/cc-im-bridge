import { expect, mock, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code/testing'

type Call = { path: string; body: Record<string, unknown> }

// 中转的替身：记下每次请求，按路径给出答复。
function fakeRelay(on: On, answers: Record<string, (body: Record<string, unknown>) => object>) {
  const calls: Call[] = []
  on('http.fetch', (_, e) => {
    const path = new URL(e.url).pathname
    const body = JSON.parse(String(e.init?.body ?? '{}'))
    calls.push({ path, body })
    const answer = answers[path]?.(body) ?? { ok: true }
    const status = 'status' in answer ? Number(answer.status) : 200
    return { value: { status, ok: status < 300, headers: {}, text: JSON.stringify(answer) } }
  })
  return calls
}

function engineBeneath(on: On, sessionId = 'abcd1234-session') {
  const submitted: string[] = []
  const statuses: (string | undefined)[] = []
  on('session.id', () => ({ value: sessionId }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  mock.store(on)
  mock.env(on, { HOME: '/Users/me' })
  return { submitted, statuses, clock: mock.clock(on) }
}

async function startSession($: Engine) {
  await $.session.start({ cwd: '/Users/me/work/api', surface: 'desktop', isInteractive: true })
}

test('登记会话后取到的 IM 消息作为新回合提交，回复发回 IM', async ($, on) => {
  let pending = [{ text: '跑一下测试' }]
  const calls = fakeRelay(on, {
    '/mod/poll': () => {
      const messages = pending
      pending = []
      return { ok: true, messages }
    },
  })
  const { submitted, clock } = engineBeneath(on)

  await startSession($)
  await clock.advance(2000)

  expect(calls[0]).toEqual({
    path: '/mod/register',
    body: { sessionId: 'abcd1234-session', name: 'api', cwd: '/Users/me/work/api', version: '0.1.1' },
  })
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('跑一下测试')

  await $.turn.start({ text: submitted[0] ?? '', turnId: 't1' })
  await $.turn.complete({ answer: '测试全部通过', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(calls.at(-1)).toEqual({ path: '/mod/reply', body: { sessionId: 'abcd1234-session', text: '测试全部通过' } })
})

test('不是 IM 发起的回合，默认不回传', async ($, on) => {
  const calls = fakeRelay(on, { '/mod/poll': () => ({ ok: true, messages: [] }) })
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)

  await $.turn.complete({ answer: '本地回复', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(calls.some(c => c.path === '/mod/reply')).toBe(false)
})

test('同名会话在线时，用会话 id 前缀改名后重新登记', async ($, on) => {
  const calls = fakeRelay(on, {
    '/mod/register': body => (body.name === 'api' ? { status: 409, ok: false, error: '名字 api 已被在线会话占用' } : { ok: true }),
    '/mod/poll': () => ({ ok: true, messages: [] }),
  })
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)

  const registered = calls.filter(c => c.path === '/mod/register').map(c => c.body.name)
  expect(registered).toEqual(['api', 'api-abcd'])
})

test('中转重启（取信 404）后重新登记', async ($, on) => {
  let polls = 0
  const calls = fakeRelay(on, {
    '/mod/poll': () => (++polls === 1 ? { status: 404, ok: false, error: '未登记的会话' } : { ok: true, messages: [] }),
  })
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)
  await clock.advance(2000)

  expect(calls.map(c => c.path)).toEqual(['/mod/register', '/mod/poll', '/mod/register', '/mod/poll'])
})

test('中转连不上时状态栏提示，不抛错', async ($, on) => {
  on('http.fetch', () => {
    throw new Error('connect ENOENT /Users/me/.cc-im-bridge/relay.sock')
  })
  const { statuses, clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)

  expect(statuses.at(-1)).toContain('中转未连接')
})

test('send 工具把文字发到 IM；空文字被拒绝', async ($, on) => {
  const calls = fakeRelay(on, { '/mod/poll': () => ({ ok: true, messages: [] }) })
  engineBeneath(on)
  await startSession($)

  const sent = await $.tool.call({ tool: 'mcp__cc-im-bridge__send', text: '部署完成' })
  expect(sent.result).toBe('已发送到 IM')
  expect(calls.at(-1)).toEqual({ path: '/mod/reply', body: { sessionId: 'abcd1234-session', text: '部署完成' } })

  const empty = await $.tool.call({ tool: 'mcp__cc-im-bridge__send', text: '  ' })
  expect(empty.deny).toBe('text 不能为空')
})

test('/im-name 校验名字并重新登记', async ($, on) => {
  const calls = fakeRelay(on, { '/mod/poll': () => ({ ok: true, messages: [] }) })
  engineBeneath(on)
  await startSession($)

  const bad = await $.command.run({ command: 'im-name', args: 'a b' })
  expect(bad.text).toContain('名字为')

  const good = await $.command.run({ command: 'im-name', args: '后端' })
  expect(good.text).toBe('本会话在 IM 里的名字改为 后端')
  expect(calls.at(-1)?.body.name).toBe('后端')
})

test('取信时上一轮还在跑：上一轮的回复不发 IM，IM 那一轮的回复才发', async ($, on) => {
  let pending = [{ text: '链路测试' }]
  const calls = fakeRelay(on, {
    '/mod/poll': () => {
      const messages = pending
      pending = []
      return { ok: true, messages }
    },
  })
  const { submitted, clock } = engineBeneath(on)
  await startSession($)

  // 本地回合 t0 进行中，mod 取到 IM 消息并排队提交
  await $.turn.start({ text: '本地的提问', turnId: 't0' })
  await clock.advance(2000)
  await $.turn.complete({ answer: '本地回合的结束语', durationMs: 10, isAborted: false, turnId: 't0', reason: 'answer' })
  expect(calls.some(c => c.path === '/mod/reply')).toBe(false)

  // 会话空闲后，排队的 IM 消息开启 t1
  await $.turn.start({ text: submitted[0] ?? '', turnId: 't1' })
  await $.turn.complete({ answer: '收到，链路正常', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  const replies = calls.filter(c => c.path === '/mod/reply').map(c => c.body.text)
  expect(replies).toEqual(['收到，链路正常'])
})
