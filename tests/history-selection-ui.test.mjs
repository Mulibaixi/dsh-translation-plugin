import assert from 'node:assert/strict'
import test from 'node:test'
import { mount } from './quick-client-fixture.mjs'

function history(id, name) {
  return { schemaVersion: 2, id, ownerId: 'synthetic-main', name, parentId: null, childSequence: 0,
    createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z', mode: 'quick', targetLanguage: '中文', instruction: '',
    maxInputChars: 20000, model: null, input: '', legacyManualText: '', legacyKey: null }
}

test('历史选择在事件currentTarget清空后延迟更新仍支持勾选、取消、多选与删除确认取消', async () => {
  const app = mount({ deferFunctionalUpdates: true, history: [history('synthetic-a', 'A'), history('synthetic-b', 'B'), history('synthetic-c', 'C')] })
  const ui = app.renderer
  try {
    ui.render(app.settingsPage, {}); await ui.flush()
    await ui.check('选择会话 A', true)
    assert.equal(ui.control('选择会话 A').props.checked, true); assert.equal(ui.button('删除所选历史（1）').props.disabled, false)
    await ui.check('选择会话 A', false)
    assert.equal(ui.control('选择会话 A').props.checked, false); assert.equal(ui.button('删除所选历史（0）').props.disabled, true)
    for (const name of ['A', 'B', 'C']) await ui.check(`选择会话 ${name}`, true)
    assert.equal(ui.button('删除所选历史（3）').props.disabled, false)
    await ui.click('删除所选历史（3）'); assert.match(ui.text(), /将删除 3 条会话历史/)
    await ui.click('取消')
    assert.ok(!ui.nodes().some(node => node.props.role === 'dialog'))
    assert.equal(ui.button('删除所选历史（3）').props.disabled, false)
    for (const name of ['A', 'B', 'C']) assert.equal(ui.control(`选择会话 ${name}`).props.checked, true)
    await ui.check('选择会话 B', false)
    await ui.click('删除所选历史（2）'); await ui.click('确认删除历史')
    assert.ok(!ui.nodes().some(node => node.props['aria-label'] === '选择会话 A' || node.props['aria-label'] === '选择会话 C'))
    assert.equal(ui.control('选择会话 B').props.checked, false)
    assert.equal(ui.button('删除所选历史（0）').props.disabled, true)
    assert.ok(ui.deferredUpdateCount >= 6, 'functional updaters actually ran after dispatch cleared currentTarget')
  } finally { await app.dispose() }
})
