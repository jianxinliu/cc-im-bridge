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
  on('classic.UserPromptSubmit', () => ({}))
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
    body: { sessionId: 'abcd1234-session', name: 'api', cwd: '/Users/me/work/api', version: '0.2.1' },
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

// 审批测试的公共准备：中转替身里 /mod/approval/wait 按给定序列返回状态。
function approvalRelay(on: On, states: string[], reason = '') {
  let waits = 0
  const calls = fakeRelay(on, {
    '/mod/poll': () => ({ ok: true, messages: [] }),
    '/mod/approval/request': () => ({ ok: true, id: 7 }),
    '/mod/approval/wait': () => {
      const state = states[Math.min(waits++, states.length - 1)] ?? 'pending'
      return { ok: true, approval: { id: 7, state, reason } }
    },
  })
  return { calls, waitCount: () => waits }
}

async function inImTurn($: Engine, mode = 'default') {
  await $.classic.UserPromptSubmit({ prompt: '部署一下', permission_mode: mode })
  await $.turn.start({ text: '[来自 IM 的消息，本轮最终回复会自动发回 IM，请简洁]\n部署一下', turnId: 'im1' })
}

test('审批：IM 发起的回合里，要问人时转到 IM，批准后放行', async ($, on) => {
  const { calls } = approvalRelay(on, ['pending', 'approved'])
  on('tool.check', () => ({ decision: 'ask' as const }))
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)
  await inImTurn($)

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'npm publish' }, tool_use_id: 'tu1' })
  expect(verdict.decision).toBe('allow')
  expect(calls.find(c => c.path === '/mod/approval/request')?.body).toEqual({
    sessionId: 'abcd1234-session',
    tool: 'Bash',
    summary: 'npm publish',
  })
})

test('审批：IM 拒绝时带上原因', async ($, on) => {
  approvalRelay(on, ['denied'], '先别发版')
  on('tool.check', () => ({ decision: 'ask' as const }))
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)
  await inImTurn($)

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'npm publish' }, tool_use_id: 'tu1' })
  expect(verdict.decision).toBe('deny')
  expect(verdict.reason).toBe('用户在 IM 拒绝了（#7）：先别发版')
})

test('审批：本地发起的回合默认不转；/im-away on 后转', async ($, on) => {
  const { calls } = approvalRelay(on, ['approved'])
  on('tool.check', () => ({ decision: 'ask' as const }))
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)
  await $.classic.UserPromptSubmit({ prompt: '本地的提问', permission_mode: 'default' })
  await $.turn.start({ text: '本地的提问', turnId: 'local1' })

  const before = await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1' })
  expect(before.decision).toBe('ask')
  expect(calls.some(c => c.path === '/mod/approval/request')).toBe(false)

  await $.command.run({ command: 'im-away', args: 'on' })
  const after = await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu2' })
  expect(after.decision).toBe('allow')
})

test('审批：一直没人答复，轮询有上限，作废后交回本地', async ($, on) => {
  const { calls, waitCount } = approvalRelay(on, ['pending'])
  on('tool.check', () => ({ decision: 'ask' as const }))
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)
  await inImTurn($)

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1' })
  expect(verdict.decision).toBe('ask')
  expect(waitCount()).toBe(24)
  expect(calls.at(-1)).toEqual({ path: '/mod/approval/cancel', body: { id: 7, why: '10 分钟未答复，转回电脑上审批' } })
})

test('审批：引擎已放行、必须本人操作的工具、只是查询（无 tool_use_id）都不转', async ($, on) => {
  const { calls } = approvalRelay(on, ['approved'])
  on('tool.check', (_, e) => ({ decision: e.tool === 'Read' ? ('allow' as const) : ('ask' as const) }))
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)
  await inImTurn($)

  expect((await $.tool.check({ tool: 'Read', input: { file_path: '/a' }, tool_use_id: 'tu1' })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'AskUserQuestion', input: {}, tool_use_id: 'tu2' })).decision).toBe('ask')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('ask')
  expect(calls.some(c => c.path === '/mod/approval/request')).toBe(false)
})

test('审批：中转出错时交回本地，不卡住', async ($, on) => {
  fakeRelay(on, {
    '/mod/poll': () => ({ ok: true, messages: [] }),
    '/mod/approval/request': () => ({ status: 500, ok: false, error: 'boom' }),
  })
  on('tool.check', () => ({ decision: 'ask' as const }))
  const { clock, statuses } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)
  await inImTurn($)

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1' })
  expect(verdict.decision).toBe('ask')
  expect(statuses.at(-1)).toContain('审批转发失败：boom')
})

test('审批：auto、bypassPermissions、dontAsk 和未知模式下不转（交给分类器或本地原样）', async ($, on) => {
  const { calls } = approvalRelay(on, ['approved'])
  on('tool.check', () => ({ decision: 'ask' as const }))
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)

  await $.turn.start({ text: '[来自 IM 的消息，本轮最终回复会自动发回 IM，请简洁]\n未知模式', turnId: 'im0' })
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu0' })).decision).toBe('ask')

  for (const mode of ['auto', 'bypassPermissions', 'dontAsk']) {
    await inImTurn($, mode)
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: `tu-${mode}` })
    expect(verdict.decision).toBe('ask')
  }
  expect(calls.some(c => c.path === '/mod/approval/request')).toBe(false)

  await inImTurn($, 'acceptEdits')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu-ae' })).decision).toBe('allow')
})
