import { spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function git(args, allowMissing = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error || result.status !== 0 && !(allowMissing && result.status === 1)) {
    throw new Error(result.error?.message ?? result.stderr.trim())
  }
  return result.stdout.trim()
}

try {
  const gitRoot = resolve(git(['rev-parse', '--show-toplevel']))
  const sameRoot = process.platform === 'win32'
    ? gitRoot.toLowerCase() === root.toLowerCase() : gitRoot === root
  if (!sameRoot) throw new Error('只能在插件自身的 Git 仓库安装 hooks。')
  const configuredPath = git(['config', '--get', 'core.hooksPath'], true)
  if (configuredPath && configuredPath !== '.githooks') {
    throw new Error(`已有 hooks 路径 ${configuredPath}，请先核对既有配置；本次未覆盖。`)
  }
  if (process.platform !== 'win32') {
    for (const name of ['pre-commit', 'commit-msg']) chmodSync(resolve(root, '.githooks', name), 0o755)
  }
  git(['config', '--local', 'core.hooksPath', '.githooks'])
  console.log('已为本插件仓库启用暂存文件和中文提交信息校验。')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
