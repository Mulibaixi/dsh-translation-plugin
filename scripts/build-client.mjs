import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectDirectory = resolve(scriptDirectory, '..')
const packageJson = JSON.parse(
  await readFile(resolve(projectDirectory, 'package.json'), 'utf8'),
)
const sourcePath = resolve(projectDirectory, 'src/client/index.ts')
const outputPath = resolve(projectDirectory, 'dist/client.js')
const source = await readFile(sourcePath, 'utf8')

const result = ts.transpileModule(source, {
  fileName: sourcePath,
  reportDiagnostics: true,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    strict: true,
    removeComments: true,
  },
})

const errors = (result.diagnostics ?? []).filter(
  diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
)

if (errors.length > 0) {
  const message = ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => projectDirectory,
    getCanonicalFileName: fileName => fileName,
    getNewLine: () => '\n',
  })
  throw new Error(message)
}

const clientId = JSON.stringify(packageJson.name)
const compiledBody = result.outputText
  .trimEnd()
  .split(/\r?\n/)
  .map(line => `        ${line}`)
  .join('\n')
const output = [
  'window.__ModuleLoader__.load({',
  `  id: ${clientId},`,
  '  factory: function (require) {',
  '    const module = { exports: {} };',
  '    const exports = module.exports;',
  '    try {',
  '      (function (exports, require, module) {',
  compiledBody,
  '      })(exports, require, module);',
  '      return module.exports;',
  '    } catch (error) {',
  `      console.error(${JSON.stringify(`[${packageJson.name}] Client module evaluation failed:`)}, error instanceof Error ? error.stack ?? error.message : String(error));`,
  '      throw error;',
  '    }',
  '  }',
  '});',
  '',
].join('\n')

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, output, 'utf8')
