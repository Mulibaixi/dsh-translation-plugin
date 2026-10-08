import assert from 'node:assert/strict'
import test from 'node:test'
import { mount } from './quick-client-fixture.mjs'

function currentTitle(ui) { return ui.nodes().find(node => node.props.className === 'dsh-tp-current-title') }
async function rename(ui, name) {
  ui.context(currentTitle(ui)); await ui.click('重命名'); await ui.input('主题名称', name); await ui.click('确认重命名主题')
}
async function create(ui, name) {
  await ui.click('切换会话侧栏'); await ui.click('新建主题及首会话'); await ui.click('切换会话侧栏'); await rename(ui, name)
}
async function switchSession(ui, name) {
  currentTitle(ui).props.onClick(); ui.render(); await ui.click(`切换翻译会话：${name}`)
}
function fileInput(ui) {
  return ui.nodes().find(node => node.props.className === 'dsh-tp-composer-toolbar').children.find(node => node?.type === 'input' && node.props.type === 'file')
}
async function chooseFile(ui, file) {
  const input = fileInput(ui); assert.equal(input.props.disabled, false)
  const target = { files: [file], value: 'synthetic browser selection' }
  input.props.onChange({ currentTarget: target }); ui.render(); await ui.flush()
  assert.equal(target.value, '', 'the browser picker can select the same file again')
}
const quick = { async capabilities() { return { ok: true, value: { ok: true, value: { ready: true, mode: 'quick', storage: 'runtime_only' } } } } }

test('反复新建切换仅保留一个模式和语言控件，菜单仍操作当前会话', async () => {
  const app = mount({ quick }); const ui = app.renderer
  try {
    ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush(); await rename(ui, 'A')
    await ui.input('翻译模式', 'normal'); await ui.click('选择目标语言'); await ui.click('English')
    await create(ui, 'B')
    for (const name of ['C', 'D', 'E']) {
      await create(ui, name)
      const options = ui.nodes().find(node => node.props.className === 'dsh-tp-header-options')
      assert.equal(ui.nodes(options).filter(node => node.type === 'button').length, 2)
      await ui.click('选择翻译模式'); await ui.click('选择翻译模式')
    }
    for (let i = 0; i < 5; i++) {
      for (const [name, mode, language] of [['A', '普通', 'English'], ['B', '快译', '中文']]) {
        await switchSession(ui, name)
        const options = ui.nodes().find(node => node.props.className === 'dsh-tp-header-options')
        const buttons = ui.nodes(options).filter(node => node.type === 'button')
        assert.deepEqual(buttons.map(node => node.props['aria-label']), ['选择翻译模式', '选择目标语言'])
        assert.equal(ui.text(buttons[0]), mode); assert.equal(ui.text(buttons[1]), language)
        await ui.click('选择翻译模式'); assert.equal(ui.button('选择翻译模式').props['aria-expanded'], true)
        await ui.click('选择翻译模式'); await ui.click('选择目标语言'); await ui.click(language)
      }
    }
    await ui.input('翻译模式', 'normal'); await ui.click('选择目标语言'); await ui.click('日本語')
    await switchSession(ui, 'A'); assert.equal(ui.text(ui.button('选择目标语言')), 'English')
    await switchSession(ui, 'B'); assert.equal(ui.text(ui.button('选择目标语言')), '日本語')
  } finally { await app.dispose() }
})

test('快译禁用文件入口，普通可选移除文件且会话隔离、不读字节或持久化', async () => {
  let submits = 0
  const app = mount({ quick: { ...quick, async submit() { submits++; throw new Error('no file submission expected') } } }); const ui = app.renderer
  const a = new File(['Synthetic contents'], 'synthetic-a.txt')
  const b = new File(['Synthetic contents'], 'synthetic-b.pdf')
  for (const file of [a, b]) for (const method of ['text', 'arrayBuffer', 'stream']) file[method] = () => assert.fail('file contents must not be read')
  try {
    ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush(); await rename(ui, 'A')
    assert.equal(ui.button('选择待译文件').props.disabled, true); assert.equal(fileInput(ui).props.disabled, true)
    assert.match(ui.button('选择待译文件').props.title, /快译仅支持纯文本/)
    await ui.input('翻译模式', 'normal')
    let pickerClicks = 0; fileInput(ui).props.ref.current = { click() { pickerClicks++ } }
    await ui.click('选择待译文件'); assert.equal(pickerClicks, 1)
    await chooseFile(ui, a); assert.match(ui.text(), /synthetic-a.txt/)
    assert.match(ui.text(), /文件翻译尚未接入，所选文件仅暂存于本次打开的面板/)
    assert.equal(ui.button('发送待译材料').props.disabled, true)
    await create(ui, 'B'); assert.ok(!ui.text().includes(a.name)); assert.equal(ui.button('选择待译文件').props.disabled, true)
    await ui.input('翻译模式', 'normal'); await chooseFile(ui, b)
    await switchSession(ui, 'A'); assert.match(ui.text(), /synthetic-a.txt/); assert.ok(!ui.text().includes(b.name))
    await ui.click('移除待译文件'); assert.ok(!ui.text().includes(a.name))
    await switchSession(ui, 'B'); assert.match(ui.text(), /synthetic-b.pdf/)
    assert.equal(submits, 0)
    assert.ok([...app.storage.values.values()].every(value => !value.includes(a.name) && !value.includes(b.name)))
    ui.context(currentTitle(ui)); await ui.click('删除'); await ui.click('确认删除会话')
    assert.ok(!ui.text().includes(b.name))
  } finally { await app.dispose() }
})

test('切换所属主会话和关闭面板后不串所选文件', async () => {
  const app = mount({ quick }); const ui = app.renderer
  try {
    ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush()
    await ui.input('翻译模式', 'normal'); await chooseFile(ui, new File(['Synthetic'], 'synthetic-local.txt'))
    ui.render(app.panel, { sessionId: 'synthetic-other' }); await ui.flush(); assert.ok(!ui.text().includes('synthetic-local.txt'))
    ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush(); assert.ok(!ui.text().includes('synthetic-local.txt'))
    await chooseFile(ui, new File(['Synthetic'], 'synthetic-reopened.txt'))
    ui.render(app.settingsPage, {}); await ui.flush()
    assert.match(ui.text(), /主题名称、会话配置和当前原文草稿/)
    assert.match(ui.text(), /模型与推理等级选择独立保存在此设备，不受此开关影响/)
    assert.match(ui.text(), /已受理的原文、各版译文与定稿选择/)
    ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush(); assert.ok(!ui.text().includes('synthetic-reopened.txt'))
  } finally { await app.dispose() }
})
