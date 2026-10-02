import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const bundleSource = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')
const SETTINGS_KEY = 'dsh-translation-plugin:settings:v2'
const HISTORY_PREFIX = 'dsh-translation-plugin:history:v2:'

class FakeStorage {
  values = new Map()
  failRemove = false
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) {
    if (this.failRemove) throw new Error('存储删除被阻止')
    this.values.delete(key)
  }
}

function settings(overrides = {}) {
  return {
    schemaVersion: 2, defaultMode: 'quick',
    targetLanguage: '中文', defaultInstruction: '', maxInputChars: 20000,
    rememberHistory: false, ...overrides,
  }
}

// 验证发布 bundle 中实际事件处理器；此轻量 hook 模拟器不替代 React 或桌面运行验证。
function createRenderer() {
  const seats = new Map()
  const typeIds = new Map()
  let nextType = 0
  let active
  let used
  let pendingEffects
  let rootComponent
  let rootProps
  let tree
  let dirty = false
  let renderDepth = 0

  function hook(initial) {
    assert.ok(active, 'hooks run within a component')
    const index = active.index++
    if (!(index in active.hooks)) active.hooks[index] = initial()
    return active.hooks[index]
  }

  const react = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      const cell = hook(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [cell.value, next => { const value = typeof next === 'function' ? next(cell.value) : next; if (!Object.is(value, cell.value)) dirty = true; cell.value = value }]
    },
    useRef(initial) { return hook(() => ({ current: initial })) },
    useEffect(effect, dependencies) {
      const cell = hook(() => ({ dependencies: undefined, cleanup: undefined }))
      const changed = !cell.dependencies || cell.dependencies.length !== dependencies.length ||
        dependencies.some((value, index) => !Object.is(value, cell.dependencies[index]))
      if (changed) {
        cell.dependencies = [...dependencies]
        pendingEffects.push(() => { cell.cleanup?.(); cell.cleanup = effect() })
      }
    },
  }

  function resolve(node, path) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (Array.isArray(node)) return node.map((child, index) => resolve(child, `${path}.${index}`))
    if (typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      if (!typeIds.has(node.type)) typeIds.set(node.type, ++nextType)
      const identity = `${path}:${typeIds.get(node.type)}:${node.props.key ?? ''}`
      let seat = seats.get(identity)
      if (!seat) { seat = { hooks: [], index: 0 }; seats.set(identity, seat) }
      used.add(identity)
      seat.index = 0
      const previous = active
      active = seat
      let result
      try { result = node.type({ ...node.props, children: node.children }) }
      finally { active = previous }
      return resolve(result, `${path}.rendered`)
    }
    return { ...node, children: node.children.map((child, index) => resolve(child, `${path}.${index}`)) }
  }

  function render(component = rootComponent, props = rootProps) {
    assert.ok(renderDepth < 10, 'render settles')
    dirty = false
    rootComponent = component
    rootProps = props
    used = new Set()
    pendingEffects = []
    tree = resolve(react.createElement(component, props), 'root')
    for (const [identity, seat] of seats) {
      if (!used.has(identity)) {
        for (const cell of seat.hooks) cell.cleanup?.()
        seats.delete(identity)
      }
    }
    for (const effect of pendingEffects) effect()
    if (dirty) { renderDepth++; const result = render(); renderDepth--; return result }
    return tree
  }

  function nodes(node = tree) {
    if (Array.isArray(node)) return node.flatMap(child => nodes(child))
    if (node === null || typeof node !== 'object') return []
    if (node.props.hidden) return []
    return [node, ...node.children.flatMap(child => nodes(child))]
  }

  function text(node = tree) {
    if (Array.isArray(node)) return node.map(child => text(child)).join('')
    if (node === null || node === undefined) return ''
    if (typeof node !== 'object') return String(node)
    if (node.type === 'style' || node.props.hidden) return ''
    return node.children.map(child => text(child)).join('')
  }

  function control(label) {
    let named = nodes().find(node => ['input', 'textarea', 'select'].includes(node.type) && node.props['aria-label'] === label)
    if (!named && label === '目标语言' && nodes().some(node => node.props['aria-label'] === '选择目标语言')) {
      button('选择目标语言').props.onClick(); render()
      named = nodes().find(node => node.type === 'input' && node.props['aria-label'] === label)
    }
    if (named) return named
    const field = nodes().find(node => node.type === 'label' &&
      node.children[0]?.type === 'span' && text(node.children[0]) === label)
    assert.ok(field, `field exists: ${label}`)
    const result = nodes(field).find(node => ['input', 'textarea', 'select'].includes(node.type))
    assert.ok(result, `control exists: ${label}`)
    return result
  }

  function button(label) {
    const result = nodes().find(node => node.type === 'button' && node.props['aria-label'] === label)
      ?? nodes().find(node => node.type === 'button' && text(node) === label)
    assert.ok(result, `button exists: ${label}`)
    return result
  }

  return {
    react, render, text, control, button, nodes,
    input(label, value) {
      if (label === '翻译模式' && nodes().some(node => node.props['aria-label'] === '选择翻译模式')) {
        button('选择翻译模式').props.onClick(); render(); button(value === 'quick' ? '快译' : '普通').props.onClick(); render(); return
      }
      control(label).props.onChange({ currentTarget: { value } }); render()
    },
    context(target) {
      const node = typeof target === 'string' ? button(target) : target
      assert.equal(typeof node.props.onContextMenu, 'function')
      let prevented = false
      node.props.onContextMenu({ clientX: 150, clientY: 90, preventDefault() { prevented = true }, stopPropagation() {} }); render()
      assert.equal(prevented, true)
    },
    click(label) {
      const target = button(label)
      assert.ok(!target.props.disabled, `button is enabled: ${label}`)
      target.props.onClick(); render()
    },
    remember(value) {
      const checkbox = nodes().find(node => node.type === 'input' && node.props.type === 'checkbox')
      assert.ok(checkbox)
      checkbox.props.onChange({ currentTarget: { checked: value } }); render()
    },
    dispose() {
      for (const seat of seats.values()) for (const cell of seat.hooks) cell.cleanup?.()
      seats.clear()
    },
  }
}

function mount(overrides = {}) {
  const storage = new FakeStorage()
  if (overrides.settings) storage.setItem(SETTINGS_KEY, JSON.stringify(overrides.settings))
  for (const session of overrides.history ?? []) storage.setItem(HISTORY_PREFIX + encodeURIComponent(session.id), JSON.stringify({ schemaVersion: 2, token: session.id, session }))
  storage.failSet = !!overrides.failSet
  if (storage.failSet) storage.setItem = () => { throw new Error('quota') }
  const renderer = createRenderer()
  const entries = []; const effects = []; const slots = new Map(); const listeners = new Set()
  let catalogCalls = 0
  const catalogResponse = overrides.catalog ?? { ok: true, value: { default: { provider: 'provider-a', model: 'm1' }, routableProviders: ['provider-a'], groups: [{ id: 'provider-a', name: 'Provider A', models: Array.from({ length: 6 }, (_, i) => ({ id: 'm' + (i + 1), name: 'Model ' + (i + 1) })) }], failures: [] } }
  const window = { localStorage: storage, __ModuleLoader__: { load(entry) { entries.push(entry) } }, addEventListener(_name, listener) { listeners.add(listener) }, removeEventListener(_name, listener) { listeners.delete(listener) } }
  const context = vm.createContext({ window, console, document: { addEventListener() {}, removeEventListener() {} }, Node: class {} })
  vm.runInContext(bundleSource, context)
  const exported = entries[0].factory(specifier => {
    if (specifier === 'react') return renderer.react
    assert.equal(specifier, '@deepseek-ai/dsh-client-ui-primitives')
    const h = renderer.react.createElement
    const icon = name => props => h('svg', { ...props, 'data-native-icon': name })
    return {
      Menu: props => h('div', { className: props.className, 'data-native-menu': true }, props.anchor,
        props.open ? h('div', { role: 'menu', className: props.listClassName, 'data-portal': props.portal, 'data-side': props.side, 'data-align': props.align, 'data-compact': props.compact, onClose: props.onClose }, props.children) : null),
      MenuItemButton: props => h('button', { type: 'button', role: 'menuitem', disabled: props.disabled, onClick: props.onSelect }, props.children),
      MenuGroup: props => h('section', { 'aria-label': props.label }, props.children),
      IconChevronDownOutlineRegular: icon('chevron-down'), IconChevronRightOutlineRegular: icon('chevron-right'),
      IconPanelLeftOutlineRegular: icon('panel-left'), IconSendOutlineMedium: icon('send'),
    }
  })
  exported.apply({
    remote: { session: { async modelCatalog() { catalogCalls++; return catalogResponse }, selectModel() { throw new Error('main chat selection must remain independent') } }, $on() { return () => {} } },
    on() { return () => {} }, sidebarRightTabs: { register() { return () => {} } },
    slots: { register(target, component) { slots.set(target.name, component); return () => slots.delete(target.name) }, inject(_name, register) { return register() } },
    effect(effect) { const cleanup = effect(); effects.push(cleanup); return cleanup },
  })
  return { renderer, storage, panel: slots.get('sidebar.right.pane.tab'), settingsPage: slots.get('settings.section'),
    get catalogCalls() { return catalogCalls },
    changeStorage(key, raw) { storage.setItem(key, raw); for (const listener of listeners) listener({ key, storageArea: storage }); renderer.render() },
    dispose() { renderer.dispose(); for (const effect of effects.toReversed()) effect?.() },
  }
}
function fixture(id, name, mode = 'quick') { return { schemaVersion: 2, id, ownerId: 'main-a', name, parentId: null, childSequence: 0, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', mode, targetLanguage: '中文', instruction: '', maxInputChars: 20000, model: null, input: '', legacyManualText: '', legacyKey: null } }
function saved(app) { return [...app.storage.values.entries()].filter(([key]) => key.startsWith(HISTORY_PREFIX)).map(([, raw]) => JSON.parse(raw).session) }
function checkbox(ui, label, checked) { const node = ui.control(label); node.props.onChange({ currentTarget: { checked } }); ui.render() }
function currentTitle(ui) { return ui.nodes().find(node => node.props.className === 'dsh-tp-current-title' && node.type === 'button') }
function openSessionMenu(ui) { const trigger = currentTitle(ui); if (!trigger.props['aria-expanded']) { trigger.props.onClick(); ui.render() } }
function newSession(ui) {
  openSessionMenu(ui)
  const item = ui.nodes().find(node => node.type === 'button' && node.props.role === 'menuitem' && node.props['aria-label'] === '新建翻译会话')
  assert.ok(item); item.props.onClick(); ui.render()
}
function rename(ui, value) { ui.context(currentTitle(ui)); ui.click('重命名'); ui.input('会话名称', value); ui.click('确认重命名') }
const tick = () => new Promise(resolve => setImmediate(resolve))

test('面板没有大标题或设置入口，无主会话时不开放输入', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, {})
  assert.match(ui.text(), /请在主窗口会话中打开/); assert.equal(ui.nodes().some(node => node.type === 'textarea'), false)
  ui.render(app.panel, { sessionId: 'main-a' }); assert.equal(ui.nodes().some(node => node.type === 'h2'), false)
  assert.equal(ui.nodes().some(node => node.type === 'button' && ui.text(node) === '翻译设置'), false)
  assert.equal(ui.button('发送（翻译执行尚未接入）').props.disabled, true)
  assert.ok(ui.nodes().some(node => node.props.className === 'dsh-tp-transcript'))
  app.dispose()
})
test('设置即时保存四项默认值，恢复入口在顶部，无保存、重读或模型设置', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.settingsPage, {})
  assert.match(ui.text(), /新会话默认值/); assert.match(ui.text(), /会话历史保存/)
  ui.input('目标语言', 'English'); ui.input('翻译要求', '保留术语'); ui.input('单次上限', '500'); ui.input('翻译模式', 'normal')
  const value = JSON.parse(app.storage.getItem(SETTINGS_KEY)); assert.equal(value.targetLanguage, 'English'); assert.equal(value.maxInputChars, 500); assert.equal(value.defaultMode, 'normal'); assert.equal(value.defaultInstruction, '保留术语')
  assert.ok(ui.button('恢复默认设置')); assert.ok(!ui.text().includes('保存翻译设置')); assert.ok(!ui.text().includes('重新读取设置')); assert.ok(!ui.text().includes('默认 Provider'))
  app.dispose()
})
test('无效目标语言留在编辑器并提示，修正后即时写入', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.settingsPage, {}); ui.input('目标语言', '')
  assert.equal(ui.control('目标语言').props.value, ''); assert.match(ui.text(), /目标语言不能为空/); assert.equal(app.storage.getItem(SETTINGS_KEY), null)
  ui.input('目标语言', 'English'); assert.equal(JSON.parse(app.storage.getItem(SETTINGS_KEY)).targetLanguage, 'English')
  app.dispose()
})
test('多会话独立输入，重命名与从当前会话编号新建可用', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' }); ui.click('切换会话侧栏'); ui.input('待翻译内容', '父会话文本'); rename(ui, '故事A')
  ui.context(currentTitle(ui)); ui.click('新建会话'); assert.equal(ui.control('待翻译内容').props.value, ''); assert.match(ui.text(), /故事A-01/)
  ui.context('故事A'); ui.click('新建会话'); assert.match(ui.text(), /故事A-02/)
  ui.click('故事A'); assert.equal(ui.control('待翻译内容').props.value, '父会话文本')
  newSession(ui); assert.equal(ui.control('待翻译内容').props.value, ''); assert.match(ui.text(), /新翻译会话/)
  app.dispose()
})
test('主窗口范围隔离，模式与目标语言是当前翻译会话属性', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' }); ui.input('待翻译内容', 'A😀'); ui.input('翻译模式', 'normal'); ui.input('目标语言', 'English')
  assert.equal(ui.control('待翻译内容').props.value, 'A😀'); ui.render(app.panel, { sessionId: 'main-b' }); assert.equal(ui.control('待翻译内容').props.value, '')
  ui.render(app.panel, { sessionId: 'main-a' }); assert.equal(ui.control('待翻译内容').props.value, 'A😀'); assert.equal(ui.text(ui.button('选择翻译模式')), '普通'); assert.equal(ui.control('目标语言').props.value, 'English')
  app.dispose()
})
test('归档从使用列表移除会话，在标题下拉恢复未落盘内容', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' }); ui.input('待翻译内容', '当前窗口内容'); rename(ui, '可恢复会话')
  ui.context(currentTitle(ui)); ui.click('归档'); assert.match(ui.text(), /新建一个会话/)
  assert.equal(ui.nodes().some(node => node.type === 'textarea'), false)
  openSessionMenu(ui); ui.click('恢复归档会话：可恢复会话'); assert.equal(ui.control('待翻译内容').props.value, '当前窗口内容')
  app.dispose()
})
test('默认值修改不改已有会话，新建会话使用新值', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' }); rename(ui, '原会话')
  ui.render(app.settingsPage, {}); ui.input('目标语言', '日本語'); ui.input('翻译模式', 'normal'); ui.input('单次上限', '3')
  ui.render(app.panel, { sessionId: 'main-a' }); assert.equal(ui.control('目标语言').props.value, '中文')
  newSession(ui); assert.equal(ui.control('目标语言').props.value, '日本語'); assert.equal(ui.text(ui.button('选择翻译模式')), '普通')
  ui.input('待翻译内容', '😀abcd'); assert.match(ui.text(), /超过单次上限 3/); assert.equal(ui.control('待翻译内容').props.value, '😀abcd')
  app.dispose()
})
test('允许保存后自动写会话历史，关闭和恢复默认都保留旧历史', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.settingsPage, {}); checkbox(ui, '允许保存会话历史到本地', true)
  ui.render(app.panel, { sessionId: 'main-a' }); ui.input('待翻译内容', '已保存文本'); assert.equal(saved(app)[0].input, '已保存文本')
  ui.render(app.settingsPage, {}); checkbox(ui, '允许保存会话历史到本地', false)
  ui.render(app.panel, { sessionId: 'main-a' }); ui.input('待翻译内容', '之后的编辑'); assert.equal(saved(app)[0].input, '已保存文本')
  ui.render(app.settingsPage, {}); ui.click('恢复默认设置'); assert.equal(saved(app).length, 1); assert.equal(JSON.parse(app.storage.getItem(SETTINGS_KEY)).rememberHistory, false)
  app.dispose()
})
test('选择性删除一条/多条历史需要确认，并明确询问关联记忆范围', () => {
  const app = mount({ history: [fixture('a', '故事A'), fixture('b', '故事B', 'normal')] }); const ui = app.renderer; ui.render(app.settingsPage, {})
  checkbox(ui, '选择会话 故事A', true); ui.click('删除所选历史（1）'); assert.match(ui.text(), /是否联动删除关联记忆档案/)
  assert.ok(ui.nodes().some(node => node.type === 'input' && node.props.type === 'radio' && node.props.disabled)); ui.click('取消'); assert.equal(saved(app).length, 2)
  checkbox(ui, '选择会话 故事B', true); ui.click('删除所选历史（2）'); ui.click('确认删除历史'); assert.equal(saved(app).length, 0)
  app.dispose()
})
test('清除历史快译只删除快译，清除全部需单独确认', () => {
  const app = mount({ history: [fixture('a', '快译A'), fixture('b', '普通B', 'normal')] }); const ui = app.renderer; ui.render(app.settingsPage, {})
  ui.click('清除历史快译'); ui.click('确认删除历史'); assert.equal(saved(app).length, 1); assert.equal(saved(app)[0].mode, 'normal')
  ui.click('清除所有会话历史'); assert.equal(saved(app).length, 1); ui.click('确认删除历史'); assert.equal(saved(app).length, 0)
  app.dispose()
})
test('设置外部变更自动同步，不需要重新读取按钮', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.settingsPage, {})
  app.changeStorage(SETTINGS_KEY, JSON.stringify(settings({ targetLanguage: 'English' }))); assert.equal(ui.control('目标语言').props.value, 'English')
  assert.ok(!ui.text().includes('重新读取设置')); app.dispose()
})
test('模型采用分组目录与原生菜单材质，仅修改翻译会话模型', async () => {
  const app = mount({ settings: settings({ rememberHistory: true }) }); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' })
  assert.equal(app.catalogCalls, 0); ui.click('模型：选择模型'); await tick(); ui.render(); assert.equal(app.catalogCalls, 1)
  ui.click('选择模型')
  assert.ok(ui.nodes().some(node => node.props['aria-label'] === 'Provider A')); ui.input('搜索模型', 'md6'); ui.click('Model 6')
  assert.equal(saved(app)[0].model.provider, 'provider-a'); assert.equal(saved(app)[0].model.model, 'm6'); assert.ok(ui.button('模型：Model 6'))
  newSession(ui); assert.ok(ui.button('模型：选择模型')); app.dispose()
})
test('即时保存失败仍保留表单输入并提供错误重试操作', () => {
  const app = mount({ failSet: true }); const ui = app.renderer; ui.render(app.settingsPage, {}); ui.input('目标语言', 'English')
  assert.equal(ui.control('目标语言').props.value, 'English'); assert.match(ui.text(), /设置保存失败/); assert.ok(ui.button('重试保存失败的修改')); assert.equal(app.storage.getItem(SETTINGS_KEY), null)
  app.dispose()
})

test('侧栏取代页签，标题左侧与右侧模式/语言分组，末尾 + 和原生发送图标可用', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' })
  assert.equal(ui.nodes().some(node => node.props.role === 'tablist' || node.props['aria-label'] === '会话操作'), false)
  assert.equal(ui.nodes().some(node => node.type === 'aside'), false)
  ui.click('切换会话侧栏')
  assert.ok(ui.nodes().some(node => node.type === 'aside' && node.props['aria-label'] === '翻译会话侧栏'))
  const header = ui.nodes().find(node => node.props.className === 'dsh-tp-workspace-header')
  assert.ok(ui.nodes(header).some(node => node.props.className === 'dsh-tp-current-title'))
  assert.ok(ui.nodes(header).some(node => node.props.className === 'dsh-tp-header-options'))
  const list = ui.nodes().find(node => node.props['aria-label'] === '使用中的翻译会话')
  assert.equal(ui.nodes(list).filter(node => node.type === 'button').at(-1).props['aria-label'], '新建翻译会话')
  const toolbar = ui.nodes().find(node => node.props.className === 'dsh-tp-composer-toolbar')
  assert.equal(toolbar.children[0].props.className, 'dsh-tp-model')
  assert.equal(toolbar.children[1].props.className, 'dsh-tp-send')
  assert.ok(ui.nodes(toolbar).some(node => node.props['data-native-icon'] === 'send'))
  assert.ok(ui.nodes(header).some(node => node.props['data-native-icon'] === 'chevron-down'))
  ui.context(currentTitle(ui)); assert.deepEqual(ui.nodes().filter(node => node.props.role === 'menuitem').map(node => ui.text(node)), ['新建会话', '重命名', '删除', '归档'])
  assert.equal(ui.text().includes('关闭当前页签'), false)
  app.dispose()
})

test('右键非当前会话的重命名、新建和删除始终绑定被点击的会话', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' }); ui.click('切换会话侧栏'); rename(ui, '故事A'); ui.input('待翻译内容', 'A原文')
  newSession(ui); rename(ui, '故事B'); ui.input('待翻译内容', 'B原文')
  ui.context('故事A'); ui.click('重命名'); ui.input('会话名称', 'A改名'); ui.click('确认重命名')
  assert.equal(ui.control('待翻译内容').props.value, 'B原文'); assert.equal(ui.text(currentTitle(ui)), '故事B')
  ui.context('A改名'); ui.click('新建会话'); assert.equal(ui.text(currentTitle(ui)), 'A改名-01'); assert.equal(ui.control('待翻译内容').props.value, '')
  ui.click('故事B'); ui.context('A改名'); ui.click('删除'); assert.match(ui.text(), /删除「A改名」/); ui.click('取消')
  assert.ok(ui.button('A改名')); ui.context('A改名'); ui.click('删除'); ui.click('确认删除会话')
  assert.equal(ui.control('待翻译内容').props.value, 'B原文'); assert.equal(ui.text(currentTitle(ui)), '故事B')
  assert.equal(ui.nodes().some(node => node.type === 'button' && ui.text(node) === 'A改名'), false)
  app.dispose()
})

test('模型菜单提供推理等级及 Default，选择只写翻译会话，切换会话收起旧菜单', async () => {
  const catalog = { ok: true, value: { default: { provider: 'p', model: 'reasoner' }, groups: [{ id: 'p', name: 'Provider', models: [{ id: 'reasoner', name: 'Reasoner', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }] }], failures: [] } }
  const app = mount({ catalog, settings: settings({ rememberHistory: true }) }); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' })
  ui.click('模型：选择模型'); await tick(); ui.render(); assert.ok(ui.button('选择推理等级').props.disabled)
  ui.click('选择模型'); ui.click('Reasoner'); assert.ok(ui.button('模型：Reasoner · Default'))
  ui.click('选择推理等级'); ui.click('High'); assert.equal(saved(app)[0].model.reasoningEffort, 'high')
  ui.click('模型：Reasoner · High'); ui.click('选择推理等级'); ui.click('Default'); assert.equal(Object.hasOwn(saved(app)[0].model, 'reasoningEffort'), false)
  ui.click('模型：Reasoner · Default'); newSession(ui); assert.ok(ui.button('模型：选择模型'))
  assert.equal(ui.nodes().some(node => node.props['aria-label'] === '模型与推理等级'), false)
  app.dispose()
})

test('没有推理元数据的模型明确提示，保持推理等级不可选', async () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' })
  ui.click('模型：选择模型'); await tick(); ui.render(); ui.click('选择模型'); ui.click('Model 1')
  assert.equal(ui.button('选择推理等级').props.disabled, true); assert.match(ui.text(), /当前模型未提供推理等级/)
  app.dispose()
})
test('删除确认期间历史发生变化，确认操作保留新历史并提示重新选择', () => {
  const record = fixture('a', '故事A'); const app = mount({ history: [record] }); const ui = app.renderer; ui.render(app.settingsPage, {})
  checkbox(ui, '选择会话 故事A', true); ui.click('删除所选历史（1）')
  app.changeStorage(HISTORY_PREFIX + 'a', JSON.stringify({ schemaVersion: 2, token: 'newer', session: { ...record, input: '新增内容' } }))
  ui.click('确认删除历史'); assert.equal(saved(app).length, 1); assert.equal(saved(app)[0].input, '新增内容'); assert.match(ui.text(), /待删除会话或历史已变化/)
  app.dispose()
})

test('标题的 Shift+F10 可打开绑定会话的原生右键菜单，侧栏可以折叠', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' })
  let prevented = false
  currentTitle(ui).props.onKeyDown({ key: 'F10', shiftKey: true, currentTarget: { getBoundingClientRect() { return { left: 20, bottom: 40 } } }, preventDefault() { prevented = true }, stopPropagation() {} })
  ui.render(); assert.equal(prevented, true); assert.ok(ui.button('归档'))
  assert.ok(ui.nodes().some(node => node.props.role === 'menu' && node.props['data-portal'] === true))
  ui.click('切换会话侧栏'); assert.equal(ui.nodes().some(node => node.type === 'aside'), true)
  ui.click('切换会话侧栏'); assert.equal(ui.nodes().some(node => node.type === 'aside'), false)
  app.dispose()
})

test('侧栏默认收起，标题下拉切换已有会话且保留独立输入', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' }); rename(ui, '故事A'); ui.input('待翻译内容', '原文A')
  assert.equal(ui.button('切换会话侧栏').props['aria-expanded'], false)
  newSession(ui); rename(ui, '故事B'); ui.input('待翻译内容', '原文B')
  openSessionMenu(ui); assert.ok(ui.button('切换翻译会话：故事A')); assert.ok(ui.button('切换翻译会话：故事B'))
  ui.click('切换翻译会话：故事A'); assert.equal(ui.text(currentTitle(ui)), '故事A'); assert.equal(ui.control('待翻译内容').props.value, '原文A')
  assert.equal(currentTitle(ui).props['aria-expanded'], false)
  openSessionMenu(ui); ui.click('切换翻译会话：故事B'); assert.equal(ui.control('待翻译内容').props.value, '原文B')
  assert.equal(ui.nodes().some(node => node.type === 'aside'), false)
  app.dispose()
})

test('标题下拉内的右键操作绑定具体会话，切换主窗口会话时列表隔离', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' }); rename(ui, 'A'); newSession(ui); rename(ui, 'B')
  openSessionMenu(ui); ui.context('切换翻译会话：A'); assert.equal(currentTitle(ui).props['aria-expanded'], true)
  ui.click('新建会话'); assert.equal(ui.text(currentTitle(ui)), 'A-01')
  ui.render(app.panel, { sessionId: 'main-b' }); openSessionMenu(ui)
  assert.equal(ui.nodes().some(node => node.props['aria-label'] === '切换翻译会话：A'), false)
  assert.equal(ui.button('切换会话侧栏').props['aria-expanded'], false)
  app.dispose()
})

test('发送明确覆盖宿主超椭圆、输入区无蓝色聚焦框，侧栏 + 与标题行同宽', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' })
  const shape = ui.button('发送（翻译执行尚未接入）').props.style
  assert.equal(shape.width, shape.height); assert.equal(shape.minWidth, shape.maxWidth); assert.equal(shape.minHeight, shape.maxHeight)
  assert.equal(shape.width, 38); assert.equal(shape.borderRadius, '50%'); assert.equal(shape.aspectRatio, '1 / 1')
  assert.equal(shape.cornerShape, 'round')
  assert.equal(ui.control('待翻译内容').props.style.outline, 'none'); assert.equal(ui.control('待翻译内容').props.style.boxShadow, 'none')
  ui.click('切换会话侧栏')
  const css = ui.nodes().find(node => node.type === 'style').children.join('')
  assert.match(css, /\.dsh-tp-session-item \{[^}]*width: 100%/)
  assert.match(css, /\.dsh-tp-session-add \{[^}]*width: 100%/)
  assert.match(css, /\.dsh-tp \.dsh-tp-send \{[^}]*corner-shape: round !important/)
  assert.match(css, /textarea:focus-visible \{ outline: none !important; box-shadow: none !important/)
  app.dispose()
})

test('侧栏和标题下拉的新建入口统一为整行居中 +，保留可访问名称与新建行为', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' }); rename(ui, '故事A')
  openSessionMenu(ui)
  const menu = ui.nodes().find(node => node.props['aria-label'] === '已有翻译会话')
  const menuAdd = ui.nodes(menu).filter(node => node.type === 'button').at(-1)
  assert.equal(menuAdd.props['aria-label'], '新建翻译会话'); assert.equal(menuAdd.props.title, '新建翻译会话')
  assert.equal(menuAdd.props.role, 'menuitem'); assert.equal(ui.text(menuAdd), '+'); assert.equal(menuAdd.props.className, 'dsh-tp-session-add')
  assert.ok(ui.nodes(menu).some(node => node.props.role === 'separator'))
  menuAdd.props.onClick(); ui.render(); assert.equal(ui.text(currentTitle(ui)), '新翻译会话'); assert.equal(currentTitle(ui).props['aria-expanded'], false)
  ui.click('切换会话侧栏')
  const list = ui.nodes().find(node => node.props['aria-label'] === '使用中的翻译会话')
  const sidebarAdd = ui.nodes(list).filter(node => node.type === 'button').at(-1)
  assert.equal(sidebarAdd.props['aria-label'], '新建翻译会话'); assert.equal(sidebarAdd.props.className, menuAdd.props.className); assert.equal(ui.text(sidebarAdd), '+')
  const count = ui.nodes(list).filter(node => node.props.className === 'dsh-tp-session-item').length
  sidebarAdd.props.onClick(); ui.render()
  const nextList = ui.nodes().find(node => node.props['aria-label'] === '使用中的翻译会话')
  assert.equal(ui.nodes(nextList).filter(node => node.props.className === 'dsh-tp-session-item').length, count + 1)
  const css = ui.nodes().find(node => node.type === 'style').children.join('')
  assert.match(css, /\.dsh-tp-session-add \{[^}]*justify-content: center;[^}]*width: 100%;[^}]*text-align: center/)
  app.dispose()
})

test('未选模型的菜单不显示多余推理等级提示，推理入口仍禁用', async () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' })
  ui.click('模型：选择模型')
  assert.equal(ui.text().includes('选择模型后可调整其推理等级。'), false)
  await tick(); ui.render()
  assert.equal(ui.text().includes('选择模型后可调整其推理等级。'), false)
  assert.equal(ui.button('选择推理等级').props.disabled, true)
  app.dispose()
})

function sessionDropdownMenu(ui) {
  const anchor = ui.nodes().find(node => node.props['data-native-menu'] && node.props.className === 'dsh-tp-title-anchor')
  return ui.nodes(anchor).find(node => node.props.role === 'menu')
}
function sessionContextMenu(ui) {
  return ui.nodes().find(node => node.props.role === 'menu' && ui.nodes(node).some(child => child.props['aria-label'] === '翻译会话右键操作'))
}

test('右键会话列表保持展开，菜单操作绑定目标，点击外部可同时收起两层菜单', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' }); rename(ui, 'A'); newSession(ui); rename(ui, 'B')
  openSessionMenu(ui); ui.context('切换翻译会话：A')
  assert.equal(currentTitle(ui).props['aria-expanded'], true); assert.ok(ui.button('切换翻译会话：A')); assert.ok(ui.button('切换翻译会话：B'))
  // 右键菜单的 portal 在下拉 DOM 外部；下拉不能先卸载菜单行。
  sessionDropdownMenu(ui).props.onClose(); ui.render(); assert.equal(currentTitle(ui).props['aria-expanded'], true); assert.ok(sessionContextMenu(ui))
  let stopped = false
  ui.nodes().find(node => node.props['aria-label'] === '翻译会话右键操作').props.onPointerDown({ stopPropagation() { stopped = true } })
  assert.equal(stopped, true)
  ui.click('重命名'); assert.equal(currentTitle(ui).props['aria-expanded'], true); assert.equal(sessionContextMenu(ui), undefined)
  ui.input('会话名称', 'A改名'); ui.click('确认重命名'); assert.ok(ui.button('切换翻译会话：A改名')); assert.equal(ui.text(currentTitle(ui)), 'B')
  ui.context('切换翻译会话：A改名')
  sessionContextMenu(ui).props.onClose(); ui.render(); assert.equal(currentTitle(ui).props['aria-expanded'], false); assert.equal(sessionContextMenu(ui), undefined)
  openSessionMenu(ui); ui.context('切换翻译会话：A改名')
  ui.click('切换翻译会话：A改名'); assert.equal(ui.text(currentTitle(ui)), 'A改名'); assert.equal(currentTitle(ui).props['aria-expanded'], false); assert.equal(sessionContextMenu(ui), undefined)
  app.dispose()
})

test('下拉内 Shift+F10 保持列表，Escape 只退出右键层并还原焦点', () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' }); openSessionMenu(ui)
  let focused = 0
  const row = ui.button('切换翻译会话：新翻译会话')
  row.props.onKeyDown({ key: 'F10', shiftKey: true, currentTarget: { getBoundingClientRect() { return { left: 20, bottom: 40 } }, focus() { focused++ } }, preventDefault() {}, stopPropagation() {} }); ui.render()
  assert.equal(currentTitle(ui).props['aria-expanded'], true); assert.ok(sessionContextMenu(ui))
  sessionDropdownMenu(ui).props.onClose(); ui.render()
  let prevented = false; let stopped = false
  ui.nodes().find(node => node.props['aria-label'] === '翻译会话右键操作').props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true }, stopPropagation() { stopped = true } }); ui.render()
  assert.equal(prevented, true); assert.equal(stopped, true); assert.equal(focused, 1)
  assert.equal(sessionContextMenu(ui), undefined); assert.equal(currentTitle(ui).props['aria-expanded'], true)
  sessionDropdownMenu(ui).props.onClose(); ui.render(); assert.equal(currentTitle(ui).props['aria-expanded'], false)
  app.dispose()
})

test('模型菜单文字与原生目标语言紧凑菜单使用相同字号和行高', async () => {
  const app = mount(); const ui = app.renderer; ui.render(app.panel, { sessionId: 'main-a' })
  ui.click('选择目标语言')
  assert.ok(ui.nodes().some(node => node.props.role === 'menu' && node.props['data-compact'] === true && ui.nodes(node).some(child => child.type === 'button' && ui.text(child) === '日本語')))
  ui.click('模型：选择模型'); await tick(); ui.render()
  const css = ui.nodes().find(node => node.type === 'style').children.join('')
  assert.match(css, /\.dsh-tp-model-menu \.dsh-tp-menu-content \{ font-size: 11px; line-height: 17px;/)
  assert.match(css, /\.dsh-tp-model-menu \.dsh-tp-muted \{ font-size: inherit; line-height: inherit;/)
  assert.ok(ui.nodes().some(node => node.props.role === 'menu' && node.props.className.includes('dsh-tp-model-menu') && node.props['data-compact'] === true))
  ui.click('选择模型'); assert.ok(ui.button('Model 1')); app.dispose()
})
