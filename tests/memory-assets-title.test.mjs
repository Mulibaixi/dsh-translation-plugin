import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { memoryAssetsAddress } from '../dist/client/memory-assets-window.js'

const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')

// Only the owned title is rendered. These hook/element assertions do not exercise desktop DOM.
function mountCaption() {
  let entry, caption, connected = false, stopCaption, refreshes = 0
  const effects = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [initial, () => { refreshes++ }],
    useEffect(effect) { if (!connected) { connected = true; stopCaption = effect() } },
  }
  const window = {
    __ModuleLoader__: { load(value) { entry = value } },
    addEventListener() {}, removeEventListener() {},
  }
  vm.runInNewContext(source, { window, console, crypto: globalThis.crypto, AbortController })
  const plugin = entry.factory(name => {
    assert.ok(['react', '@deepseek-ai/dsh-client-ui-primitives'].includes(name))
    return name === 'react' ? react : { MenuSurface: 'div', MenuGroup: 'section' }
  })
  plugin.apply({
    remote: { session: {}, $on: () => () => {} }, on: () => () => {},
    sidebarRight: {}, sidebarRightTabs: { register: () => () => {} },
    slots: {
      inject: (_name, register) => register(),
      register(target, component) {
        if (target.name === 'sidebar.right.pane.tab.title') {
          assert.equal(target.key, 'dsh-translation-plugin/memory-assets')
          assert.equal(caption, undefined, 'one owned title contribution')
          caption = component
        }
        return () => {}
      },
    },
    effect(effect) { const cleanup = effect(); effects.push(cleanup); return cleanup },
  })
  assert.equal(typeof caption, 'function')
  function element(ownerId, address) {
    return caption({ sessionId: ownerId, useTabInfo: () => ({ tab: { navigation: { address } } }) })
  }
  const store = element(undefined, undefined).props.store
  return {
    store,
    render(ownerId, address) { const node = element(ownerId, address); return node.type(node.props) },
    get refreshes() { return refreshes },
    unmountTitle() { stopCaption?.(); stopCaption = undefined },
    dispose() { stopCaption?.(); effects.reverse().forEach(cleanup => cleanup()) },
  }
}

function titleText(node) { return node.children.filter(child => typeof child === 'string').join('') }
function cursorCss(node) { return node.children.find(child => child?.type === 'style').children.join('') }

test('title reads its fixed resource owner/topic and refreshes on that shared Store rename', t => {
  const fixture = mountCaption(); t.after(() => fixture.dispose())
  const a = fixture.store.createSession('owner-a'), b = fixture.store.createSession('owner-b')
  assert.ok(a && b)
  assert.equal(fixture.store.renameSession(a.id, '固定主题'), true)
  assert.equal(fixture.store.renameSession(b.id, '其他主会话'), true)
  const address = memoryAssetsAddress(a.ownerId, a.topicId)
  assert.equal(titleText(fixture.render(a.ownerId, address)), '固定主题 · 记忆资产')
  const before = fixture.refreshes
  assert.equal(fixture.store.renameSession(a.id, '已重命名主题'), true)
  assert.ok(fixture.refreshes > before, 'the title subscribed to the shared Store')
  assert.equal(titleText(fixture.render(a.ownerId, address)), '已重命名主题 · 记忆资产')
  assert.equal(fixture.store.renameSession(b.id, '另一主题已变化'), true)
  assert.equal(titleText(fixture.render(a.ownerId, address)), '已重命名主题 · 记忆资产')
  fixture.unmountTitle()
  const released = fixture.refreshes
  assert.equal(fixture.store.renameSession(a.id, '关闭标题后变化'), true)
  assert.equal(fixture.refreshes, released, 'title unmount releases only its subscription')
})

test('invalid, cross-owner, unavailable or unbound resources use the neutral title', t => {
  const fixture = mountCaption(); t.after(() => fixture.dispose())
  const session = fixture.store.createSession('owner-a'); assert.ok(session)
  fixture.store.renameSession(session.id, '仅属于A')
  const address = memoryAssetsAddress(session.ownerId, session.topicId)
  for (const [owner, resource] of [
    ['owner-a', 'invalid'], ['owner-b', address], ['owner-a', address + '?topic=other'],
    ['owner-a', memoryAssetsAddress('owner-a', 'missing-topic')], [undefined, address], ['owner-a', undefined],
  ]) assert.equal(titleText(fixture.render(owner, resource)), '记忆资产')
})

test('cursor rule selects only an owned floating caption and leaves native controls out', t => {
  const fixture = mountCaption(); t.after(() => fixture.dispose())
  const node = fixture.render('owner-a', memoryAssetsAddress('owner-a', 'missing-topic'))
  assert.equal(node.props['data-dsh-translation-assets-title'], true)
  const css = cursorCss(node).trim()
  assert.equal(css, '[data-dockkit-float] [data-dockkit-float-grip]:has([data-dockkit-float-title] [data-dsh-translation-assets-title]) { cursor: default; }')
  assert.doesNotMatch(css, /data-dockkit-float-(?:close|dock|resize)|\bbutton\b|\bbody\b|pointer-events|!important|\*/u)
  assert.equal((css.match(/\{/gu) ?? []).length, 1, 'no broader fallback selector')
})

test('owned title adds no pointer, mouse, touch or drag event interception', t => {
  const fixture = mountCaption(); t.after(() => fixture.dispose())
  const node = fixture.render('owner-a', memoryAssetsAddress('owner-a', 'missing-topic'))
  for (const element of [node, ...node.children.filter(child => child && typeof child === 'object')]) {
    assert.ok(Object.keys(element.props).every(key => !/^on(?:Pointer|Mouse|Touch|Drag)/u.test(key)))
    assert.equal(element.props.style?.pointerEvents, undefined)
  }
})
