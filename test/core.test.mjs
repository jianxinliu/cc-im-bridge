import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ONLINE_WINDOW_MS, createRelay } from '../relay/core.mjs'

function setup() {
  let t = 1_000_000
  const clock = { now: () => t, advance: ms => (t += ms) }
  const relay = createRelay({ now: clock.now })
  const lastReply = () => relay.since(0).at(-1)?.text
  return { relay, clock, lastReply }
}

test('只有一个在线会话时，普通消息直接投给它', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '/w/api', version: '0.1.1' })
  assert.equal(relay.list()[0].version, '0.1.1')
  relay.handleIncoming('跑测试')
  assert.equal(lastReply(), '→ api')
  assert.deepEqual(relay.poll({ sessionId: 's1' }).messages.map(m => m.text), ['跑测试'])
  assert.deepEqual(relay.poll({ sessionId: 's1' }).messages, [], '取过的消息不再重复给')
})

test('多个会话且没选默认时，提示先选择，不投递', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '' })
  relay.handleIncoming('hi')
  assert.match(lastReply(), /不确定发给哪个会话/)
  assert.equal(relay.poll({ sessionId: 's1' }).messages.length, 0)
  assert.equal(relay.poll({ sessionId: 's2' }).messages.length, 0)
})

test('@名字 投给指定会话，并成为之后的默认会话', () => {
  const { relay } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '' })
  relay.handleIncoming('@web 改按钮颜色')
  relay.handleIncoming('再加个边框')
  assert.deepEqual(relay.poll({ sessionId: 's2' }).messages.map(m => m.text), ['改按钮颜色', '再加个边框'])
  assert.equal(relay.poll({ sessionId: 's1' }).messages.length, 0)
})

test('/use 切换默认会话；名字不存在时提示', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '' })
  relay.handleIncoming('/use nope')
  assert.match(lastReply(), /没有名为 nope/)
  relay.handleIncoming('/use api')
  relay.handleIncoming('hello')
  assert.equal(relay.poll({ sessionId: 's1' }).messages[0].text, 'hello')
})

test('/list 标出默认会话与离线会话', () => {
  const { relay, clock, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '/w/api' })
  clock.advance(ONLINE_WINDOW_MS + 1)
  relay.register({ sessionId: 's2', name: 'web', cwd: '/w/web' })
  relay.handleIncoming('/use web')
  relay.handleIncoming('/list')
  assert.equal(lastReply(), '  1. api（离线）  /w/api\n* 2. web  /w/web')
})

test('在线会话占用的名字不能被别的会话登记；离线后可以接手', () => {
  const { relay, clock } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  const taken = relay.register({ sessionId: 's2', name: 'api', cwd: '' })
  assert.equal(taken.status, 409)
  clock.advance(ONLINE_WINDOW_MS + 1)
  assert.equal(relay.register({ sessionId: 's2', name: 'api', cwd: '' }).ok, true)
  assert.equal(relay.poll({ sessionId: 's1' }).status, 404, '被接手的旧登记已移除')
})

test('离线会话的消息排队，上线取信时拿到', () => {
  const { relay, clock, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.handleIncoming('@api 先记着')
  clock.advance(ONLINE_WINDOW_MS + 1)
  relay.handleIncoming('@api 第二条')
  assert.match(lastReply(), /会话离线，已排队/)
  assert.equal(relay.poll({ sessionId: 's1' }).messages.length, 2)
})

test('队列满时不再接收，并告知 IM', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  for (let i = 0; i < 50; i++) relay.handleIncoming(`@api m${i}`)
  relay.handleIncoming('@api 溢出')
  assert.match(lastReply(), /已满 50 条/)
  assert.equal(relay.poll({ sessionId: 's1' }).messages.length, 50)
})

test('会话回复带上会话名进入 IM 日志；未登记或空文本被拒绝', () => {
  const { relay } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  assert.equal(relay.reply({ sessionId: 's1', text: '完成' }).ok, true)
  assert.deepEqual(
    relay.since(0).map(e => [e.from, e.text]),
    [['api', '完成']],
  )
  assert.equal(relay.reply({ sessionId: 'nope', text: 'x' }).status, 404)
  assert.equal(relay.reply({ sessionId: 's1', text: '  ' }).status, 400)
})

test('注销后默认会话清空', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '' })
  relay.handleIncoming('/use api')
  relay.unregister({ sessionId: 's1' })
  relay.handleIncoming('hi')
  assert.equal(relay.poll({ sessionId: 's2' }).messages[0]?.text, 'hi', '只剩一个在线会话时自动投给它')
  assert.equal(lastReply(), '→ web')
})

test('@编号、@唯一前缀、/use 编号都能定位会话；前缀有歧义时提示候选', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api-server', cwd: '' })
  relay.register({ sessionId: 's2', name: 'api-worker', cwd: '' })
  relay.register({ sessionId: 's3', name: 'web', cwd: '' })
  relay.handleIncoming('@2 按编号')
  relay.handleIncoming('@WE 按前缀，不分大小写')
  relay.handleIncoming('@api 有歧义')
  assert.match(lastReply(), /api 能匹配多个会话：1\.api-server、2\.api-worker/)
  relay.handleIncoming('@9 不存在')
  assert.match(lastReply(), /没有编号 9 的会话/)
  relay.handleIncoming('/use 1')
  relay.handleIncoming('默认会话')
  assert.deepEqual(relay.poll({ sessionId: 's2' }).messages.map(m => m.text), ['按编号'])
  assert.deepEqual(relay.poll({ sessionId: 's3' }).messages.map(m => m.text), ['按前缀，不分大小写'])
  assert.deepEqual(relay.poll({ sessionId: 's1' }).messages.map(m => m.text), ['默认会话'])
})

test('编号在会话登记期间不变；注销后空出的编号给新会话复用', () => {
  const { relay } = setup()
  relay.register({ sessionId: 's1', name: 'a', cwd: '' })
  relay.register({ sessionId: 's2', name: 'b', cwd: '' })
  relay.register({ sessionId: 's1', name: 'a2', cwd: '' })
  assert.deepEqual(relay.list().map(r => [r.num, r.name]), [[1, 'a2'], [2, 'b']])
  relay.unregister({ sessionId: 's1' })
  relay.register({ sessionId: 's3', name: 'c', cwd: '' })
  assert.deepEqual(relay.list().map(r => [r.num, r.name]), [[1, 'c'], [2, 'b']])
})

test('审批：请求发到 IM，/y 编号 批准、/n 编号 原因 拒绝', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  const { id } = relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'npm publish' })
  assert.match(lastReply(), new RegExp(`请求批准 #${id}：Bash\\nnpm publish\\n回复「好」批准`))
  relay.handleIncoming(`/y ${id}`)
  assert.deepEqual(relay.getApproval({ id }).approval, { id, state: 'approved', reason: '' })
  assert.match(lastReply(), /已批准/)

  const second = relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'rm -rf dist' })
  relay.handleIncoming(`/n ${second.id} 先别删`)
  assert.deepEqual(relay.getApproval({ id: second.id }).approval, { id: second.id, state: 'denied', reason: '先别删' })
})

test('审批：只有一条待批时 /y 可省略编号；多条时要求带编号', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  const a = relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'a' })
  const b = relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'b' })
  relay.handleIncoming('/y')
  assert.match(lastReply(), new RegExp(`有 2 条待批，请点卡片上的按钮，或带编号：#${a.id} #${b.id}`))
  relay.handleIncoming(`/n ${a.id}`)
  relay.handleIncoming('/y')
  assert.equal(relay.getApproval({ id: b.id }).approval.state, 'approved')
  relay.handleIncoming('/y')
  assert.match(lastReply(), /没有待批的请求/)
})

test('审批：已决定、已作废的不能再改；作废会告知 IM', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  const { id } = relay.requestApproval({ sessionId: 's1', tool: 'Edit', summary: 'x' })
  relay.cancelApproval({ id, why: '已在本地处理' })
  assert.match(lastReply(), new RegExp(`审批 #${id} 已作废：已在本地处理`))
  relay.handleIncoming(`/y ${id}`)
  assert.match(lastReply(), /已是「已作废」，不能再改/)
  assert.equal(relay.getApproval({ id }).approval.state, 'cancelled')
})

test('审批：超过 15 分钟未答自动超时；/pending 只列待批', () => {
  const { relay, clock, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  const old = relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'old' })
  clock.advance(15 * 60_000 + 1)
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  const fresh = relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'fresh\nsecond line' })
  assert.equal(relay.getApproval({ id: old.id }).approval.state, 'expired')
  relay.handleIncoming('/pending')
  assert.equal(lastReply(), `#${fresh.id} api：Bash fresh`)
})

test('审批：未登记会话、缺 tool、不存在的编号返回错误', () => {
  const { relay } = setup()
  assert.equal(relay.requestApproval({ sessionId: 'nope', tool: 'Bash' }).status, 404)
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  assert.equal(relay.requestApproval({ sessionId: 's1' }).status, 400)
  assert.equal(relay.getApproval({ id: 99 }).status, 404)
  assert.equal(relay.cancelApproval({ id: 99 }).status, 404)
})

test('钩子问审批：未登记、离线、没开转发的会话答「不转」；开了才建审批', () => {
  const { relay, clock, lastReply } = setup()
  assert.deepEqual(relay.hookPermission({ sessionId: 'nope', tool: 'Bash', summary: 'ls' }), { ok: true, forward: false })
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  assert.equal(relay.hookPermission({ sessionId: 's1', tool: 'Bash', summary: 'ls' }).forward, false)

  relay.poll({ sessionId: 's1', forward: true })
  const r = relay.hookPermission({ sessionId: 's1', tool: 'Bash', summary: 'ls' })
  assert.equal(r.forward, true)
  assert.match(lastReply(), new RegExp(`请求批准 #${r.id}`))

  clock.advance(ONLINE_WINDOW_MS + 1)
  assert.equal(relay.hookPermission({ sessionId: 's1', tool: 'Bash', summary: 'ls' }).forward, false, '离线不转')
  relay.setForward({ sessionId: 's1', forward: false })
  relay.poll({ sessionId: 's1' })
  assert.equal(relay.hookPermission({ sessionId: 's1', tool: 'Bash', summary: 'ls' }).forward, false, 'poll 不带 forward 时保留原值')
})

test('在电脑上处理后作废审批：按工具与摘要只作废对得上的；不带条件作废全部', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '' })
  const a = relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'ls' })
  const b = relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'rm x' })
  const c = relay.requestApproval({ sessionId: 's2', tool: 'Bash', summary: 'ls' })

  assert.equal(relay.settleLocal({ sessionId: 's1', tool: 'Bash', summary: 'ls' }).cancelled, 1)
  assert.match(lastReply(), new RegExp(`审批 #${a.id} 已在电脑上处理`))
  assert.equal(relay.getApproval({ id: b.id }).approval.state, 'pending')

  relay.handleIncoming(`/y ${b.id}`)
  assert.equal(relay.settleLocal({ sessionId: 's1' }).cancelled, 0, '已答复的不动')
  assert.equal(relay.getApproval({ id: b.id }).approval.state, 'approved')
  assert.equal(relay.getApproval({ id: c.id }).approval.state, 'pending', '别的会话不动')
})

test('审批请求带结构化字段，供 IM 画卡片', () => {
  const { relay } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  const { id } = relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'npm publish' })
  assert.deepEqual(relay.since(0).at(-1).approval, { id, name: 'api', tool: 'Bash', summary: 'npm publish' })
})

test('口语答复：只有一条待批时「好」「可以！」批准，「不行，原因」拒绝并带原因', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  for (const [say, state, reason] of [['好', 'approved', ''], ['可以！', 'approved', ''], ['OK', 'approved', ''], ['不行，先别发版', 'denied', '先别发版'], ['先别', 'denied', '']]) {
    const { id } = relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'x' })
    relay.handleIncoming(say)
    assert.deepEqual(relay.getApproval({ id }).approval, { id, state, reason }, say)
    assert.match(lastReply(), new RegExp(`#${id} ${state === 'approved' ? '已批准' : '已拒绝'}`))
  }
})

test('口语答复：没有待批或有多条待批时，「好」当普通消息；多条时提示点按钮', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.handleIncoming('好')
  assert.deepEqual(relay.poll({ sessionId: 's1' }).messages.map(m => m.text), ['好'])

  const a = relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'a' })
  relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'b' })
  relay.handleIncoming('好')
  assert.equal(relay.getApproval({ id: a.id }).approval.state, 'pending')
  assert.deepEqual(relay.poll({ sessionId: 's1' }).messages.map(m => m.text), ['好'], '多条待批时不猜，照常发给会话')
  relay.handleIncoming('/y')
  assert.match(lastReply(), /请点卡片上的按钮/)
})

test('口语答复：不是整句匹配就不算（「好像有问题」不会被当成批准）', () => {
  const { relay } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  const { id } = relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'x' })
  for (const say of ['好像有问题', '可以吗', '行不行', 'okay?']) relay.handleIncoming(say)
  assert.equal(relay.getApproval({ id }).approval.state, 'pending')
})

test('decideApproval：已有结果的不改，返回当前结果', () => {
  const { relay } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  const { id } = relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'x' })
  assert.equal(relay.decideApproval({ id, approve: true }).state, 'approved')
  const again = relay.decideApproval({ id, approve: false })
  assert.deepEqual([again.ok, again.status, again.state], [false, 409, 'approved'])
  assert.equal(relay.decideApproval({ id: 99, approve: true }).status, 404)
})

test('「会话」「有哪些会话」列出会话，并带结构化列表供 IM 画卡片', () => {
  const { relay } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '/w/api' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '/w/web' })
  for (const say of ['会话', '有哪些会话', '/list']) {
    relay.handleIncoming(say)
    const last = relay.since(0).at(-1)
    assert.deepEqual(last.sessions.map(r => [r.num, r.name]), [[1, 'api'], [2, 'web']], say)
    assert.match(last.text, /1\. api/)
  }
})

test('「切到 web」「换到 2」切换当前会话，之后不带名字的消息发给它', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '' })
  relay.handleIncoming('切到 web')
  assert.equal(lastReply(), '之后的消息发给 web')
  relay.handleIncoming('改个按钮颜色')
  relay.handleIncoming('换到1')
  relay.handleIncoming('跑测试')
  assert.deepEqual(relay.poll({ sessionId: 's2' }).messages.map(m => m.text), ['改个按钮颜色'])
  assert.deepEqual(relay.poll({ sessionId: 's1' }).messages.map(m => m.text), ['跑测试'])
  relay.handleIncoming('切到 nope')
  assert.match(lastReply(), /没有名为 nope 的会话/)
})

test('「名字：内容」发给该会话并成为当前会话；冒号前不是完整会话名时整句原样发给当前会话', () => {
  const { relay } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '' })
  relay.handleIncoming('/use web')
  relay.handleIncoming('注意：这句发给当前会话')
  relay.handleIncoming('ap：前缀不算')
  relay.handleIncoming('api：改接口')
  relay.handleIncoming('WEB: 再加个边框')
  relay.handleIncoming('1：第三条')
  assert.deepEqual(relay.poll({ sessionId: 's2' }).messages.map(m => m.text), ['注意：这句发给当前会话', 'ap：前缀不算', '再加个边框'])
  assert.deepEqual(relay.poll({ sessionId: 's1' }).messages.map(m => m.text), ['改接口', '第三条'])
})

test('useSession：按编号切换并返回名字；不存在时报错', () => {
  const { relay } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  assert.deepEqual(relay.useSession(1), { ok: true, name: 'api', num: 1 })
  assert.equal(relay.list()[0].current, true)
  assert.equal(relay.useSession(9).ok, false)
})

test('有侧边栏标题时：列表、投递回执、回复、审批都显示标题；按标题或原名都能找到', () => {
  const titles = { s1: 'cc-im-bridge 开发', s2: '判例整理与模型适用说明' }
  let t = 1_000_000
  const relay = createRelay({ now: () => t, titleOf: id => titles[id] })
  const lastReply = () => relay.since(0).at(-1)
  relay.register({ sessionId: 's1', name: 'cc-im-bridge', cwd: '' })
  relay.register({ sessionId: 's2', name: 'tpa', cwd: '' })
  relay.register({ sessionId: 's3', name: 'plain', cwd: '' })

  assert.deepEqual(relay.list().map(r => [r.num, r.name, r.alias]), [
    [1, 'cc-im-bridge 开发', 'cc-im-bridge'],
    [2, '判例整理与模型适用说明', 'tpa'],
    [3, 'plain', 'plain'],
  ])

  relay.handleIncoming('切到 判例')
  assert.equal(lastReply().text, '之后的消息发给 判例整理与模型适用说明')
  relay.handleIncoming('cc-im-bridge 开发：带空格的标题也能用冒号发')
  assert.equal(lastReply().text, '→ cc-im-bridge 开发')
  relay.handleIncoming('tpa：原名也行')
  assert.deepEqual(relay.poll({ sessionId: 's1' }).messages.map(m => m.text), ['带空格的标题也能用冒号发'])
  assert.deepEqual(relay.poll({ sessionId: 's2' }).messages.map(m => m.text), ['原名也行'])

  relay.reply({ sessionId: 's2', text: '完成' })
  assert.equal(lastReply().from, '判例整理与模型适用说明')
  relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'ls' })
  assert.equal(lastReply().approval.name, 'cc-im-bridge 开发')
})

test('标题读取出错时退回插件登记的名字', () => {
  const relay = createRelay({ titleOf: () => { throw new Error('EACCES') } })
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  assert.equal(relay.list()[0].name, 'api')
})

test('前缀同时命中多个标题时列出候选', () => {
  const relay = createRelay({ titleOf: id => ({ s1: 'tpa 发布验证', s2: 'tpa 判例整理' })[id] })
  relay.register({ sessionId: 's1', name: 'a', cwd: '' })
  relay.register({ sessionId: 's2', name: 'b', cwd: '' })
  relay.handleIncoming('切到 tpa')
  assert.match(relay.since(0).at(-1).text, /tpa 能匹配多个会话：1\.tpa 发布验证、2\.tpa 判例整理/)
})
