import assert from 'node:assert/strict'
import test from 'node:test'
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
  assert.equal(f.ui.text(title), `记忆资产· ${f.session.name}${f.session.topicName}`)
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
  assert.match(styles, /\.dsh-tp-assets-title-label[^}]*font-size:\s*14px[^}]*font-weight:\s*700/u)
  assert.match(styles, /\.dsh-tp-assets-title-session[^}]*max-width:\s*40%[^}]*text-overflow:\s*ellipsis/u)
  assert.match(styles, /\.dsh-tp-assets-title-picker[^}]*max-width:\s*35%/u)
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
