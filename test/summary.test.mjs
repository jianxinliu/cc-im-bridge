import assert from 'node:assert/strict'
import { test } from 'node:test'

import { summarizeInput } from '../relay/summary.mjs'

// 与 mod 测试里的期望一致：mod 按同样的摘要作废「已在电脑上处理」的审批。
test('摘要取 command / file_path 等首个字符串字段，否则整段 JSON，超长截断', () => {
  assert.equal(summarizeInput({ command: 'npm publish', description: '发版' }), 'npm publish')
  assert.equal(summarizeInput({ file_path: '/a/b.ts', old_string: 'x' }), '/a/b.ts')
  assert.equal(summarizeInput({ query: 'q' }), '{"query":"q"}')
  assert.equal(summarizeInput(undefined), '{}')
  const long = summarizeInput({ command: 'x'.repeat(1200) })
  assert.equal(long.length, 1001)
  assert.ok(long.endsWith('…'))
})
