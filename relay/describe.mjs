// 审批卡片上给人看的文字：工具名换成说法，参数一行一个字段。
// 只用于显示；匹配审批（作废「已在电脑上处理」的那条）仍用 summary.mjs 的摘要。

const TOOL_LABELS = {
  Bash: '执行命令',
  PowerShell: '执行命令',
  Edit: '修改文件',
  MultiEdit: '修改文件',
  Write: '写入文件',
  NotebookEdit: '修改笔记本',
  Read: '读取文件',
  WebFetch: '访问网页',
  WebSearch: '搜索网页',
  Agent: '启动子代理',
  Task: '启动子代理',
  Skill: '使用技能',
}

const FIELD_LABELS = {
  command: '命令',
  description: '说明',
  file_path: '文件',
  path: '路径',
  url: '网址',
  query: '搜索',
  title: '标题',
  name: '名称',
  prompt: '内容',
  text: '内容',
  message: '内容',
  cwd: '目录',
  pattern: '匹配',
  skill: '技能',
}
// 排在前面的字段；其余按出现顺序。
const FIELD_ORDER = Object.keys(FIELD_LABELS)
const MAX_LINES = 5
const MAX_VALUE_CHARS = 120
const MAX_COMMAND_CHARS = 300

export function describeTool(tool) {
  if (TOOL_LABELS[tool]) return TOOL_LABELS[tool]
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool ?? '')
  if (mcp) return `${mcp[2].replace(/_/g, ' ')}（${mcp[1]}）`
  return String(tool ?? '')
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)
const oneLine = value => String(value).replace(/\s+/g, ' ').trim()

export function describeInput(tool, input) {
  if (input === null || typeof input !== 'object') return oneLine(input ?? '')
  // 命令本身保留换行，最要紧，放第一行且给更长的长度。
  if (typeof input.command === 'string') {
    const lines = [clip(input.command.trim(), MAX_COMMAND_CHARS)]
    if (typeof input.description === 'string' && input.description.trim()) lines.push(`说明：${oneLine(input.description)}`)
    return lines.join('\n')
  }
  const keys = Object.keys(input)
  const ordered = [...FIELD_ORDER.filter(k => keys.includes(k)), ...keys.filter(k => !FIELD_ORDER.includes(k))]
  const lines = []
  for (const key of ordered) {
    const value = input[key]
    if (value === null || value === undefined || typeof value === 'object') continue
    const text = oneLine(value)
    if (!text) continue
    lines.push(`${FIELD_LABELS[key] ?? key}：${clip(text, MAX_VALUE_CHARS)}`)
    if (lines.length === MAX_LINES) break
  }
  return lines.length ? lines.join('\n') : clip(JSON.stringify(input), MAX_VALUE_CHARS)
}
