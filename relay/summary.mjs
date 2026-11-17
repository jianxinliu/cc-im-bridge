// 审批请求在 IM 里显示的一行摘要。mod（hooks/register.ts）里有一份相同的实现，
// 两边算出的摘要必须一致，mod 才能按摘要作废「已在电脑上处理」的那条审批；
// test/summary.test.mjs 与 mod 的测试用同一组样例约束两者。
export const MAX_SUMMARY_CHARS = 1000
const SUMMARY_FIELDS = ['command', 'file_path', 'url', 'path', 'pattern']

export function summarizeInput(input) {
  const fields = input ?? {}
  const text = SUMMARY_FIELDS.map(k => fields[k]).find(v => typeof v === 'string') ?? JSON.stringify(input ?? {})
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text
}
