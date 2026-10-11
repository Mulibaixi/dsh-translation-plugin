import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const forbiddenDirectory = /^(?:node_modules|dist|coverage|\.pnpm-store|design|specs|notes|plans|internal|profiles|logs|data)\/|^docs\/(?:design|specs|notes|plans|internal)\//u
const internalDocument = /^docs\/(?:p0-upstream-contracts|translation-plugin-framework-phase-1)\.md$/u

export function forbiddenStagedPaths(paths) {
  return paths.filter(path => forbiddenDirectory.test(path) || internalDocument.test(path)
    || /(?:^|\/)(?:tests?|__tests__|fixtures|__fixtures__|__snapshots__|test-results|sdk-consumer)(?:\/|$)/u.test(path)
    || /(?:^|\/)[^/]+\.(?:test|spec|integration)(?:\.[^/]+)?$/u.test(path)
    || /^\.cache\//u.test(path)
    || /(?:^|\/)\.env(?:\.|$)/u.test(path) && !path.endsWith('/.env.example') && path !== '.env.example'
    || /\.(?:log|tgz|snap)(?:\.json)?$/u.test(path) || /(?:^|\/)cordis\.patch\.yml\.bak/u.test(path))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const result = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
    cwd: root, encoding: 'utf8',
  })
  if (result.error || result.status !== 0) {
    console.error(result.error?.message ?? result.stderr.trim())
    process.exitCode = 1
  } else {
    const rejected = forbiddenStagedPaths(result.stdout.split('\0').filter(Boolean))
    if (rejected.length) {
      console.error(`暂存区含禁止提交的资料，请移至仓库外或取消暂存：\n${rejected.join('\n')}`)
      process.exitCode = 1
    }
  }
}
