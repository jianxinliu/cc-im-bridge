// 把回复里 Lucid 插件的组件代码块（```callout / details / steps / compare / chart / diagram）
// 转成企微里好读的纯文字。桌面端由 Lucid 画成组件；企微不认识这些代码块，原样发过去是一段 JSON。
// 纯函数，无 I/O。代码块格式以 claude-plugins 仓库 plugins/lucid 的技能说明为准；
// 认不出的、JSON 写错的块原样保留，不吞内容。

const LANGS = new Set(['callout', 'details', 'steps', 'compare', 'chart', 'diagram'])

const CALLOUTS = {
  summary: ['◆', '要点'],
  key: ['★', '重点'],
  decide: ['?', '需要你决定'],
  warn: ['⚠', '注意'],
  ok: ['✓', '已核实'],
}

const OPEN = /^(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*(.*)$/

// 逐行扫描：别的代码块里的示例不动；外层 4 个反引号时，里面的 ``` 不会提前结束块。
export function convertLucidBlocks(text) {
  const lines = String(text).split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const open = OPEN.exec(lines[i])
    if (!open) {
      out.push(lines[i++])
      continue
    }
    const fence = open[1]
    const close = findClose(lines, i + 1, fence)
    if (close < 0) {
      out.push(...lines.slice(i))
      break
    }
    const raw = lines.slice(i, close + 1)
    const lang = open[2]
    const converted = LANGS.has(lang) ? convertBlock(lang, open[3].trim(), lines.slice(i + 1, close).join('\n')) : undefined
    out.push(...(converted === undefined ? raw : converted.split('\n')))
    i = close + 1
  }
  return out.join('\n')
}

function findClose(lines, from, fence) {
  const ch = fence[0]
  for (let j = from; j < lines.length; j++) {
    const line = lines[j].trimEnd()
    if (line.length >= fence.length && [...line].every(c => c === ch)) return j
  }
  return -1
}

function convertBlock(lang, info, body) {
  if (lang === 'callout') return callout(info, body)
  if (lang === 'details') return `**▸ ${info || '详情'}**\n${body.trim()}`
  let spec
  try {
    spec = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof spec !== 'object' || spec === null) return undefined
  try {
    if (lang === 'steps') return steps(spec)
    if (lang === 'compare') return compare(spec)
    if (lang === 'chart') return chart(spec)
    if (lang === 'diagram') return spec.type === 'sequence' ? sequence(spec) : flow(spec)
  } catch {
    // 字段缺了或类型不对：保留原样，比发一段残缺的文字强。
    return undefined
  }
  return undefined
}

function callout(info, body) {
  const [first = '', ...rest] = info.split(/\s+/).filter(Boolean)
  const known = Object.hasOwn(CALLOUTS, first)
  const [icon, label] = known ? CALLOUTS[first] : CALLOUTS.key
  const title = (known ? rest.join(' ') : info.trim()) || label
  const quoted = body
    .trim()
    .split('\n')
    .map(l => `> ${l}`)
    .join('\n')
  return `> **${icon} ${title}**${quoted ? `\n${quoted}` : ''}`
}

const titleLine = (emoji, title, extra) => (title ? `**${emoji} ${title}**${extra ? `\n${extra}` : ''}` : extra ?? '')

function steps(spec) {
  const items = spec.steps.map((s, k) => {
    const parts = [`${k + 1}. ${s.title}`]
    if (s.command) parts.push(s.command.includes('\n') ? '```\n' + s.command + '\n```' : `   \`${s.command}\``)
    if (s.detail) parts.push(`   ${s.detail}`)
    return parts.join('\n')
  })
  return [spec.title ? `**${spec.title}**` : undefined, ...items].filter(Boolean).join('\n')
}

function fmt(v, unit) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return `${Number.isInteger(v) ? v.toLocaleString('en-US') : v}${unit ? ` ${unit}` : ''}`
  return String(v)
}

function best(row) {
  if (row.better !== 'higher' && row.better !== 'lower') return new Set()
  const nums = row.values.map(v => (typeof v === 'number' ? v : undefined))
  const present = nums.filter(n => n !== undefined)
  if (present.length < 2) return new Set()
  const target = row.better === 'higher' ? Math.max(...present) : Math.min(...present)
  return new Set(nums.flatMap((n, i) => (n === target ? [i] : [])))
}

function compare(spec) {
  const cols = spec.columns.map(String)
  const rec = typeof spec.recommend === 'number' ? spec.recommend : cols.indexOf(String(spec.recommend))
  const head = [spec.title ? `**${spec.title}**` : undefined, rec >= 0 ? `推荐：${cols[rec]}` : undefined].filter(Boolean)
  const rows = spec.rows.map(r => {
    const b = best(r)
    const hint = r.better === 'higher' ? '，越高越好' : r.better === 'lower' ? '，越低越好' : ''
    const cells = r.values.map((v, i) => {
      const cell = `${cols[i]} ${fmt(v, r.unit)}`
      return b.has(i) ? `**${cell}**` : cell
    })
    return `- ${r.label}${hint ? `（${hint.slice(1)}）` : ''}：${cells.join(' · ')}`
  })
  return [...head, ...rows].join('\n')
}

function chart(spec) {
  const x = spec.x.map(String)
  const lines = spec.series.map(s => {
    const pts = s.data.map((v, i) => [x[i], v]).filter(([, v]) => typeof v === 'number')
    if (pts.length === 0) return `- ${s.name}：无数据`
    // 点少就全列出来；点多时只给首尾和最高、最低，手机上一行看得完。
    if (pts.length <= 8) return `- ${s.name}：${pts.map(([k, v]) => `${k} ${fmt(v)}`).join(' · ')}`
    const [first, last] = [pts[0], pts[pts.length - 1]]
    const hi = pts.reduce((a, b) => (b[1] > a[1] ? b : a))
    const lo = pts.reduce((a, b) => (b[1] < a[1] ? b : a))
    return `- ${s.name}：${first[0]} ${fmt(first[1])} → ${last[0]} ${fmt(last[1])}（最高 ${hi[0]} ${fmt(hi[1])}，最低 ${lo[0]} ${fmt(lo[1])}）`
  })
  const notes = (spec.annotations ?? []).map(a => `- 标注 ${a.x}：${a.text}`)
  const sub = [spec.subtitle, spec.yLabel ? `单位：${spec.yLabel}` : undefined].filter(Boolean).join('；')
  return [titleLine('📈', spec.title, sub || undefined), ...lines, ...notes, '（桌面端可看图）'].filter(Boolean).join('\n')
}

function flow(spec) {
  const label = new Map(spec.nodes.map(n => [n.id, n.label ?? n.id]))
  const edges = (spec.edges ?? []).map(e => `- ${label.get(e.from) ?? e.from} → ${label.get(e.to) ?? e.to}${e.label ? `（${e.label}）` : ''}`)
  const groups = (spec.groups ?? []).map(g => {
    const members = spec.nodes.filter(n => n.group === g.id).map(n => n.label ?? n.id)
    return `- ${g.label ?? g.id}：${members.join('、')}`
  })
  const hl = (spec.highlight ?? []).map(id => label.get(id) ?? id)
  const body = edges.length > 0 ? edges : spec.nodes.map(n => `- ${n.label ?? n.id}`)
  return [
    titleLine('🗺', spec.title),
    groups.length > 0 ? '分组：' : undefined,
    ...groups,
    hl.length > 0 ? `重点：${hl.join('、')}` : undefined,
    ...body,
    '（桌面端可看图）',
  ]
    .filter(Boolean)
    .join('\n')
}

function sequence(spec) {
  let n = 0
  const lines = spec.messages.map(m => {
    if (m.note !== undefined) return `   备注（${[].concat(m.over).join('、')}）：${m.note}`
    n++
    // 回复用虚线箭头，方向仍是从发出方指向接收方。
    const arrow = m.reply ? '⇢' : '→'
    const text = `${n}. ${m.from} ${arrow} ${m.to}：${m.text ?? ''}`
    return m.highlight ? `**${text}**` : text
  })
  return [titleLine('🔁', spec.title), ...lines, '（桌面端可看图）'].filter(Boolean).join('\n')
}
