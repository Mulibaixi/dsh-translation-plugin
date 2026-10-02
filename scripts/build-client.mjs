import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectDirectory = resolve(scriptDirectory, '..')
const packageJson = JSON.parse(
  await readFile(resolve(projectDirectory, 'package.json'), 'utf8'),
)
const sourceDirectory = await realpath(resolve(projectDirectory, 'src'))
const sourcePath = resolve(sourceDirectory, 'client/index.ts')
const outputPath = resolve(projectDirectory, 'dist/client.js')
const modules = new Map()
const platformExternals = new Set(['react', '@deepseek-ai/dsh-client-ui-primitives'])

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function moduleId(path) {
  const localPath = relative(sourceDirectory, path)
  if (
    isAbsolute(localPath) ||
    localPath === '..' ||
    localPath.startsWith(`..${sep}`)
  ) {
    throw new Error('Client modules must remain inside the src directory')
  }
  return localPath.split(sep).join('/')
}

function requireSpecifiers(source, id) {
  const parsed = ts.createSourceFile(
    id,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  )
  const specifiers = new Set()
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      const argument = node.arguments[0]
      if (node.arguments.length !== 1 || !argument || !ts.isStringLiteral(argument)) {
        throw new Error(`Client module ${id} contains a nonliteral require`)
      }
      specifiers.add(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return [...specifiers].sort(compare)
}

async function collectModule(path) {
  const actualPath = await realpath(path)
  const id = moduleId(actualPath)
  if (modules.has(id)) return id

  const source = await readFile(actualPath, 'utf8')
  const result = ts.transpileModule(source, {
    fileName: actualPath,
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
    throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCurrentDirectory: () => projectDirectory,
      getCanonicalFileName: fileName => fileName,
      getNewLine: () => '\n',
    }))
  }

  const compiled = { body: result.outputText.trimEnd(), dependencies: {} }
  modules.set(id, compiled)
  for (const specifier of requireSpecifiers(compiled.body, id)) {
    if (platformExternals.has(specifier)) continue
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      throw new Error(`Client module ${id} requires unsupported external ${specifier}`)
    }
    let dependencyPath = resolve(dirname(actualPath), specifier)
    const extension = extname(dependencyPath)
    if (extension === '.js') dependencyPath = dependencyPath.slice(0, -3) + '.ts'
    else if (extension === '') dependencyPath += '.ts'
    else if (extension !== '.ts') {
      throw new Error(`Client module ${id} requires unsupported source ${specifier}`)
    }
    moduleId(dependencyPath)
    compiled.dependencies[specifier] = await collectModule(dependencyPath)
  }
  return id
}

const entryId = await collectModule(sourcePath)
const sortedModules = [...modules.entries()].sort(([a], [b]) => compare(a, b))
const clientId = JSON.stringify(packageJson.name)
const moduleFactories = sortedModules.map(([id, compiled]) => [
  `        ${JSON.stringify(id)}: function (exports, require, module) {`,
  compiled.body.split(/\r?\n/).map(line => `          ${line}`).join('\n'),
  '        }',
].join('\n')).join(',\n')
const dependencyMaps = Object.fromEntries(sortedModules.map(([id, compiled]) => [
  id,
  Object.fromEntries(Object.entries(compiled.dependencies).sort(([a], [b]) => compare(a, b))),
]))
const output = [
  'window.__ModuleLoader__.load({',
  `  id: ${clientId},`,
  '  factory: function (require) {',
  '    try {',
  '      const modules = {',
  moduleFactories,
  '      };',
  `      const dependencyMaps = ${JSON.stringify(dependencyMaps)};`,
  '      const cache = Object.create(null);',
  '      function loadModule(id) {',
  '        if (Object.hasOwn(cache, id)) return cache[id].exports;',
  '        if (!Object.hasOwn(modules, id)) throw new Error("Unknown Client module: " + id);',
  '        const module = { exports: {} };',
  '        cache[id] = module;',
  '        const localRequire = function (specifier) {',
  ...[...platformExternals].map(specifier => `          if (specifier === ${JSON.stringify(specifier)}) return require(${JSON.stringify(specifier)});`),
  '          const dependencies = dependencyMaps[id];',
  '          if (!Object.hasOwn(dependencies, specifier)) throw new Error("Unsupported Client dependency: " + specifier);',
  '          return loadModule(dependencies[specifier]);',
  '        };',
  '        try {',
  '          modules[id](module.exports, localRequire, module);',
  '          return module.exports;',
  '        } catch (error) {',
  '          delete cache[id];',
  '          throw error;',
  '        }',
  '      }',
  `      return loadModule(${JSON.stringify(entryId)});`,
  '    } catch (error) {',
  `      console.error(${JSON.stringify(`[${packageJson.name}] Client module evaluation failed:`)}, error !== null && typeof error === "object" && typeof error.stack === "string" ? error.stack : String(error));`,
  '      throw error;',
  '    }',
  '  }',
  '});',
  '',
].join('\n')

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, output, 'utf8')
