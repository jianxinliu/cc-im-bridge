import { expect, mock, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code/testing'

import { defaultName, isTypedAtComputer, normalizeName, parseSuggestions } from '../hooks/register'

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

function engineBeneath(on: On, sessionId = 'abcd1234-session', repoRoot: string | null = null) {
  const submitted: string[] = []
  const statuses: (string | undefined)[] = []
  on('session.id', () => ({ value: sessionId }))
  on('session.repo', () => ({ value: repoRoot ? { root: repoRoot, remote: null, internal: false, name: null } : null }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    // 要按用户原话提交，不套插件消息的说明。
    if ((e.origin as { asUser?: boolean }).asUser !== true) throw new Error('应带 asUser 提交')
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
    body: { sessionId: 'abcd1234-session', name: 'api', cwd: '/Users/me/work/api', version: '0.7.3' },
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
  expect(empty.deny).toBe('text 和 file 至少给一个')
})

test('/im-name 校验名字并重新登记', async ($, on) => {
  const calls = fakeRelay(on, { '/mod/poll': () => ({ ok: true, messages: [] }) })
  engineBeneath(on)
  await startSession($)

  const bad = await $.command.run({ command: 'im-name', args: 'api：v2' })
  expect(bad.text).toContain('不能含冒号')

  const spaced = await $.command.run({ command: 'im-name', args: '  后端   API  ' })
  expect(spaced.text).toBe('本会话在 IM 里的名字改为 后端 API')

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

const IM_PROMPT = '[企微 m1] 部署一下'
const forwardFlags = (calls: Call[]) => calls.filter(c => c.path === '/mod/forward').map(c => c.body.forward)

test('审批转发：IM 发起的回合开始时打开转发，结束时关闭并作废未答复的审批', async ($, on) => {
  const calls = fakeRelay(on, { '/mod/poll': () => ({ ok: true, messages: [] }) })
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)
  expect(calls.find(c => c.path === '/mod/poll')?.body.forward).toBe(false)

  await $.turn.start({ text: IM_PROMPT, turnId: 'im1' })
  await clock.advance(2000)
  expect(calls.filter(c => c.path === '/mod/poll').at(-1)?.body.forward).toBe(true)

  await $.turn.complete({ answer: '好了', durationMs: 1, isAborted: false, turnId: 'im1', reason: 'answer' })
  expect(forwardFlags(calls)).toEqual([true, false])
  expect(calls.find(c => c.path === '/mod/approval/settle-local')?.body).toEqual({ sessionId: 'abcd1234-session' })
})

test('审批转发：本地发起的回合不转；/im-away on 后转', async ($, on) => {
  const calls = fakeRelay(on, { '/mod/poll': () => ({ ok: true, messages: [] }) })
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)

  await $.turn.start({ text: '本地的提问', turnId: 'l1' })
  await $.command.run({ command: 'im-away', args: 'on' })
  await $.turn.start({ text: '本地的提问', turnId: 'l2' })
  expect(forwardFlags(calls)).toEqual([false, true, true])

  const status = await $.command.run({ command: 'im-status', args: '' })
  expect(status.text).toContain('审批转发：开')
})

test('审批转发：工具开始运行时，按工具和摘要作废 IM 里那条（摘要与 relay/summary.mjs 一致）', async ($, on) => {
  const calls = fakeRelay(on, { '/mod/poll': () => ({ ok: true, messages: [] }) })
  on('tool.call', () => ({ result: {} }))
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)

  await $.tool.call({ tool: 'Bash', command: 'npm publish', description: '发版' })
  await clock.settle()
  expect(calls.filter(c => c.path === '/mod/approval/settle-local').at(-1)?.body).toEqual({
    sessionId: 'abcd1234-session',
    tool: 'Bash',
    summary: 'npm publish',
  })

  await $.tool.call({ tool: 'mcp__cc-im-bridge__send', text: 'x' })
  await clock.settle()
  const settles = calls.filter(c => c.path === '/mod/approval/settle-local')
  expect(settles.length).toBe(1)
})

test('默认名字：普通目录取目录名；worktree 取「仓库名-worktree 名第一段」', () => {
  expect(defaultName('/w/api', '/w/api')).toBe('api')
  expect(defaultName('/w/api', undefined)).toBe('api')
  expect(defaultName('/w/tpa/.claude/worktrees/musing-meitner-591696', '/w/tpa')).toBe('tpa-musing')
  expect(defaultName('/', undefined)).toBe('session')
})

test('worktree 会话登记时用仓库名命名', async ($, on) => {
  const calls = fakeRelay(on, { '/mod/poll': () => ({ ok: true, messages: [] }) })
  const { clock } = engineBeneath(on, 'abcd1234-session', '/Users/me/work')
  await $.session.start({ cwd: '/Users/me/work/.claude/worktrees/brave-noether-1a2b', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  expect(calls[0]?.body.name).toBe('work-brave')
})

test('离开模式：本地发起的回合回复也发回 IM，且不受 /im-push off 影响', async ($, on) => {
  const calls = fakeRelay(on, { '/mod/poll': () => ({ ok: true, messages: [] }) })
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)
  await $.command.run({ command: 'im-push', args: 'off' })
  await $.command.run({ command: 'im-away', args: 'on' })

  await $.turn.start({ text: '本地提问', turnId: 'l1' })
  await $.turn.complete({ answer: '本地回复', durationMs: 1, isAborted: false, turnId: 'l1', reason: 'answer' })
  expect(calls.filter(c => c.path === '/mod/reply').map(c => c.body.text)).toEqual(['本地回复'])
})

test('IM 指令：「离开」打开离开模式；「停」中断正在跑的回合；没在跑时告知', async ($, on) => {
  const pending: object[][] = [[{ type: 'away', on: true }]]
  const calls = fakeRelay(on, { '/mod/poll': () => ({ ok: true, messages: [], controls: pending.shift() ?? [] }) })
  const aborted: string[] = []
  on('turn.abort', (_, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)
  expect((await $.command.run({ command: 'im-status', args: '' })).text).toContain('离开模式：on')

  pending.push([{ type: 'abort' }])
  await clock.advance(2000)
  expect(calls.filter(c => c.path === '/mod/reply').at(-1)?.body.text).toBe('当前没有在运行的回合')

  await $.turn.start({ text: '跑个长任务', turnId: 't9' })
  pending.push([{ type: 'abort' }])
  await clock.advance(2000)
  expect(aborted).toEqual(['t9'])
})

test('流式进度：IM 消息带 id 提交；该回合每个工具报一行进度，回复带上 msgId；本地回合不报', async ($, on) => {
  let pending = [{ id: 'm7', text: '跑测试' }]
  const calls = fakeRelay(on, {
    '/mod/poll': () => {
      const messages = pending
      pending = []
      return { ok: true, messages }
    },
  })
  on('tool.call', () => ({ result: {} }))
  const { submitted, clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)
  expect(submitted[0]).toBe('[企微 m7] 跑测试')

  await $.turn.start({ text: submitted[0] ?? '', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.settle()
  expect(calls.filter(c => c.path === '/mod/progress').map(c => c.body)).toEqual([
    { sessionId: 'abcd1234-session', msgId: 'm7', tool: 'Bash', summary: 'npm test' },
  ])
  await $.turn.complete({ answer: '全部通过', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(calls.filter(c => c.path === '/mod/reply').at(-1)?.body).toEqual({ sessionId: 'abcd1234-session', text: '全部通过', msgId: 'm7' })

  await $.turn.start({ text: '本地提问', turnId: 't2' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()
  expect(calls.filter(c => c.path === '/mod/progress').length).toBe(1)
})

test('取信时上报是否在离开模式，供企微会话列表标「遥控中」', async ($, on) => {
  const calls = fakeRelay(on, { '/mod/poll': () => ({ ok: true, messages: [] }) })
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)
  expect(calls.filter(c => c.path === '/mod/poll').at(-1)?.body.away).toBe(false)
  await $.command.run({ command: 'im-away', args: 'on' })
  await clock.advance(2000)
  expect(calls.filter(c => c.path === '/mod/poll').at(-1)?.body.away).toBe(true)
})

test('名字规整：合并空格、去首尾空格；空、超长、含冒号或控制字符的不收', () => {
  expect(normalizeName(' tpa  发布 验证 ')).toBe('tpa 发布 验证')
  expect(normalizeName('😀 表情也行')).toBe('😀 表情也行')
  expect(normalizeName('   ')).toBe(undefined)
  expect(normalizeName('x'.repeat(33))).toBe(undefined)
  expect(normalizeName('中'.repeat(32))).toBe('中'.repeat(32))
  expect(normalizeName('a:b')).toBe(undefined)
  expect(normalizeName('a\u0007b')).toBe(undefined)
})

test('解析建议：JSON 数组优先；否则按行拆并去掉编号符号；最多 4 条', () => {
  expect(parseSuggestions('好的：["跑测试","提交代码"]')).toEqual(['跑测试', '提交代码'])
  expect(parseSuggestions('1. 跑测试\n2、提交\n- "写文档"\n\n• 推送\n5) 多余')).toEqual(['跑测试', '提交', '写文档', '推送'])
  expect(parseSuggestions('[坏 json\n一条')).toEqual(['[坏 json', '一条'])
})

test('建议：收到 suggest 指令时 fork 本会话生成，结果交给中转；没上下文时转告原因', async ($, on) => {
  const pending: object[][] = [[{ type: 'suggest' }]]
  const calls = fakeRelay(on, { '/mod/poll': () => ({ ok: true, messages: [], controls: pending.shift() ?? [] }) })
  const prompts: string[] = []
  let answer: object = { value: { isAnswered: true, text: '["跑一下测试","提交改动"]', usage: {} } }
  on('model.fork', (_, e) => {
    prompts.push(e.prompt)
    return answer
  })
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)
  await clock.settle()
  expect(prompts[0]).toContain('只输出一个 JSON 字符串数组')
  expect(calls.find(c => c.path === '/mod/suggestions')?.body).toEqual({ sessionId: 'abcd1234-session', items: ['跑一下测试', '提交改动'] })

  answer = { value: { isAnswered: false, reason: 'nothing-to-fork' } }
  pending.push([{ type: 'suggest' }])
  await clock.advance(2000)
  await clock.settle()
  expect(calls.filter(c => c.path === '/mod/suggestions').at(-1)?.body.error).toContain('还没有可参考的上下文')
})

test('send 工具发文件：把路径和说明交给中转；中转拒绝时告诉模型原因', async ($, on) => {
  let reject = false
  const calls = fakeRelay(on, {
    '/mod/poll': () => ({ ok: true, messages: [] }),
    '/mod/file': () => (reject ? { status: 400, ok: false, error: '文件 25.0MB，超过企微 20MB 的上限' } : { ok: true }),
  })
  engineBeneath(on)
  await startSession($)

  const sent = await $.tool.call({ tool: 'mcp__cc-im-bridge__send', file: '/tmp/shot.png', text: '截图' })
  expect(sent.result).toBe('已交给 IM 发送：/tmp/shot.png')
  expect(calls.at(-1)).toEqual({ path: '/mod/file', body: { sessionId: 'abcd1234-session', path: '/tmp/shot.png', caption: '截图' } })

  reject = true
  const denied = await $.tool.call({ tool: 'mcp__cc-im-bridge__send', file: '/tmp/big.zip' })
  expect(denied.deny).toBe('文件没发出：文件 25.0MB，超过企微 20MB 的上限')
})

test('在电脑上 /im-away 开关时通知中转；IM 里说「离开」触发的不再通知；没变化时不通知', async ($, on) => {
  const pending: object[][] = []
  const calls = fakeRelay(on, { '/mod/poll': () => ({ ok: true, messages: [], controls: pending.shift() ?? [] }) })
  const { clock } = engineBeneath(on)
  await startSession($)
  await clock.advance(2000)

  await $.command.run({ command: 'im-away', args: 'on' })
  await $.command.run({ command: 'im-away', args: 'on' })
  await $.command.run({ command: 'im-away', args: 'off' })
  pending.push([{ type: 'away', on: true }])
  await clock.advance(2000)
  expect(calls.filter(c => c.path === '/mod/away').map(c => c.body.on)).toEqual([true, false])
})

test('只有在电脑输入框里发的普通消息才算回到电脑前', () => {
  expect(isTypedAtComputer('composer', false)).toBe(true)
  expect(isTypedAtComputer('composer', true)).toBe(false)
  for (const kind of ['plugin', 'task-notification', 'bridge', 'sdk']) expect(isTypedAtComputer(kind, false)).toBe(false)
})

test('离开模式下，IM 转来的消息（插件提交）不会关闭离开模式', async ($, on) => {
  let pending: { id: string; text: string }[] = []
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
  await $.command.run({ command: 'im-away', args: 'on' })
  pending = [{ id: 'm1', text: '继续' }]
  await clock.advance(2000)
  expect(submitted).toEqual(['[企微 m1] 继续'])
  expect((await $.command.run({ command: 'im-status', args: '' })).text).toContain('离开模式：on')
  expect(calls.filter(c => c.path === '/mod/away').map(c => c.body.on)).toEqual([true])
})

test('/im-push off 时，IM 发起的回合仍给那条消息收尾（不发回复内容）', async ($, on) => {
  let pending = [{ id: 'm3', text: '跑测试' }]
  const calls = fakeRelay(on, {
    '/mod/poll': () => {
      const messages = pending
      pending = []
      return { ok: true, messages }
    },
  })
  const { submitted, clock } = engineBeneath(on)
  await startSession($)
  await $.command.run({ command: 'im-push', args: 'off' })
  await clock.advance(2000)
  await $.turn.start({ text: submitted[0] ?? '', turnId: 't1' })
  await $.turn.complete({ answer: '详细结果', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const reply = calls.filter(c => c.path === '/mod/reply').at(-1)?.body
  expect(reply?.msgId).toBe('m3')
  expect(String(reply?.text)).toContain('/im-push off')
  expect(String(reply?.text)).not.toContain('详细结果')

  await $.turn.start({ text: '本地', turnId: 't2' })
  await $.turn.complete({ answer: '本地回复', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(calls.filter(c => c.path === '/mod/reply').length).toBe(1)
})
