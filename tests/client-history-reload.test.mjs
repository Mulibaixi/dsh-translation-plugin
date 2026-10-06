import assert from 'node:assert/strict'
import test from 'node:test'
import { mount } from './quick-client-fixture.mjs'

const SETTINGS_KEY = 'dsh-translation-plugin:settings:v2'
const HISTORY_PREFIX = 'dsh-translation-plugin:history:v2:'
const catalog = { ok: true, value: { default: null, failures: [], groups: [{ id: 'synthetic', name: 'Synthetic', models: [{
  id: 'reasoner', name: 'Synthetic Reasoner', reasoning: { efforts: [{ id: 'high', name: 'High' }] },
}] }] } }
const title = ui => ui.nodes().find(node => node.type === 'button' && node.props.className === 'dsh-tp-current-title')
const history = storage => [...storage.values].filter(([key]) => key.startsWith(HISTORY_PREFIX)).map(([, raw]) => JSON.parse(raw).session)

test('发布bundle：开启历史后重命名与模型/推理等级使用完整存储重挂载恢复，目录加载不清选择', async () => {
  const first = mount({ catalog }); const ui = first.renderer
  let restarted
  try {
    // Toggle the actual settings control, then use the panel's actual rename/model handlers.
    ui.render(first.settingsPage, {}); await ui.remember(true)
    assert.equal(JSON.parse(first.storage.getItem(SETTINGS_KEY)).rememberHistory, true)
    ui.render(first.panel, { sessionId: 'synthetic-main' }); await ui.flush()
    ui.context(title(ui)); await ui.click('重命名')
    await ui.input('主题名称', '合成主题'); await ui.click('确认重命名主题')
    await ui.click('模型：选择模型'); await ui.click('选择模型'); await ui.click('Synthetic Reasoner')
    await ui.click('选择推理等级'); await ui.click('High')
    await ui.input('待翻译内容', 'Synthetic draft')
    const saved = history(first.storage)
    assert.equal(saved.length, 1)
    assert.deepEqual(saved[0].model, { provider: 'synthetic', model: 'reasoner', reasoningEffort: 'high' })
    await first.dispose()

    restarted = mount({ storage: first.storage, catalog })
    const next = restarted.renderer
    next.render(restarted.panel, { sessionId: 'synthetic-main' }); await next.flush()
    assert.equal(next.text(title(next)), '合成主题')
    assert.equal(next.control('待翻译内容').props.value, 'Synthetic draft')
    // The initial label can use saved IDs until the Host directory supplies display names.
    const modelButton = next.nodes().find(node => node.type === 'button' && node.props['aria-label']?.startsWith('模型：'))
    assert.match(modelButton.props['aria-label'], /reasoner|Synthetic Reasoner/)
    assert.match(modelButton.props['aria-label'], /high|High/)
    await next.click(modelButton.props['aria-label']); await next.flush()
    assert.ok(next.button('模型：Synthetic Reasoner · High'))
    assert.equal(next.button('选择推理等级').props.disabled, false)
    assert.deepEqual(history(restarted.storage)[0].model, saved[0].model)
    assert.equal(history(restarted.storage)[0].id, saved[0].id)
  } finally { await first.dispose(); await restarted?.dispose() }
})
