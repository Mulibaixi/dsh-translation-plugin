import assert from 'node:assert/strict'
import test from 'node:test'
import { mount } from './quick-client-fixture.mjs'

// This observes published bundle props. Native Menu's actual layout dependencies
// are audited separately; the light renderer does not measure desktop pixels.
async function setup(catalog) {
  let menu
  const app = mount({ ...(catalog ? { catalog } : {}), observeMenu: props => {
    if (props.className === 'dsh-tp-model-anchor') menu = props
  } }), ui = app.renderer
  ui.render(app.panel, { sessionId: 'synthetic-placement-owner' }); await ui.flush()
  await ui.click('模型：选择模型'); await ui.flush()
  return { app, ui, menu: () => menu }
}
function assertNativePlacement(menu) {
  assert.equal(menu.open, true); assert.equal(menu.portal, true)
  assert.equal(menu.side, 'top'); assert.equal(menu.align, 'end')
  assert.equal(menu.className, 'dsh-tp-model-anchor'); assert.equal(menu.key, undefined)
}

test('发布bundle模型列表/搜索变化更新原生layout定位依赖，同内容重渲染保持稳定且不刷新目录', async () => {
  const f = await setup()
  try {
    assertNativePlacement(f.menu())
    const root = f.menu().getAnchorRect
    assert.equal(root(), null)
    const rect = { top: 400, right: 600, bottom: 426, left: 510, width: 90, height: 26 }
    f.ui.button('模型：选择模型').props.ref.current = { getBoundingClientRect: () => rect }
    assert.equal(root(), rect)
    await f.ui.flush(); assert.equal(f.menu().getAnchorRect, root)
    await f.ui.click('选择模型')
    assertNativePlacement(f.menu()); assert.notEqual(f.menu().getAnchorRect, root)
    assert.equal(f.menu().getAnchorRect(), rect); assert.ok(f.ui.button('Model 1'))
    const modelList = f.menu().getAnchorRect
    await f.ui.flush(); assert.equal(f.menu().getAnchorRect, modelList)
    await f.ui.input('搜索模型', 'Model 2')
    assert.notEqual(f.menu().getAnchorRect, modelList)
    assert.ok(!f.ui.nodes().some(node => node.type === 'button' && f.ui.text(node) === 'Model 1'))
    const filtered = f.menu().getAnchorRect
    await f.ui.flush(); assert.equal(f.menu().getAnchorRect, filtered)
    await f.ui.input('搜索模型', '')
    assert.notEqual(f.menu().getAnchorRect, filtered)
    await f.ui.click('Model 1')
    assertNativePlacement(f.menu()); assert.ok(f.ui.button('选择模型'))
    f.menu().onClose(); f.ui.render(); await f.ui.click('模型：Model 1')
    assert.equal(f.app.catalogCalls, 1, 'opening cached menus does not clear or reload the directory')
    assert.ok(!f.ui.text().includes('正在加载模型'))
  } finally { await f.app.dispose() }
})

test('发布bundle推理等级列表切换同步提供重测信号，实际route/Default选择和关闭重开仍正常', async () => {
  const f = await setup({ ok: true, value: { default: null,
    groups: [{ id: 'synthetic', name: 'Provider', models: [{ id: 'reasoner', name: 'Reasoner', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }] }], failures: [],
  } })
  try {
    await f.ui.click('选择模型'); await f.ui.click('Reasoner')
    const root = f.menu().getAnchorRect
    await f.ui.click('选择推理等级')
    assertNativePlacement(f.menu()); assert.notEqual(f.menu().getAnchorRect, root)
    assert.equal(f.ui.button('Default ✓').props['aria-checked'], true)
    assert.equal(f.ui.button('High').props['aria-checked'], false)
    const efforts = f.menu().getAnchorRect
    await f.ui.flush(); assert.equal(f.menu().getAnchorRect, efforts)
    await f.ui.click('High'); assert.equal(f.menu().open, false)
    await f.ui.click('模型：Reasoner · High')
    assert.ok(f.ui.button('选择推理等级')); assert.ok(!f.ui.nodes().some(node => node.type === 'button' && f.ui.text(node) === 'High'))
    await f.ui.click('选择推理等级')
    assert.equal(f.ui.button('High ✓').props['aria-checked'], true)
    assert.equal(f.ui.button('Default').props['aria-checked'], false)
    await f.ui.click('Default')
    assert.equal(f.menu().open, false); assert.ok(f.ui.button('模型：Reasoner · Default'))
    assert.equal(f.app.catalogCalls, 1)
  } finally { await f.app.dispose() }
})
