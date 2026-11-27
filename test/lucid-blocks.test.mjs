import assert from 'node:assert/strict'
import { test } from 'node:test'
import { convertLucidBlocks } from '../relay/lucid-blocks.mjs'
import { formatOutgoing } from '../relay/wecom.mjs'

const fence = (lang, body, info = '') => '```' + lang + (info ? ` ${info}` : '') + '\n' + body + '\n```'
const json = (lang, spec, info) => fence(lang, JSON.stringify(spec), info)

test('callout：转成带图标和标题的引用块；种类写错时退回「重点」并把整串当标题', () => {
  assert.equal(convertLucidBlocks(fence('callout', '先备份\n再删除', 'warn')), '> **⚠ 注意**\n> 先备份\n> 再删除')
  assert.equal(convertLucidBlocks(fence('callout', '选 A 还是 B', 'decide 部署方式')), '> **? 部署方式**\n> 选 A 还是 B')
  assert.equal(convertLucidBlocks(fence('callout', '内容', '风险提示')), '> **★ 风险提示**\n> 内容')
})

test('details：企微不能折叠，直接展开并保留标题', () => {
  assert.equal(convertLucidBlocks(fence('details', '- 第一步\n- 第二步', '推导过程')), '**▸ 推导过程**\n- 第一步\n- 第二步')
})

test('steps：编号列表，命令放进行内代码，多行命令用代码块', () => {
  const out = convertLucidBlocks(
    json('steps', {
      title: '部署',
      steps: [
        { title: '拉代码', command: 'git pull' },
        { title: '构建', command: 'make\nmake image', detail: '约 3 分钟' },
        { title: '检查', detail: '返回 200' },
      ],
    }),
  )
  assert.equal(out, '**部署**\n1. 拉代码\n   `git pull`\n2. 构建\n```\nmake\nmake image\n```\n   约 3 分钟\n3. 检查\n   返回 200')
})

test('compare：标出推荐方案，每行按指标列出各方案，最优值加粗', () => {
  const out = convertLucidBlocks(
    json('compare', {
      title: '消息队列选型',
      columns: ['Kafka', 'RabbitMQ'],
      recommend: 'Kafka',
      rows: [
        { label: '延迟', values: [12, 6], unit: 'ms', better: 'lower' },
        { label: '回溯', values: ['支持', '不支持'] },
      ],
    }),
  )
  assert.equal(out, '**消息队列选型**\n推荐：Kafka\n- 延迟（越低越好）：Kafka 12 ms · **RabbitMQ 6 ms**\n- 回溯：Kafka 支持 · RabbitMQ 不支持')
})

test('chart：点少全列出，点多只给首尾和最高最低；null 跳过；带标注', () => {
  const short = convertLucidBlocks(
    json('chart', {
      type: 'line',
      title: 'W5 起反超',
      subtitle: '周活',
      x: ['W1', 'W2', 'W3'],
      series: [{ name: 'iOS', data: [1, null, 3] }],
      annotations: [{ x: 'W2', text: '上线' }],
    }),
  )
  assert.equal(short, '**📈 W5 起反超**\n周活\n- iOS：W1 1 · W3 3\n- 标注 W2：上线\n（桌面端可看图）')
  const x = Array.from({ length: 10 }, (_, i) => `D${i + 1}`)
  const long = convertLucidBlocks(json('chart', { type: 'line', x, series: [{ name: 'QPS', data: [5, 9, 1, 4, 4, 4, 4, 4, 4, 7] }] }))
  assert.match(long, /QPS：D1 5 → D10 7（最高 D2 9，最低 D3 1）/)
})

test('diagram：流程图列出连线和分组、重点；时序图按顺序编号，回复用虚线箭头，备注单列', () => {
  const flow = convertLucidBlocks(
    json('diagram', {
      type: 'flow',
      title: '下单链路',
      groups: [{ id: 'svc', label: '服务层' }],
      nodes: [{ id: 'u', label: '用户' }, { id: 'o', label: '订单服务', group: 'svc' }],
      edges: [{ from: 'u', to: 'o', label: 'HTTPS' }],
      highlight: ['o'],
    }),
  )
  assert.equal(flow, '**🗺 下单链路**\n分组：\n- 服务层：订单服务\n重点：订单服务\n- 用户 → 订单服务（HTTPS）\n（桌面端可看图）')
  const seq = convertLucidBlocks(
    json('diagram', {
      type: 'sequence',
      actors: ['浏览器', '网关'],
      messages: [
        { from: '浏览器', to: '网关', text: 'POST /login' },
        { note: '校验密码', over: '网关' },
        { from: '网关', to: '浏览器', text: 'token', reply: true, highlight: true },
      ],
    }),
  )
  assert.equal(seq, '1. 浏览器 → 网关：POST /login\n   备注（网关）：校验密码\n**2. 网关 ⇢ 浏览器：token**\n（桌面端可看图）')
})

test('认不出的、JSON 写错的、没写完的块原样保留；别的代码块里的示例不动', () => {
  const broken = fence('chart', '{type: line}')
  assert.equal(convertLucidBlocks(broken), broken)
  const missing = json('compare', { columns: ['A'] })
  assert.equal(convertLucidBlocks(missing), missing)
  const unclosed = '说明\n```callout warn\n还没写完'
  assert.equal(convertLucidBlocks(unclosed), unclosed)
  const nested = '````markdown\n```callout warn\n示例\n```\n````'
  assert.equal(convertLucidBlocks(nested), nested)
  const plain = '```bash\nls\n```'
  assert.equal(convertLucidBlocks(plain), plain)
})

test('前后的普通文字保留，块被替换在原位置', () => {
  assert.equal(convertLucidBlocks(`结论在前\n${fence('callout', '注意', 'warn')}\n结尾`), '结论在前\n> **⚠ 注意**\n> 注意\n结尾')
})

test('formatOutgoing：会话回复里的组件转成文字，中转自己的提示不处理', () => {
  assert.equal(formatOutgoing({ from: 'api', text: fence('callout', '先备份', 'warn') }), '**[api]**\n> **⚠ 注意**\n> 先备份')
  const relayText = fence('callout', 'x', 'warn')
  assert.equal(formatOutgoing({ from: 'relay', text: relayText }), relayText)
})
