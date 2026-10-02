import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const headerPattern = /^(feat|fix|docs|refactor|perf|test|build|ci|chore|revert)(?:\([a-z0-9]+(?:-[a-z0-9]+)*\))?!?: (\S.*)$/u
const chinesePattern = /\p{Script=Han}/u
const trailerPattern = /^(?:Signed-off-by|Co-authored-by|Reviewed-by|Tested-by|Acked-by|Refs|Closes|Fixes):\s|^(?:Refs|Closes|Fixes)\s#/iu

export function validateCommitMessage(message) {
  const lines = message.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
    .split('\n').filter(line => !line.startsWith('#'))
  while (lines.at(-1) === '') lines.pop()
  const header = lines[0] ?? ''
  const match = headerPattern.exec(header)
  const errors = []
  if (!match) errors.push('标题须为 type(scope): 中文描述；scope 可省略，破坏性变更可添加 !。')
  if ([...header].length > 72) errors.push('标题不得超过 72 个 Unicode 字符。')
  if (header !== header.trim()) errors.push('标题不得有首尾空白。')
  if (/[。.]$/u.test(header)) errors.push('标题不得以句号结尾。')
  if (match && !chinesePattern.test(match[2])) errors.push('标题描述必须包含中文。')
  if (lines.length > 1 && lines[1] !== '') errors.push('正文或 footer 与标题之间必须空一行。')
  const bodyLines = lines.slice(2).filter(line => line.trim() && !trailerPattern.test(line))
  if (bodyLines.length && !chinesePattern.test(bodyLines.join('\n'))) {
    errors.push('正文使用中文；技术标识符和标准 Git trailer 可以保留英文。')
  }
  for (const line of lines.slice(2)) {
    if (/^BREAKING[ -]CHANGE:/u.test(line) && !chinesePattern.test(line)) {
      errors.push('BREAKING CHANGE 的说明必须包含中文。')
    }
  }
  return errors
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const messagePath = process.argv[2]
  try {
    if (!messagePath) throw new Error('请提供提交信息文件路径，例如：pnpm check:commit message.txt')
    const errors = validateCommitMessage(readFileSync(messagePath, 'utf8'))
    if (errors.length) throw new Error(errors.join('\n'))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
