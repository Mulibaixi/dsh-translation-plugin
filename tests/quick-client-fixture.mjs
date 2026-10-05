import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

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
class Locks {
  tail = Promise.resolve()
  request(_name, action) {
    const operation = this.tail.then(action)
    this.tail = operation.catch(() => {})
    return operation
  }
}
class HeldLocks {
  queue = []
  request(_name, action) { return new Promise((resolve, reject) => this.queue.push({ action, resolve, reject })) }
  async next() {
    const operation = this.queue.shift(); assert.ok(operation, 'a lock request is waiting')
    try { operation.resolve(await operation.action()) } catch (error) { operation.reject(error) }
    await tick()
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
function createRenderer({ deferFunctionalUpdates = false } = {}) {
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
  const stateUpdates = []
  let deferredUpdateCount = 0

  function hook(initial) {
    assert.ok(active, 'hooks run within a component')
    const index = active.index++
    if (!(index in active.hooks)) active.hooks[index] = initial()
    return active.hooks[index]
  }

  const react = {
    createElement(type, props, ...children) {
      if (type === 'div' && props?.className === 'dsh-tp-header-options') {
        const keys = children.map(child => child.props.key)
        assert.equal(new Set(keys).size, keys.length, 'header picker siblings must have unique keys for React reconciliation')
      }
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const cell = hook(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [cell.value, next => {
        const update = () => { const value = typeof next === 'function' ? next(cell.value) : next; if (!Object.is(value, cell.value)) dirty = true; cell.value = value }
        if (deferFunctionalUpdates && typeof next === 'function') { stateUpdates.push(update); deferredUpdateCount++ }
        else update()
      }]
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
    while (stateUpdates.length) stateUpdates.shift()()
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
    get deferredUpdateCount() { return deferredUpdateCount },
    async check(label, checked) {
      const target = control(label); assert.ok(!target.props.disabled)
      const event = { currentTarget: { checked } }
      target.props.onChange(event)
      event.currentTarget = null
      render(); await tick(); render()
    },
    async flush() { await tick(); render() },
    async input(label, value) {
      if (label === '翻译模式' && nodes().some(node => node.props['aria-label'] === '选择翻译模式')) {
        button('选择翻译模式').props.onClick(); render();
        const target = button(value === 'quick' ? '快译（当前）' : '升为普通')
        assert.ok(!target.props.disabled); target.props.onClick(); render(); await tick(); render(); return
      }
      const target = control(label); assert.ok(!target.props.disabled)
      target.props.onChange({ currentTarget: { value } }); render(); await tick(); render()
    },
    context(target) {
      const node = typeof target === 'string' ? button(target) : target
      assert.equal(typeof node.props.onContextMenu, 'function')
      let prevented = false
      node.props.onContextMenu({ clientX: 150, clientY: 90, preventDefault() { prevented = true }, stopPropagation() {} }); render()
      assert.equal(prevented, true)
    },
    async click(label) {
      const target = button(label)
      assert.ok(!target.props.disabled, `button is enabled: ${label}`)
      target.props.onClick(); render(); await tick(); render()
    },
    async remember(value) {
      const checkbox = nodes().find(node => node.type === 'input' && node.props.type === 'checkbox')
      assert.ok(checkbox)
      checkbox.props.onChange({ currentTarget: { checked: value } }); render(); await tick(); render()
    },
    dispose() {
      for (const seat of seats.values()) for (const cell of seat.hooks) cell.cleanup?.()
      seats.clear()
    },
  }
}

export function mount(overrides = {}) {
  const storage = overrides.storage ?? new FakeStorage()
  if (overrides.settings) storage.setItem(SETTINGS_KEY, JSON.stringify(overrides.settings))
  for (const session of overrides.history ?? []) storage.setItem(HISTORY_PREFIX + encodeURIComponent(session.id), JSON.stringify({ schemaVersion: 2, token: session.id, session }))
  storage.failSet = !!overrides.failSet
  if (storage.failSet) storage.setItem = () => { throw new Error('quota') }
  const renderer = createRenderer({ deferFunctionalUpdates: overrides.deferFunctionalUpdates })
  const entries = []; const effects = []; const slots = new Map(); const listeners = new Set()
  let catalogCalls = 0
  const catalogResponse = overrides.catalog ?? { ok: true, value: { default: { provider: 'provider-a', model: 'm1' }, routableProviders: ['provider-a'], groups: [{ id: 'provider-a', name: 'Provider A', models: Array.from({ length: 6 }, (_, i) => ({ id: 'm' + (i + 1), name: 'Model ' + (i + 1) })) }], failures: [] } }
  const window = { localStorage: storage, __ModuleLoader__: { load(entry) { entries.push(entry) } }, addEventListener(_name, listener) { listeners.add(listener) }, removeEventListener(_name, listener) { listeners.delete(listener) } }
  const locks = overrides.locks ?? new Locks()
  const copies = []
  const clipboard = overrides.clipboard ?? { async writeText(text) { copies.push(text) } }
  const context = vm.createContext({ window, navigator: { locks, clipboard }, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, console, document: { addEventListener() {}, removeEventListener() {} }, Node: class {} })
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
  let mountCalls = 0; let unmountCalls = 0
  const remote = {
    async $mount() {
      mountCalls++
      await overrides.mountGate
      if (overrides.mountError) throw overrides.mountError
      remote.translationQuick = overrides.quick
      return async () => { unmountCalls++; delete remote.translationQuick }
    },
    session: { async modelCatalog() { catalogCalls++; return catalogResponse }, selectModel() { throw new Error('main chat selection must remain independent') } },
    $on() { return () => {} },
  }
  const clientContext = {
    remote,
    get(name) { assert.equal(name, 'remote.translationQuick'); return remote.translationQuick },
    on() { return () => {} }, sidebarRightTabs: { register() { return () => {} } },
    slots: { register(target, component) { slots.set(target.name, component); return () => slots.delete(target.name) }, inject(_name, register) { return register() } },
    effect(effect) { const cleanup = effect(); effects.push(cleanup); return cleanup },
  }
  const applied = overrides.applyClient ? overrides.applyClient(exported, clientContext) : exported.apply(clientContext)
  return { renderer, storage, remote, applied, copies,
    get panel() { return slots.get('sidebar.right.pane.tab') },
    get settingsPage() { return slots.get('settings.section') },
    get catalogCalls() { return catalogCalls },
    get mountCalls() { return mountCalls },
    get unmountCalls() { return unmountCalls },
    changeStorage(key, raw) { storage.setItem(key, raw); for (const listener of listeners) listener({ key, storageArea: storage }); renderer.render() },
    dispose() { renderer.dispose(); return Promise.all(effects.toReversed().map(effect => effect?.())) },
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))
