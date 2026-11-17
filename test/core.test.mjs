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
