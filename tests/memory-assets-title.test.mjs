import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { mount } from './quick-client-fixture.mjs'
import { memoryAssetsAddress } from '../dist/client/memory-assets-window.js'

// Published title slot with the shared hook renderer; this is not a desktop DOM test.
function mountCaption() {
  const app = mount(), ui = app.renderer
  ui.render(app.panel, { sessionId: 'owner-a' })
  const session = app.store.getActiveSession('owner-a')
  const caption = app.resourceHost.registrations.get('sidebar.right.pane.tab.title:dsh-translation-plugin/memory-assets')
  assert.equal(typeof caption, 'function')
  return { app, ui, session,
    render(ownerId, address, params) {
      ui.render(caption, { sessionId: ownerId, useTabInfo: () => ({ tab: { id: 'caption', contentId: address, signal: new AbortController().signal,
        navigation: { address, params, revision: 1 }, actions: { openResource() {}, close() {} } } }) })
      return ui.nodes().find(node => node.props['data-dsh-translation-assets-title'])
    },
  }
}

test('owned host title combines the associated session and interactive topic; invalid scope stays generic', async t => {
  const f = mountCaption(); t.after(() => f.app.dispose())
  const address = memoryAssetsAddress('owner-a', f.session.topicId)
  const title = f.render('owner-a', address, { topicId: f.session.topicId, sessionId: f.session.id })
  assert.equal(f.ui.text(title), `记忆资产${f.session.name}${f.session.topicName}`)
  assert.equal(f.ui.nodes(title).find(node => node.props.className === 'dsh-tp-assets-title-label').children.join(''), '记忆资产')
  assert.equal(f.ui.nodes(title).find(node => node.props.className === 'dsh-tp-assets-title-session').props.title, f.session.name)
  assert.equal(f.ui.button('选择资产主题').props.title, f.session.topicName)
  for (const [owner, resource] of [['owner-a', 'invalid'], ['owner-b', address], ['owner-a', address + '?topic=other'], [undefined, address], ['owner-a', undefined]]) {
    assert.equal(f.ui.text(f.render(owner, resource)), '记忆资产')
    assert.ok(!f.ui.nodes().some(node => node.props['aria-label'] === '选择资产主题'))
  }
})

test('title text uses responsive per-name truncation with the fixed 14px bold asset label', async t => {
  const f = mountCaption(); t.after(() => f.app.dispose())
  const node = f.render('owner-a', memoryAssetsAddress('owner-a', f.session.topicId), { topicId: f.session.topicId, sessionId: f.session.id })
  const styles = f.ui.nodes(node).find(child => child.type === 'style' && !child.props['data-assets-cursor-style']).children.join('')
  assert.match(styles, /\.dsh-tp-assets-title\s*\{[^}]*flex:\s*1 1 auto/u)
  assert.match(styles, /\.dsh-tp-assets-title-label[^}]*font-size:\s*14px[^}]*font-weight:\s*700/u)
  assert.match(styles, /\.dsh-tp-assets-title-session[^}]*text-overflow:\s*ellipsis[^}]*font-size:\s*14px[^}]*font-weight:\s*400/u)
  assert.match(styles, /\.dsh-tp-assets-title-picker[^}]*min-width:\s*0/u)
  assert.doesNotMatch(styles, /\.dsh-tp-assets-title-session[^}]*max-width:/u)
  assert.doesNotMatch(styles, /\.dsh-tp-assets-title-picker[^}]*max-width:/u)
  assert.match(styles, /\[data-dockkit-float-title\]:has\(\[data-dsh-translation-assets-title\]\),\s*\[data-dockkit-tab\]:has\(\[data-dsh-translation-assets-title\]\)\s*\{\s*min-width: 0; max-width: none;\s*\}/u)
  assert.doesNotMatch(styles, /justify-content:\s*space-between|max-width:\s*(?:\d+px|(?:[1-9]|[1-9]\d)%)/u)
})

test('cursor rule still selects only the owned floating caption and excludes native controls', async t => {
  const f = mountCaption(); t.after(() => f.app.dispose())
  const node = f.render('owner-a', memoryAssetsAddress('owner-a', f.session.topicId))
  const css = f.ui.nodes(node).find(child => child.props['data-assets-cursor-style']).children.join('').trim()
  assert.equal(css, '[data-dockkit-float] [data-dockkit-float-grip]:has([data-dockkit-float-title] [data-dsh-translation-assets-title]) { cursor: default; }')
  assert.doesNotMatch(css, /data-dockkit-float-(?:close|dock|resize)|\bbutton\b|\bbody\b|pointer-events|!important|\*/u)
  assert.equal((css.match(/\{/gu) ?? []).length, 1)
  assert.equal(f.ui.nodes(node).filter(child => child.type === 'button').length, 1, 'only the topic button, no duplicate host controls')
})

test('docked host title hides only the owned session and topic while floating caption keeps both', async t => {
  const f = mountCaption(); t.after(() => f.app.dispose())
  const node = f.render('owner-a', memoryAssetsAddress('owner-a', f.session.topicId), { topicId: f.session.topicId, sessionId: f.session.id })
  const styles = f.ui.nodes(node).find(child => child.type === 'style' && !child.props['data-assets-cursor-style']).children.join('')
  assert.match(styles, /\[data-dockkit-tab\] \[data-dsh-translation-assets-title\] \.dsh-tp-assets-title-session,\s*\[data-dockkit-tab\] \[data-dsh-translation-assets-title\] \.dsh-tp-assets-title-picker\s*\{\s*display: none;\s*\}/u)
  const hideRules = [...styles.matchAll(/([^{}]+)\{\s*display: none;\s*\}/gu)]
  assert.equal(hideRules.length, 1)
  assert.doesNotMatch(hideRules[0][1], /data-dockkit-float-title|data-dockkit-tab-close|data-dockkit-float-(?:close|dock)|assets-title-label/u)
  assert.equal(f.ui.nodes(node).filter(child => child.props.className === 'dsh-tp-assets-title-label').length, 1)
  assert.ok(f.ui.nodes(node).some(child => child.props.className === 'dsh-tp-assets-title-session'))
  assert.ok(f.ui.nodes(node).some(child => child.props.className === 'dsh-tp-assets-title-picker'))
})

test('owned docked title reserves native close space and clears only its own mask', async t => {
  const f = mountCaption(); t.after(() => f.app.dispose())
  const node = f.render('owner-a', memoryAssetsAddress('owner-a', f.session.topicId), { topicId: f.session.topicId, sessionId: f.session.id })
  const styles = f.ui.nodes(node).find(child => child.type === 'style' && !child.props['data-assets-cursor-style']).children.join('')
  assert.match(styles, /\[data-dockkit-tab\]:has\(\[data-dsh-translation-assets-title\]\)\s*\{\s*padding-right: 30px;\s*\}/u)
  assert.match(styles, /\[data-dockkit-tab\]:has\(\[data-dsh-translation-assets-title\]\) \[data-dockkit-tab-title\]:has\(\[data-dsh-translation-assets-title\]\)\s*\{\s*mask-image: none;\s*\}/u)
  const layoutRules = [...styles.matchAll(/([^{}]+)\{([^{}]*(?:padding-right|mask-image)[^{}]*)\}/gu)]
  assert.equal(layoutRules.length, 2)
  for (const rule of layoutRules) {
    assert.match(rule[1], /data-dockkit-tab.*data-dsh-translation-assets-title/u)
    assert.doesNotMatch(rule[1], /data-dockkit-float|data-dockkit-tab-close/u)
    assert.doesNotMatch(rule[2], /(?:^|;)\s*(?:width|position|right|left):/u, 'native controls and intrinsic tab sizing remain owned by the host')
  }
})

test('topic interactions stop bubbling drag/focus/menu events while caption text remains draggable', async t => {
  const f = mountCaption(); t.after(() => f.app.dispose())
  const node = f.render('owner-a', memoryAssetsAddress('owner-a', f.session.topicId))
  const label = f.ui.nodes(node).find(child => child.props.className === 'dsh-tp-assets-title-label')
  const picker = f.ui.nodes(node).find(child => child.props.className === 'dsh-tp-assets-title-picker')
  for (const nonInteractive of [node, label]) {
    assert.ok(Object.keys(nonInteractive.props).every(key => !/^on(?:Pointer|Mouse|Touch|Drag|Click|ContextMenu)/u.test(key)))
    assert.equal(nonInteractive.props.style?.pointerEvents, undefined)
  }
  for (const eventName of ['onPointerDown', 'onClick', 'onContextMenu']) {
    let stopped = false
    picker.props[eventName]({ stopPropagation() { stopped = true }, preventDefault() { assert.fail('keep native menu and input defaults') } })
    assert.equal(stopped, true, `${eventName} cannot reach either native caption or docked tab`)
  }
  await f.ui.click('选择资产主题')
  const menu = f.ui.nodes().find(child => child.props.role === 'menu')
  assert.equal(menu.props['data-portal'], true)
  assert.equal(menu.props['data-compact'], true)
  const openPicker = f.ui.nodes().find(child => child.props.className === 'dsh-tp-assets-title-picker')
  assert.ok(f.ui.nodes(openPicker).some(child => child.props['aria-label'] === '搜索资产主题'), 'portal contents retain the interaction boundary in React')
})

test('the open title menu capture closes only its own native dock operation and leaves host events intact', async () => {
  // Run the actual component's capture effect with explicit DOM ancestry; no desktop claim.
  const source = await readFile(new URL('../src/client/memory-assets-title.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const effects = [], values = [0, true, ''], rootRef = { current: null }, handlers = new Map()
  let stateIndex = 0, closes = 0
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const react = {
    useState() { const index = stateIndex++; return [values[index], value => { values[index] = value; if (index === 1 && value === false) closes++ }] },
    useRef() { return rootRef },
    useEffect(effect, deps) { effects.push({ effect, deps }) },
  }
  class Element {
    constructor({ float, dock } = {}) { this.float = float; this.dock = dock }
    closest(selector) {
      assert.ok(['[data-dockkit-float]', '[data-dockkit-float-dock]'].includes(selector))
      return selector === '[data-dockkit-float]' ? this.float ?? null : this.dock ?? null
    }
  }
  const exported = {}
  vm.runInNewContext(compiled, { exports: exported, Element,
    document: {
      addEventListener(name, listener, capture) { assert.equal(name, 'pointerdown'); assert.equal(capture, true); handlers.set(name, listener) },
      removeEventListener(name, listener, capture) { assert.equal(handlers.get(name), listener); assert.equal(capture, true); handlers.delete(name) },
    },
    require(id) {
      if (id === './react.js') return { h, react }
      if (id === './native-ui.js') return { Menu: 'native-menu', IconChevronDownOutlineRegular: 'svg' }
      assert.equal(id, './memory-assets-window.js')
      return { resolveMemoryAssetsSelection: () => undefined }
    },
  })
  const title = exported.MemoryAssetsTitle({ store: { subscribe() { return () => {} } } })
  assert.equal(title.props.ref, rootRef)
  const ownFloat = new Element(), otherFloat = new Element(), ownDock = new Element({ float: ownFloat }), otherDock = new Element({ float: otherFloat })
  ownDock.dock = ownDock; otherDock.dock = otherDock
  rootRef.current = new Element({ float: ownFloat })
  const cleanup = effects.find(({ deps }) => deps.length === 1 && deps[0] === true).effect()
  const handler = handlers.get('pointerdown')
  const dispatch = target => handler({ target, preventDefault() { assert.fail('native dock default must remain') }, stopPropagation() { assert.fail('native dock propagation must remain') } })
  dispatch(otherDock); dispatch(new Element({ float: ownFloat })); dispatch(null)
  assert.equal(closes, 0, 'other floats, ordinary targets and missing nodes do not close this menu')
  dispatch(new Element({ dock: ownDock, float: ownFloat }))
  assert.equal(closes, 1); assert.equal(values[1], false)
  cleanup(); assert.equal(handlers.size, 0)
})
