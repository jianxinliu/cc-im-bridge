import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_QUICK_QUESTIONS, ONLINE_WINDOW_MS, createRelay } from '../relay/core.mjs'

// 切换会话会顺带下发「生成建议」，只关心其他指令的断言用它过滤掉。
const nonSuggest = r => r.controls.filter(c => c.type !== 'suggest')

function setup(options = {}) {
  let t = 1_000_000
  const clock = { now: () => t, advance: ms => (t += ms) }
  const relay = createRelay({ now: clock.now, ...options })
  // 切换、遥控会话后会跟一张常问问题卡片；只看文字回执的断言跳过卡片。
  const lastReply = () => relay.since(0).filter(e => !e.suggestions).at(-1)?.text
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

test('同名会话即使暂时离线也不让出名字（排队的消息、编号都保留）；离线超过一天才清理', () => {
  const { relay, clock } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.handleIncoming('@api 排队的消息')
  clock.advance(ONLINE_WINDOW_MS + 1)
  assert.equal(relay.register({ sessionId: 's2', name: 'api', cwd: '' }).status, 409)
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  assert.deepEqual(relay.poll({ sessionId: 's1' }).messages.map(m => m.text), ['排队的消息'])

  clock.advance(24 * 3600_000 + 1)
  assert.equal(relay.register({ sessionId: 's2', name: 'api', cwd: '' }).ok, true, '离线超过一天的会话被清理后名字可用')
  assert.equal(relay.poll({ sessionId: 's1' }).status, 404)
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

test('编号固定：会话改名不变；注销后编号仍留给它，新会话不占；它回来时还用原编号', () => {
  const { relay } = setup()
  relay.register({ sessionId: 's1', name: 'a', cwd: '' })
  relay.register({ sessionId: 's2', name: 'b', cwd: '' })
  relay.register({ sessionId: 's1', name: 'a2', cwd: '' })
  assert.deepEqual(relay.list().map(r => [r.num, r.name]), [[1, 'a2'], [2, 'b']])
  relay.unregister({ sessionId: 's1' })
  relay.register({ sessionId: 's3', name: 'c', cwd: '' })
  relay.register({ sessionId: 's1', name: 'a2', cwd: '' })
  assert.deepEqual(relay.list().map(r => [r.num, r.name]), [[1, 'a2'], [2, 'b'], [3, 'c']])
})

test('编号固定：中转重启后按保存的编号还原，与重新登记的先后无关', () => {
  let saved = {}
  const first = createRelay({ onNumbersChange: n => (saved = n) })
  for (const [id, name] of [['s1', 'api'], ['s2', 'web'], ['s3', 'pm']]) first.register({ sessionId: id, name, cwd: '' })

  const restarted = createRelay({ initialNumbers: JSON.parse(JSON.stringify(saved)) })
  for (const [id, name] of [['s3', 'pm'], ['s2', 'web'], ['s4', 'new'], ['s1', 'api']]) restarted.register({ sessionId: id, name, cwd: '' })
  assert.deepEqual(restarted.list().map(r => [r.num, r.name]), [[1, 'api'], [2, 'web'], [3, 'pm'], [4, 'new']])
})

test('编号固定：14 天没出现的编号让出来；被清理的离线会话回来时仍用原编号', () => {
  let t = 1_000_000
  const old = { num: 1, seenAt: t - 15 * 24 * 3600_000 }
  const relay = createRelay({ now: () => t, initialNumbers: { gone: old, kept: { num: 2, seenAt: t } } })
  relay.register({ sessionId: 'new', name: 'x', cwd: '' })
  assert.equal(relay.list()[0].num, 1, '过期的编号 1 让给新会话；编号 2 仍保留')

  relay.register({ sessionId: 'kept', name: 'proj', cwd: '' })
  t += 25 * 3600_000
  relay.register({ sessionId: 'other', name: 'y', cwd: '' })
  relay.register({ sessionId: 'kept', name: 'proj', cwd: '' })
  assert.deepEqual(relay.list().map(r => [r.num, r.name]), [[2, 'proj'], [3, 'y']])
})

test('编号固定：常用的会话定期写回最后出现时间，不会在首次登记 14 天后过期', () => {
  let t = 1_000_000
  const saved = []
  const relay = createRelay({ now: () => t, onNumbersChange: n => saved.push(JSON.parse(JSON.stringify(n))) })
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  t += 60_000
  relay.poll({ sessionId: 's1' })
  assert.equal(saved.length, 1, '一小时内不重复写')
  for (let day = 1; day <= 20; day++) {
    t += 24 * 3600_000
    relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  }
  const restarted = createRelay({ now: () => t, initialNumbers: saved.at(-1) })
  restarted.register({ sessionId: 'new', name: 'n', cwd: '' })
  restarted.register({ sessionId: 's1', name: 'api', cwd: '' })
  assert.deepEqual(restarted.list().map(r => [r.num, r.name]), [[1, 'api'], [2, 'n']])
})

test('审批：请求发到 IM，/y 编号 批准、/n 编号 原因 拒绝', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  const { id } = relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'npm publish' })
  assert.match(lastReply(), new RegExp(`请求批准 #${id}：执行命令\\nnpm publish\\n回复「好」批准`))
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
  assert.equal(lastReply(), `#${fresh.id} api：执行命令 fresh`)
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
  assert.deepEqual(relay.since(0).at(-1).approval, { id, name: 'api', tool: '执行命令', summary: 'npm publish' })

  const withDetail = relay.requestApproval({ sessionId: 's1', tool: 'Bash', summary: 'git push', detail: 'git push\n说明：推送' })
  assert.equal(relay.since(0).at(-1).approval.summary, 'git push\n说明：推送', '卡片显示 detail')
  relay.settleLocal({ sessionId: 's1', tool: 'Bash', summary: 'git push' })
  assert.equal(relay.getApproval({ id: withDetail.id }).approval.state, 'cancelled', '匹配仍按原工具名与 summary')
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
  const lastReply = () => relay.since(0).filter(e => !e.suggestions).at(-1)
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

test('当前会话：切换时通知保存；用保存的值启动后，不带会话名的消息直接发给它', () => {
  const saved = []
  const first = createRelay({ onTargetChange: t => saved.push(t) })
  first.register({ sessionId: 's1', name: 'api', cwd: '' })
  first.register({ sessionId: 's2', name: 'web', cwd: '' })
  first.handleIncoming('切到 web')
  first.handleIncoming('切到 web')
  assert.deepEqual(saved, ['s2'], '没变化时不重复保存')

  const restarted = createRelay({ initialTarget: saved.at(-1) })
  restarted.register({ sessionId: 's1', name: 'api', cwd: '' })
  restarted.register({ sessionId: 's2', name: 'web', cwd: '' })
  restarted.handleIncoming('接着说')
  assert.deepEqual(restarted.poll({ sessionId: 's2' }).messages.map(m => m.text), ['接着说'])
})

test('当前会话注销后清空并通知保存', () => {
  const saved = []
  const relay = createRelay({ initialTarget: 's1', onTargetChange: t => saved.push(t) })
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.unregister({ sessionId: 's1' })
  assert.deepEqual(saved, [null])
})

test('「停」给当前会话下发中断；没有当前会话时提示选择', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '' })
  relay.handleIncoming('停')
  assert.match(lastReply(), /不确定要停哪个会话/)
  relay.handleIncoming('切到 web')
  relay.handleIncoming('停')
  assert.equal(lastReply(), '已让 web 停下当前这一轮')
  assert.deepEqual(nonSuggest(relay.poll({ sessionId: 's2' })), [{ type: 'abort' }])
  assert.deepEqual(nonSuggest(relay.poll({ sessionId: 's2' })), [], '指令取走后不再重复给')
  assert.deepEqual(nonSuggest(relay.poll({ sessionId: 's1' })), [])
})

test('「离开」：只有一个在线会话时直接遥控它；多个时回选择卡片', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.handleIncoming('离开')
  assert.match(lastReply(), /^正在遥控 api/)
  assert.deepEqual(nonSuggest(relay.poll({ sessionId: 's1' })), [{ type: 'away', on: true }])

  relay.register({ sessionId: 's2', name: 'web', cwd: '' })
  relay.handleIncoming('离开')
  const picker = relay.since(0).at(-1)
  assert.deepEqual(picker.awayPicker.map(r => [r.num, r.name, r.away]), [[1, 'api', true], [2, 'web', false]])
  assert.match(picker.text, /选择要遥控的会话/)
  assert.deepEqual(nonSuggest(relay.poll({ sessionId: 's2' })), [], '选之前不动任何会话')
})

test('遥控同一时间只有一个会话：「离开 2」切过去，原来的退出；也会成为当前会话', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '' })
  relay.handleIncoming('离开 api')
  assert.deepEqual(nonSuggest(relay.poll({ sessionId: 's1' })), [{ type: 'away', on: true }])
  relay.handleIncoming('离开 2')
  assert.equal(lastReply(), '正在遥控 web：它每一轮的回复、审批、提问都发到这里（api 已退出遥控）。回到电脑说「回来了」')
  assert.deepEqual(nonSuggest(relay.poll({ sessionId: 's1' })), [{ type: 'away', on: false }])
  assert.deepEqual(nonSuggest(relay.poll({ sessionId: 's2' })), [{ type: 'away', on: true }])
  relay.handleIncoming('离开 2')
  assert.deepEqual(nonSuggest(relay.poll({ sessionId: 's2' })), [], '已在遥控中不重复下发')
  relay.handleIncoming('继续')
  assert.deepEqual(relay.poll({ sessionId: 's2' }).messages.map(m => m.text), ['继续'])
  relay.handleIncoming('离开 nope')
  assert.match(lastReply(), /没有名为 nope 的会话/)
})

test('会话列表标出遥控中的会话（以插件上报为准）；「回来了」关闭所有会话的离开模式', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '/w/api' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '/w/web' })
  relay.poll({ sessionId: 's1', away: true })
  relay.handleIncoming('会话')
  assert.deepEqual(relay.since(0).at(-1).sessions.map(r => [r.name, r.away]), [['api', true], ['web', false]])
  assert.match(lastReply(), /1\. api（遥控中）/)

  relay.handleIncoming('回来了')
  assert.equal(lastReply(), '已关闭离开模式：api')
  for (const id of ['s1', 's2']) assert.deepEqual(nonSuggest(relay.poll({ sessionId: id })), [{ type: 'away', on: false }])
  assert.equal(relay.list().some(r => r.away), false)
  relay.handleIncoming('回来了')
  assert.equal(lastReply(), '没有开着离开模式的会话')
})

const ask = [
  { question: '框架？', header: '框架', multiSelect: false, options: [{ label: 'React' }, { label: 'Vue' }] },
  { question: '功能？', header: '功能', multiSelect: true, options: [{ label: '登录' }, { label: '支付' }] },
]

test('提问：没开转发不建；开了按问题逐个发出，带结构化字段', () => {
  const { relay } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  assert.deepEqual(relay.askQuestions({ sessionId: 's1', questions: ask }), { ok: true, forward: false })
  relay.poll({ sessionId: 's1', forward: true })
  const { id } = relay.askQuestions({ sessionId: 's1', questions: ask })
  const cards = relay.since(0).filter(e => e.question).map(e => [e.question.index, e.question.total, e.question.question])
  assert.deepEqual(cards, [[0, 2, '框架？'], [1, 2, '功能？']])
  assert.equal(relay.getQuestion({ id }).question.state, 'pending')
})

test('提问作答：单选只能选一个、编号越界报错、多选按选项顺序拼接、全部答完才算回答', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.poll({ sessionId: 's1', forward: true })
  const { id } = relay.askQuestions({ sessionId: 's1', questions: ask })
  relay.handleIncoming('1 2')
  assert.match(lastReply(), /这个问题只能选一个/)
  relay.handleIncoming('5')
  assert.match(lastReply(), /没有选项 5/)
  relay.handleIncoming('vue')
  assert.equal(relay.getQuestion({ id }).question.state, 'pending')
  relay.handleIncoming('2，1')
  assert.deepEqual(relay.getQuestion({ id }).question, { id, state: 'answered', answers: { '框架？': 'Vue', '功能？': '支付, 登录' } })
  relay.handleIncoming('1')
  assert.deepEqual(relay.poll({ sessionId: 's1' }).messages.map(m => m.text), ['1'], '答完后数字当普通消息')
})

test('提问：卡片点选作答；在电脑上答过或回合结束时作废', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.poll({ sessionId: 's1', forward: true })
  const a = relay.askQuestions({ sessionId: 's1', questions: ask })
  assert.equal(relay.pickQuestionOption({ id: a.id, index: 0, option: 1 }).answer, 'React')
  assert.match(lastReply(), /Q\d+ 已回答：React（还有 1 个问题）/)
  assert.equal(relay.pickQuestionOption({ id: a.id, index: 0, option: 2 }).ok, true, '同一题可改答')
  relay.settleLocal({ sessionId: 's1', tool: 'Bash', summary: 'ls' })
  assert.equal(relay.getQuestion({ id: a.id }).question.state, 'pending', '别的工具运行不影响提问')
  relay.settleLocal({ sessionId: 's1', tool: 'AskUserQuestion', summary: 'x' })
  assert.equal(relay.getQuestion({ id: a.id }).question.state, 'cancelled')
  assert.match(lastReply(), /已在电脑上回答/)
  assert.equal(relay.pickQuestionOption({ id: a.id, index: 1, option: 1 }).status, 409)
})

test('提问：同时有两个提问在等时，文字回复不猜', () => {
  const { relay } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.poll({ sessionId: 's1', forward: true })
  relay.askQuestions({ sessionId: 's1', questions: ask })
  relay.askQuestions({ sessionId: 's1', questions: ask })
  relay.handleIncoming('1')
  assert.deepEqual(relay.poll({ sessionId: 's1' }).messages.map(m => m.text), ['1'])
})

test('流式：带 reqId 的企微消息用流开头代替回执；进度与带 msgId 的回复接在同一条流上', () => {
  const { relay } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.handleIncoming('跑测试', { reqId: 'cb_1' })
  const start = relay.since(0).at(-1)
  assert.deepEqual(start.stream, { key: 'm1', reqId: 'cb_1', phase: 'start', title: 'api', queued: false })
  const [msg] = relay.poll({ sessionId: 's1' }).messages
  assert.equal(msg.id, 'm1')

  relay.progress({ sessionId: 's1', msgId: 'm1', tool: 'Bash', summary: 'npm   test\n--watch' })
  assert.deepEqual([relay.since(0).at(-1).text, relay.since(0).at(-1).stream], ['执行命令：npm test --watch', { key: 'm1', phase: 'progress' }])
  relay.progress({ sessionId: 's1', msgId: 'm1', tool: 'Read', summary: 'x'.repeat(80) })
  assert.equal(relay.since(0).at(-1).text, `读取文件：${'x'.repeat(60)}…`)

  relay.reply({ sessionId: 's1', text: '全部通过', msgId: 'm1' })
  assert.deepEqual(relay.since(0).at(-1).stream, { key: 'm1', phase: 'final' })
  relay.reply({ sessionId: 's1', text: '不带 msgId 的普通回复' })
  assert.equal(relay.since(0).at(-1).stream, undefined)

  relay.handleIncoming('网页发的，没有 reqId')
  assert.equal(relay.since(0).at(-1).stream, undefined)
  assert.equal(relay.progress({ sessionId: 's1', tool: 'Bash' }).status, 400)
})

test('「用法」「/help」回简短用法，不发给会话', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  for (const say of ['用法', '/help', '帮助']) {
    relay.handleIncoming(say)
    assert.match(lastReply(), /^会话：点选会话\n切到 名字/)
  }
  assert.equal(relay.poll({ sessionId: 's1' }).messages.length, 0)
})

test('建议：只在发「建议」时生成，切换会话不再生成；结果以卡片发出，回编号就发送那条，发完即作废', () => {
  const { relay } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '' })
  relay.handleIncoming('切到 web')
  assert.deepEqual(relay.poll({ sessionId: 's2' }).controls, [], '切换会话不调模型')
  relay.handleIncoming('建议')
  assert.deepEqual(relay.poll({ sessionId: 's2' }).controls, [{ type: 'suggest' }])

  relay.suggestions({ sessionId: 's2', items: ['  跑一下测试 ', '', '提交代码', '写文档', '推送', '第五条不要'] })
  const card = relay.since(0).at(-1)
  assert.deepEqual(card.suggestions.items, ['跑一下测试', '提交代码', '写文档', '推送'])
  assert.equal(card.suggestions.kind, 'suggest')
  assert.match(card.text, /^接下来可以：\n1\. 跑一下测试/)

  relay.handleIncoming('2')
  assert.deepEqual(relay.poll({ sessionId: 's2' }).messages.map(m => m.text), ['提交代码'])
  relay.handleIncoming('2')
  assert.deepEqual(relay.poll({ sessionId: 's2' }).messages.map(m => m.text), ['2'], '用掉后数字当普通消息')
  assert.equal(relay.sendSuggestion({ id: card.suggestions.id, n: 1 }).ok, false)
})

test('常问：切换、遥控会话后发一张常问问题卡片（不调模型）；点编号发给它，可反复点；回编号只认第一次', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '' })
  relay.handleIncoming('切到 web')
  const card = relay.since(0).at(-1)
  assert.equal(lastReply(), '之后的消息发给 web')
  assert.equal(relay.since(0).at(-2).text, '之后的消息发给 web', '先回执，后卡片')
  assert.deepEqual(card.suggestions, { id: card.suggestions.id, kind: 'quick', name: 'web', items: DEFAULT_QUICK_QUESTIONS })
  assert.match(card.text, /^常问：\n1\. 现在进展怎么样了？/)
  assert.deepEqual(relay.poll({ sessionId: 's2' }).controls, [])

  relay.handleIncoming('1')
  assert.deepEqual(relay.poll({ sessionId: 's2' }).messages.map(m => m.text), ['现在进展怎么样了？'])
  relay.handleIncoming('1')
  assert.deepEqual(relay.poll({ sessionId: 's2' }).messages.map(m => m.text), ['1'], '选过一次后，回数字当普通消息')
  assert.equal(relay.sendSuggestion({ id: card.suggestions.id, n: 6 }).text, '继续', '卡片按钮仍能点')
  assert.deepEqual(relay.poll({ sessionId: 's2' }).messages.map(m => m.text), ['继续'])
  assert.match(relay.sendSuggestion({ id: card.suggestions.id, n: 9 }).error, /没有第 9 条/)

  relay.handleIncoming('离开 api')
  assert.match(lastReply(), /^正在遥控 api/)
  assert.equal(relay.since(0).at(-1).suggestions.name, 'api')
})

test('常问：发「常问」对当前会话调出；没选会话时提示；清单可配置，空的或格式不对时用默认，最多 6 条', () => {
  let configured = ['  进展？ ', '', '跑测试', 3]
  const { relay, lastReply } = setup({ quickQuestions: () => configured })
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '' })
  relay.handleIncoming('常问')
  assert.equal(lastReply(), '先选一个会话：发「会话」点选')
  relay.handleIncoming('切到 api')
  relay.handleIncoming('常问')
  assert.deepEqual(relay.since(0).at(-1).suggestions.items, ['进展？', '跑测试', '3'])
  configured = Array.from({ length: 8 }, (_, i) => `问题${i + 1}`)
  relay.handleIncoming('常问')
  assert.equal(relay.since(0).at(-1).suggestions.items.length, 6)
  configured = ['  ']
  relay.handleIncoming('常问')
  assert.deepEqual(relay.since(0).at(-1).suggestions.items, DEFAULT_QUICK_QUESTIONS)
  configured = 'not a list'
  relay.handleIncoming('常问')
  assert.deepEqual(relay.since(0).at(-1).suggestions.items, DEFAULT_QUICK_QUESTIONS)
})

test('建议：发「建议」对当前会话生成；会话出错时转告；超过 10 分钟作废；重复请求不重复下发', () => {
  const { relay, clock, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.handleIncoming('建议')
  relay.handleIncoming('建议')
  assert.deepEqual(relay.poll({ sessionId: 's1' }).controls, [{ type: 'suggest' }])
  relay.suggestions({ sessionId: 's1', error: '这个会话还没有可参考的上下文' })
  assert.equal(lastReply(), 'api：这个会话还没有可参考的上下文')

  relay.suggestions({ sessionId: 's1', items: ['甲'] })
  const { id } = relay.since(0).at(-1).suggestions
  clock.advance(10 * 60_000 + 1)
  assert.match(relay.sendSuggestion({ id, n: 1 }).error, /已过期/)
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.handleIncoming('1')
  assert.deepEqual(relay.poll({ sessionId: 's1' }).messages.map(m => m.text), ['1'])
})

test('在电脑上开离开模式：通知 IM、不给它自己再下发、让原来遥控中的会话退出、不生成建议', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '' })
  relay.handleIncoming('离开 api')
  relay.poll({ sessionId: 's1' })

  relay.awayFromSession({ sessionId: 's2', on: true })
  assert.match(lastReply(), /^正在遥控 web：.*（api 已退出遥控）/)
  assert.deepEqual(relay.poll({ sessionId: 's2' }).controls, [], '它自己已经开了，不再下发；也不生成建议')
  assert.deepEqual(relay.poll({ sessionId: 's1' }).controls, [{ type: 'away', on: false }])

  relay.awayFromSession({ sessionId: 's2', on: false })
  assert.equal(lastReply(), 'web 已退出遥控（在电脑上关闭）')
  assert.equal(relay.list().some(r => r.away), false)
  assert.equal(relay.awayFromSession({ sessionId: 'nope', on: true }).status, 404)
})

test('在电脑上发了消息而退出遥控时，通知里说明原因', () => {
  const { relay, lastReply } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.awayFromSession({ sessionId: 's1', on: true })
  relay.awayFromSession({ sessionId: 's1', on: false, reason: 'typed' })
  assert.equal(lastReply(), 'api 已退出遥控（你在电脑上发了消息）')
})

test('流式：投给离线会话时，流开头标明已排队', () => {
  const { relay, clock } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  clock.advance(ONLINE_WINDOW_MS + 1)
  relay.handleIncoming('@api 晚点处理', { reqId: 'cb_9' })
  assert.equal(relay.since(0).at(-1).stream.queued, true)
})

test('建议：切到别的会话后，回数字不再当作选旧会话的建议', () => {
  const { relay } = setup()
  relay.register({ sessionId: 's1', name: 'api', cwd: '' })
  relay.register({ sessionId: 's2', name: 'web', cwd: '' })
  relay.handleIncoming('切到 api')
  relay.suggestions({ sessionId: 's1', items: ['跑测试', '提交'] })
  relay.handleIncoming('切到 web')
  relay.handleIncoming('2')
  assert.deepEqual(relay.poll({ sessionId: 's1' }).messages, [], '不发给 api')
  assert.deepEqual(relay.poll({ sessionId: 's2' }).messages.map(m => m.text), ['有需要我决定的事吗？'], '数字选的是 web 的常问问题')
})
