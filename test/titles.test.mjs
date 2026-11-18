import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createTitleReader, findTranscript, readLatestTitle } from '../relay/titles.mjs'

const ID = 'a39a2a0c-dca3-4e6f-aee7-1aa03608c1dc'
const line = obj => JSON.stringify(obj) + '\n'

function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'ccim-proj-'))
  mkdirSync(join(dir, '-Users-me-work'))
  mkdirSync(join(dir, '-Users-me-other'))
  const file = join(dir, '-Users-me-work', `${ID}.jsonl`)
  return { dir, file, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('按会话 id 找到记录文件；id 形状不对或不存在时返回 null', () => {
  const p = projects()
  writeFileSync(p.file, '')
  assert.equal(findTranscript(p.dir, ID), p.file)
  assert.equal(findTranscript(p.dir, 'ffffffff-0000-0000-0000-000000000000'), null)
  assert.equal(findTranscript(p.dir, '../../etc/passwd'), null)
  assert.equal(findTranscript(join(p.dir, 'nope'), ID), null)
  p.done()
})

test('取最后一条 custom-title；跳过别的会话、空标题和坏行；超长截断', () => {
  const p = projects()
  writeFileSync(
    p.file,
    line({ type: 'user', message: { content: '"type":"custom-title" 出现在对话内容里不算' } }) +
      line({ type: 'custom-title', customTitle: '旧标题', sessionId: ID }) +
      line({ type: 'custom-title', customTitle: '新  标题', sessionId: ID }) +
      line({ type: 'custom-title', customTitle: '别的会话', sessionId: 'other' }) +
      line({ type: 'custom-title', customTitle: '   ', sessionId: ID }) +
      '{"type":"custom-title", 坏行\n',
  )
  assert.equal(readLatestTitle(p.file, ID), '新 标题')
  appendFileSync(p.file, line({ type: 'custom-title', customTitle: 'x'.repeat(60), sessionId: ID }))
  assert.equal(readLatestTitle(p.file, ID), 'x'.repeat(40) + '…')
  p.done()
})

test('标题在文件末尾 1 MB 之外时整份再找；没有标题返回 undefined', () => {
  const p = projects()
  writeFileSync(p.file, line({ type: 'custom-title', customTitle: '很早的标题', sessionId: ID }) + 'x'.repeat(1.5 * 1024 * 1024) + '\n')
  assert.equal(readLatestTitle(p.file, ID), '很早的标题')
  writeFileSync(p.file, line({ type: 'user' }))
  assert.equal(readLatestTitle(p.file, ID), undefined)
  p.done()
})

test('读取器按修改时间缓存：文件不变不重读，改名后读到新标题', () => {
  const p = projects()
  writeFileSync(p.file, line({ type: 'custom-title', customTitle: '甲', sessionId: ID }))
  const titleOf = createTitleReader(p.dir)
  assert.equal(titleOf(ID), '甲')
  appendFileSync(p.file, line({ type: 'custom-title', customTitle: '乙', sessionId: ID }))
  utimesSync(p.file, new Date(), new Date(Date.now() + 5000))
  assert.equal(titleOf(ID), '乙')
  assert.equal(titleOf('ffffffff-0000-0000-0000-000000000000'), undefined)
  p.done()
})
