import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import {
  decryptMedia,
  extractMedia,
  filenameFromDisposition,
  outboundKind,
  safeFilename,
  sniffExtension,
} from '../relay/media.mjs'
import { encryptLikeWecom } from './helpers/wecom-crypto.mjs'

test('解密：与企微加密方式往返一致，含正好 32 字节对齐、空内容；密钥不对时报错', () => {
  const key = randomBytes(32)
  for (const size of [0, 1, 31, 32, 33, 1000]) {
    const plain = randomBytes(size)
    assert.ok(decryptMedia(encryptLikeWecom(plain, key), key.toString('base64')).equals(plain), `size=${size}`)
  }
  const wrong = randomBytes(32).toString('base64')
  assert.throws(() => decryptMedia(encryptLikeWecom(Buffer.from('hello'), key), wrong))
  assert.throws(() => decryptMedia(Buffer.alloc(32), Buffer.alloc(16).toString('base64')), /应为 32 字节/)
})

test('取附件：image、file 消息本身，mixed 里的图片；缺 url 或 aeskey 的跳过', () => {
  assert.deepEqual(extractMedia({ msgtype: 'image', image: { url: 'u1', aeskey: 'k1' } }), [{ kind: 'image', url: 'u1', aeskey: 'k1' }])
  assert.deepEqual(extractMedia({ msgtype: 'file', file: { url: 'u2', aeskey: 'k2' } }), [{ kind: 'file', url: 'u2', aeskey: 'k2' }])
  const mixed = { msgtype: 'mixed', mixed: { msg_item: [{ msgtype: 'text', text: { content: '看图' } }, { msgtype: 'image', image: { url: 'u3', aeskey: 'k3' } }] } }
  assert.deepEqual(extractMedia(mixed), [{ kind: 'image', url: 'u3', aeskey: 'k3' }])
  assert.deepEqual(extractMedia({ msgtype: 'image', image: { url: 'u' } }), [])
  assert.deepEqual(extractMedia({ msgtype: 'text' }), [])
})

test('文件名：Content-Disposition 两种写法；存盘名只取最后一段并去掉危险字符', () => {
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''%E6%97%A5%E5%BF%97.txt"), '日志.txt')
  assert.equal(filenameFromDisposition('attachment; filename="report v2.pdf"'), 'report v2.pdf')
  assert.equal(filenameFromDisposition(undefined), undefined)
  assert.equal(safeFilename('../../etc/passwd', '.bin'), 'passwd')
  assert.equal(safeFilename('.hidden', '.bin'), 'hidden')
  assert.equal(safeFilename('', '.png'), 'attachment.png')
  assert.equal(safeFilename('a\u0000b.txt', '.bin'), 'a_b.txt')
})

test('按内容补扩展名', () => {
  assert.equal(sniffExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), '.png')
  assert.equal(sniffExtension(Buffer.from([0xff, 0xd8, 0xff])), '.jpg')
  assert.equal(sniffExtension(Buffer.from('%PDF-1.7')), '.pdf')
  assert.equal(sniffExtension(Buffer.from('hello')), '.bin')
})

test('发出方式：PNG/JPG 不超过 10MB 按图片；其他不超过 20MB 按文件；更大报错', () => {
  const MB = 1024 * 1024
  assert.deepEqual(outboundKind('a.PNG', 3 * MB), { kind: 'image' })
  assert.deepEqual(outboundKind('a.jpg', 12 * MB), { kind: 'file' }, '图片超 10MB 改按文件发')
  assert.deepEqual(outboundKind('a.gif', MB), { kind: 'file' })
  assert.match(outboundKind('a.zip', 25 * MB).error, /超过企微 20MB/)
})
