import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeInput, describeTool } from '../relay/describe.mjs'

test('工具名：常用内置工具换成中文说法；MCP 工具显示「动作（服务）」；其余原样', () => {
  assert.equal(describeTool('Bash'), '执行命令')
  assert.equal(describeTool('Edit'), '修改文件')
  assert.equal(describeTool('mcp__ccd_session__start_session'), 'start session（ccd_session）')
  assert.equal(describeTool('SomethingNew'), 'SomethingNew')
})

test('命令类：第一行是命令，有说明时第二行写说明', () => {
  assert.equal(describeInput('Bash', { command: 'git push', description: '推送' }), 'git push\n说明：推送')
  assert.equal(describeInput('Bash', { command: 'ls' }), 'ls')
  assert.ok(describeInput('Bash', { command: 'x'.repeat(400) }).endsWith('…'))
})

test('其他参数：一行一个字段，常见字段用中文名排在前面，跳过对象与空值，最多 5 行', () => {
  const text = describeInput('mcp__ccd_session__start_session', {
    initiation: 'user_asked',
    title: 'tpa 发布',
    context: 'fresh',
    cwd: '/w/tpa',
    use_worktree: true,
    nested: { a: 1 },
    empty: '  ',
    prompt: '第一行\n第二行',
  })
  assert.deepEqual(text.split('\n'), ['标题：tpa 发布', '内容：第一行 第二行', '目录：/w/tpa', 'initiation：user_asked', 'context：fresh'])
})

test('没有可显示的字段时退回截断的 JSON；非对象原样', () => {
  assert.equal(describeInput('X', { a: { b: 1 } }), '{"a":{"b":1}}')
  assert.equal(describeInput('X', undefined), '')
})
