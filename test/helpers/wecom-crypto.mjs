// 测试用：按企微的方式加密附件（AES-256-CBC，IV 为密钥前 16 字节，PKCS#7 按 32 字节对齐）。
import { createCipheriv } from 'node:crypto'

export function encryptLikeWecom(plain, key) {
  const pad = 32 - (plain.length % 32)
  const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)])
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()])
}
