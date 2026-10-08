import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

function captureBundle() {
  const registrations = []
  const externalRequests = []
  const diagnostics = []
  const listeners = new Map()
  let storageReads = 0
  const window = {
    __ModuleLoader__: { load: entry => registrations.push(entry) },
    addEventListener(name, listener) {
      const entries = listeners.get(name) ?? new Set()
      entries.add(listener)
      listeners.set(name, entries)
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener)
    },
  }
  const sandbox = {
    window,
    console: { error: (...details) => diagnostics.push(details) },
  }
  Object.defineProperty(window, 'localStorage', {
    get() {
      storageReads += 1
      throw new Error('Storage must not be read while evaluating the Client module')
    },
  })
  vm.runInNewContext(source, sandbox, { filename: 'dist/client.js' })
  const entry = registrations[0]
  assert.ok(entry, 'bundle registers a lazy Client factory')
  const exports = entry.factory(specifier => {
    externalRequests.push(specifier)
    assert.ok(['react', '@deepseek-ai/dsh-client-ui-primitives'].includes(specifier), 'only inspected platform modules come from the DSH loader')
    return specifier === 'react' ? { createElement: (type, props, ...children) => ({ type, props, children }) }
      : { MenuSurface: 'div', MenuGroup: 'section' }
  })
  return {
    registrations,
    externalRequests,
    diagnostics,
    listeners,
    exports,
    storageReads: () => storageReads,
  }
}

test('客户端 bundle 只登记一个包标识，初始化不读取本地存储', () => {
  const bundle = captureBundle()
  assert.equal(bundle.registrations.length, 1)
  assert.equal(bundle.registrations[0].id, packageJson.name)
  assert.equal(bundle.registrations[0].id, 'dsh-translation-plugin')
  assert.equal(typeof bundle.exports.apply, 'function')
  assert.deepEqual(Array.from(bundle.exports.inject), ['sidebarRightTabs', 'sidebarRight', 'slots', 'remote', 'remote.session', 'fileUpload', 'conversation'])
  assert.ok(bundle.externalRequests.every(specifier => ['react', '@deepseek-ai/dsh-client-ui-primitives'].includes(specifier)))
  assert.equal(bundle.storageReads(), 0)
  assert.deepEqual(bundle.diagnostics, [])
})

test('模块初始化失败保留原异常和诊断堆栈', () => {
  const entries = []
  const diagnostics = []
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: entry => entries.push(entry) } },
    console: { error: (...details) => diagnostics.push(details) },
  })
  const failure = new Error('React dependency failed during initialization')
  assert.throws(() => entries[0].factory(() => { throw failure }), error => error === failure)
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0][0], `[${packageJson.name}] Client module evaluation failed:`)
  assert.equal(diagnostics[0][1], failure.stack)
})

test('客户端注册会话面板和全局设置页，并正常注销全部贡献', () => {
  const { exports, listeners } = captureBundle()
  const tabDefinitions = []
  const slots = []
  const effects = []
  const liveTabs = new Set()
  const liveSlots = new Set()
  const context = {
    remote: { session: { modelCatalog() { throw new Error('catalog is loaded only when requested') } }, $on() { return () => {} } },
    on() { return () => {} },
    sidebarRight: { openTabs: { getSnapshot: () => [] }, mounted: { getSnapshot: () => undefined }, float() {} },
    sidebarRightTabs: {
      register(definition) {
        assert.ok(!Array.isArray(definition), 'register receives one tab definition')
        tabDefinitions.push(definition)
        liveTabs.add(definition.id)
        return () => liveTabs.delete(definition.id)
      },
    },
    slots: {
      inject(name, register) {
        assert.equal(typeof name, 'string')
        return register()
      },
      register(options, component) {
        assert.equal(typeof component, 'function')
        const identity = `${options.name}:${options.key ?? options.id}`
        assert.ok(!liveSlots.has(identity), 'a slot contribution is registered once')
        slots.push({ options, component })
        liveSlots.add(identity)
        return () => liveSlots.delete(identity)
      },
    },
    effect(effect, name) {
      const dispose = effect()
      assert.equal(typeof dispose, 'function', `effect ${name ?? ''} owns a disposer`)
      effects.push(dispose)
      return dispose
    },
  }

  exports.apply(context)
  assert.equal(tabDefinitions.length, 2)
  const definition = tabDefinitions[0]
  assert.equal(definition.id, packageJson.name)
  assert.equal(definition.kind, 'translation-workspace')
  assert.equal(definition.keepMounted, true)
  const assetsDefinition = tabDefinitions.find(definition => definition.id === 'dsh-translation-plugin/memory-assets')
  assert.equal(assetsDefinition.kind, 'translation-memory-assets'); assert.equal(assetsDefinition.keepMounted, true)
  assert.equal(assetsDefinition.title(), '记忆资产'); assert.equal(typeof assetsDefinition.canOpen, 'function')
  assert.ok(Array.isArray(definition.guide))
  assert.equal(definition.guide.length, 1)
  assert.equal(definition.guide[0].id, 'translation-workspace')
  assert.equal(typeof definition.guide[0].title, 'function')
  assert.deepEqual(slots.map(entry => entry.options.name).sort(), [
    'conversation.input.left',
    'settings.section',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
  ])
  const panel = slots.find(entry => entry.options.name === 'sidebar.right.pane.tab')
  const settings = slots.find(entry => entry.options.name === 'settings.section')
  assert.equal(panel.options.key, packageJson.name)
  const assets = slots.find(entry => entry.options.name === 'sidebar.right.pane.tab' && entry.options.key === 'dsh-translation-plugin/memory-assets')
  assert.ok(assets); assert.notEqual(assets.component, panel.component)
  assert.ok(slots.some(entry => entry.options.name === 'sidebar.right.pane.tab.title' && entry.options.key === 'dsh-translation-plugin/memory-assets'))
  assert.equal(settings.options.id, packageJson.name)
  const label = settings.options.label
  assert.equal(typeof label === 'function' ? label() : label, '翻译')
  assert.ok(effects.length >= 3, 'registrations and store lifetime are owned by effects')
  assert.equal(listeners.get('storage')?.size, 1, 'apply owns one storage-event listener')

  for (const dispose of effects.toReversed()) dispose()
  assert.equal(liveTabs.size, 0)
  assert.equal(liveSlots.size, 0)
  assert.equal(listeners.get('storage')?.size, 0, 'store disposal removes its storage-event listener')
})

test('客户端生成代码只使用静态本地依赖及已核实的 DSH 平台 UI，不包含 Node 宿主接口', () => {
  const parsed = ts.createSourceFile('client.js', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const dependencies = []
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      assert.equal(node.arguments.length, 1)
      const specifier = node.arguments[0]
      assert.ok(ts.isStringLiteral(specifier), 'require is always a static string')
      dependencies.push(specifier.text)
    }
    if (ts.isIdentifier(node)) {
      assert.ok(!['process', 'Buffer', '__dirname', '__filename'].includes(node.text),
        `Node global ${node.text} must not enter the Client bundle`)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(dependencies.length > 0)
  assert.ok(dependencies.every(specifier => ['react', '@deepseek-ai/dsh-client-ui-primitives'].includes(specifier) || /^\.{1,2}\//.test(specifier)))
  assert.ok(!source.includes('node:'))
  assert.ok(!source.includes('node_modules'))
})
