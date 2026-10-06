import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { memoryAssetsAddress } from '../dist/client/memory-assets-window.js'

const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')

// Only the owned title is rendered. These hook/element assertions do not exercise desktop DOM.
function mountCaption() {
  let entry, caption
  const effects = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
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
  return {
    render(ownerId, address) { const node = element(ownerId, address); return node.type(node.props) },
    dispose() { effects.reverse().forEach(cleanup => cleanup()) },
  }
}

function titleText(node) { return node.children.filter(child => typeof child === 'string').join('') }
function cursorCss(node) { return node.children.find(child => child?.type === 'style').children.join('') }

test('the floating caption always displays one memory-assets title', t => {
  const fixture = mountCaption(); t.after(() => fixture.dispose())
  const address = memoryAssetsAddress('owner-a', 'topic-a')
  for (const [owner, resource] of [
    ['owner-a', address], ['owner-a', 'invalid'], ['owner-b', address], ['owner-a', address + '?topic=other'],
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
