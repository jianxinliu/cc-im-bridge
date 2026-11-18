// 企微图片、文件的收发：解析消息里的附件、解密下载内容、起文件名、决定按图片还是文件发出。
// 协议依据：官方 SDK @wecom/aibot-node-sdk 1.0.7 的 decryptFile、downloadFileRaw、uploadMedia。
import { createDecipheriv } from 'node:crypto'
import { basename, extname } from 'node:path'

export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
// 与腾讯官方 OpenClaw 企微插件的限制一致：图片 10MB，文件 20MB。
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_FILE_BYTES = 20 * 1024 * 1024
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg'])

// 消息里的附件：image / file 消息本身，以及 mixed 消息里的图片。视频暂不收。
export function extractMedia(body) {
  const items = []
  const add = (kind, part) => {
    if (part?.url && part?.aeskey) items.push({ kind, url: part.url, aeskey: part.aeskey })
  }
  if (body?.msgtype === 'image') add('image', body.image)
  else if (body?.msgtype === 'file') add('file', body.file)
  else if (body?.msgtype === 'mixed') {
    for (const item of body.mixed?.msg_item ?? []) if (item.msgtype === 'image') add('image', item.image)
  }
  return items
}

// AES-256-CBC，密钥为 aeskey 的 base64 解码，IV 取密钥前 16 字节；
// 填充是按 32 字节对齐的 PKCS#7，Node 默认按 16 字节去填充会出错，所以手动去。
export function decryptMedia(encrypted, aesKey) {
  const key = Buffer.from(aesKey, 'base64')
  if (key.length !== 32) throw new Error(`aeskey 解码后应为 32 字节，实际 ${key.length}`)
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()])
  const pad = plain[plain.length - 1]
  if (!pad || pad > 32 || pad > plain.length) throw new Error(`解密后填充值不对：${pad}`)
  for (let i = plain.length - pad; i < plain.length; i++) {
    if (plain[i] !== pad) throw new Error('解密后填充字节不一致，可能是 aeskey 不对')
  }
  return plain.subarray(0, plain.length - pad)
}

export function filenameFromDisposition(header) {
  if (!header) return undefined
  const utf8 = /filename\*=UTF-8''([^;\s]+)/i.exec(header)
  const plain = /filename="?([^";]+)"?/i.exec(header)
  const raw = utf8?.[1] ?? plain?.[1]
  if (!raw) return undefined
  try {
    return decodeURIComponent(raw.trim())
  } catch {
    return raw.trim()
  }
}

// 没有文件名时按内容开头的特征补扩展名。
export function sniffExtension(buffer) {
  const head = buffer.subarray(0, 12)
  if (head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') return '.png'
  if (head[0] === 0xff && head[1] === 0xd8) return '.jpg'
  if (head.toString('latin1', 0, 4) === 'GIF8') return '.gif'
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return '.webp'
  if (head.toString('latin1', 0, 4) === '%PDF') return '.pdf'
  if (head[0] === 0x50 && head[1] === 0x4b) return '.zip'
  return '.bin'
}

// 存盘用的安全文件名：只取最后一段，去掉路径分隔和控制字符，限制长度。
export function safeFilename(name, fallbackExt) {
  const base = basename(String(name ?? '')).replace(/[\/\\\p{Cc}]/gu, '_').replace(/^\.+/, '').trim()
  const cleaned = base.slice(-80)
  if (cleaned) return cleaned
  return `attachment${fallbackExt}`
}

// 发到企微时按图片还是文件发；超过上限返回 error。
export function outboundKind(filename, size) {
  const isImage = IMAGE_EXTS.has(extname(filename).toLowerCase())
  if (isImage && size <= MAX_IMAGE_BYTES) return { kind: 'image' }
  if (size <= MAX_FILE_BYTES) return { kind: 'file' }
  return { error: `文件 ${(size / 1024 / 1024).toFixed(1)}MB，超过企微 20MB 的上限` }
}
