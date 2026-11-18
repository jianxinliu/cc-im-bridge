// 会话在 Desktop 侧边栏上的标题。Claude Code 把它以 {"type":"custom-title","customTitle":…}
// 一行写进会话记录文件（~/.claude/projects/<目录>/<会话 id>.jsonl），改名时追加新的一行，以最后一行为准。
// 这里只读标题这一个字段，不读对话内容。
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TAIL_BYTES = 1 << 20
const TITLE_MARK = '"type":"custom-title"'
const MAX_TITLE_CHARS = 40

export const defaultProjectsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')

// 会话 id 只会是 uuid 形状；先校验，避免拼出越界路径。
const SESSION_ID = /^[0-9a-f-]{8,64}$/i

export function findTranscript(projectsDir, sessionId) {
  if (!SESSION_ID.test(sessionId)) return null
  let dirs
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const file = join(projectsDir, d.name, `${sessionId}.jsonl`)
    if (existsSync(file)) return file
  }
  return null
}

// 读文件末尾一段，取最后一条标题。Desktop 每轮都会重写一次标题，末尾 1 MB 里基本总能找到；
// 找不到就整个文件再找一遍。
export function readLatestTitle(file, sessionId) {
  const size = statSync(file).size
  const fromTail = lastTitleIn(readRange(file, Math.max(0, size - TAIL_BYTES), size), sessionId)
  if (fromTail !== undefined || size <= TAIL_BYTES) return fromTail
  return lastTitleIn(readRange(file, 0, size), sessionId)
}

function readRange(file, start, end) {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(end - start)
    readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function lastTitleIn(text, sessionId) {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(TITLE_MARK)) continue
    try {
      const entry = JSON.parse(lines[i])
      if (entry.type !== 'custom-title' || (entry.sessionId && entry.sessionId !== sessionId)) continue
      const title = String(entry.customTitle ?? '').replace(/\s+/g, ' ').trim()
      if (title) return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS)}…` : title
    } catch {
      // 读的是文件末尾一段，第一行可能被截断；跳过它继续往前找
    }
  }
  return undefined
}

// 按会话缓存文件路径与修改时间，文件没变就不重读。
export function createTitleReader(projectsDir = defaultProjectsDir()) {
  const cache = new Map() // sessionId -> { file, mtimeMs, title }
  return function titleOf(sessionId) {
    let entry = cache.get(sessionId)
    if (!entry || !existsSync(entry.file)) {
      const file = findTranscript(projectsDir, sessionId)
      if (!file) return undefined
      entry = { file, mtimeMs: -1, title: undefined }
      cache.set(sessionId, entry)
    }
    const { mtimeMs } = statSync(entry.file)
    if (mtimeMs !== entry.mtimeMs) {
      entry.title = readLatestTitle(entry.file, sessionId)
      entry.mtimeMs = mtimeMs
    }
    return entry.title
  }
}
