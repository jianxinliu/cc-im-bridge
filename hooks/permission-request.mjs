#!/usr/bin/env node
// Claude Code 的 PermissionRequest 钩子（在 ~/.claude/settings.json 里登记）。
// 只在 Claude Code 真要弹框问人时触发。会话开着转发（IM 发起的回合或离开模式）时，
// 把这次审批发到 IM 并等答复；其余情况、中转没在跑或出错时，不输出任何东西，照常本地弹框。
// 在 Desktop 这类托管会话里本地弹框与本钩子同时进行，谁先答复以谁为准。
import http from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describeInput } from '../relay/describe.mjs'
import { summarizeInput } from '../relay/summary.mjs'

const SOCKET = join(process.env.CC_IM_HOME ?? join(homedir(), '.cc-im-bridge'), 'relay.sock')
// 这两类要用 updatedInput 带回答案，IM 答不了，交给本地。
const PERSON_ONLY_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const LONG_POLL_MS = Number(process.env.CC_IM_LONG_POLL_MS ?? 25_000)
// 24 次 × 25 秒约 10 分钟，settings 里的 timeout 要比它长。
const MAX_POLLS = Number(process.env.CC_IM_MAX_POLLS ?? 24)

function call(path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      res => {
        let text = ''
        res.on('data', c => (text += c))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, ...JSON.parse(text) })
          } catch {
            reject(new Error(`${path} 返回的不是 JSON：${text.slice(0, 200)}`))
          }
        })
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', c => (text += c))
    process.stdin.on('end', () => resolve(text))
    process.stdin.on('error', reject)
  })
}

const decision = d => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } })

// 返回要写到 stdout 的文本；空字符串表示不做决定。
export async function decide(event) {
  const { session_id: sessionId, tool_name: tool, tool_input: input, agent_id: agentId } = event
  if (!sessionId || !tool || PERSON_ONLY_TOOLS.has(tool) || agentId) return ''
  const req = await call('/hook/permission', {
    sessionId,
    tool,
    summary: summarizeInput(input),
    detail: describeInput(tool, input),
  })
  if (!req.ok || !req.forward || req.id === undefined) return ''
  const id = req.id
  for (let i = 0; i < MAX_POLLS; i++) {
    const r = await call('/mod/approval/wait', { id, timeoutMs: LONG_POLL_MS })
    if (!r.ok || !r.approval) throw new Error(`查询审批 #${id} 失败：${r.error ?? r.status}`)
    const { state, reason } = r.approval
    if (state === 'approved') return decision({ behavior: 'allow' })
    if (state === 'denied') {
      return decision({ behavior: 'deny', message: `用户在 IM 拒绝了（#${id}）${reason ? `：${reason}` : ''}` })
    }
    if (state !== 'pending') return ''
  }
  await call('/mod/approval/cancel', { id, why: '10 分钟未答复，转回电脑上审批' })
  return ''
}

async function main() {
  let event
  try {
    event = JSON.parse(await readStdin())
  } catch (err) {
    process.stderr.write(`cc-im-bridge：读不懂钩子输入，交回本地审批：${err.message}\n`)
    return
  }
  try {
    const out = await decide(event)
    if (out) process.stdout.write(out + '\n')
  } catch (err) {
    // 中转没在跑（ENOENT/ECONNREFUSED）是常态，不刷 stderr。
    if (!['ENOENT', 'ECONNREFUSED'].includes(err.code)) {
      process.stderr.write(`cc-im-bridge：审批转发失败，交回本地审批：${err.message}\n`)
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
