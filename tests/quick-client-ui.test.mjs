import assert from 'node:assert/strict'
import test from 'node:test'
import { mount } from './quick-client-fixture.mjs'

const ok = value => ({ ok: true, value })
function remote(overrides = {}) {
  const calls = { open: [], submit: [], status: [], cancel: [] }
  const latest = new Map()
  const job = (request, patch = {}) => ({ sessionKey: request.sessionKey, operationId: request.operationId, draftVersion: request.draftVersion, accepted: true, status: 'completed', text: 'Synthetic translation', ...patch })
  const domain = {
    async capabilities() { return ok({ ready: true, mode: 'quick', storage: 'runtime_only' }) },
    async open(request) { calls.open.push(request); return ok({ ...request, sessionKey: 'quick:ui-synthetic-' + calls.open.length }) },
    async submit(request) { calls.submit.push(request); latest.set(request.operationId, request); return ok(job(request)) },
    async status(request) { calls.status.push(request); return ok(job(latest.get(request.operationId))) },
    async cancel(request) { calls.cancel.push(request); return ok(job(latest.get(request.operationId), { status: 'cancelled', text: '' })) },
    ...overrides,
  }
  return { calls, domain, job, port: Object.fromEntries(Object.keys(domain).map(name => [name, async (...args) => ok(await domain[name](...args))])) }
}
async function start(app) {
  const ui = app.renderer
  ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush()
  await ui.click('模型：选择模型'); await ui.flush(); await ui.click('选择模型'); await ui.click('Model 1')
  return ui
}

test('真实bundle顶部仅模式/语言，空原文和未选模型只在发送title提示，圆形/字号/对齐保留', async () => {
  const rpc = remote(); const app = mount({ quick: rpc.port }); const ui = app.renderer
  try {
    ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush()
    assert.equal(ui.button('发送快译').props.disabled, true)
    assert.equal(ui.button('发送快译').props.title, '请输入待翻译内容。')
    assert.ok(!ui.text().includes('请输入待翻译内容。'))
    assert.ok(!ui.nodes().some(node => node.props.className === 'dsh-tp-service-status' || node.props.className === 'dsh-tp-runtime-note'))
    assert.ok(!ui.nodes().some(node => node.props['aria-label'] === '翻译要求' || node.props['aria-label'] === '编辑翻译要求'))
    const options = ui.nodes().find(node => node.props.className === 'dsh-tp-header-options')
    assert.deepEqual(ui.nodes(options).filter(node => node.type === 'button').map(node => node.props['aria-label']), ['选择翻译模式', '选择目标语言'])
    await ui.input('待翻译内容', 'Synthetic source')
    assert.match(ui.button('发送快译').props.title, /请选择当前目录中的模型/)
    assert.ok(!ui.text().includes('请选择当前目录中的模型'))
    const send = ui.button('发送快译')
    assert.equal(send.props.style.borderRadius, '50%'); assert.equal(send.props.style.cornerShape, 'round')
    const css = ui.nodes().filter(node => node.type === 'style').map(node => node.children.join('')).join('')
    assert.match(css, /header-options[^}]*justify-content: flex-end/)
    assert.match(css, /composer-toolbar[^}]*justify-content: flex-end/)
    assert.match(css, /model-menu .dsh-tp-menu-content[^}]*font-size: 11px/)
    assert.match(css, /model-search:focus[^}]*outline: none/)
    assert.equal(rpc.calls.submit.length, 0)
  } finally { app.dispose() }
})

test('真实bundle发送使用会话默认要求，译文关联目标语且不落盘，重挂载不恢复', async () => {
  const rpc = remote(); const app = mount({ quick: rpc.port, settings: { schemaVersion: 2, defaultMode: 'quick', targetLanguage: 'English', defaultInstruction: 'Keep synthetic terms', maxInputChars: 20000, rememberHistory: false } })
  try {
    const ui = await start(app); await ui.input('待翻译内容', 'Synthetic source'); await ui.click('发送快译')
    assert.equal(rpc.calls.submit.length, 1)
    assert.equal(rpc.calls.submit[0].instruction, 'Keep synthetic terms')
    assert.equal(rpc.calls.submit[0].targetLanguage, 'English')
    assert.equal(ui.control('待翻译内容').props.value, '')
    const record = ui.nodes().find(node => node.type === 'article')
    assert.equal(ui.text(record.children[0]), '原文')
    assert.match(ui.text(record), /版本 1 · 译文 · English/)
    assert.match(ui.text(), /本次内容仅保留在本次运行/)
    const composerArea = ui.nodes().find(node => node.props.className === 'dsh-tp-composer-area')
    assert.ok(!ui.nodes(composerArea).some(node => node.props.className === 'dsh-tp-history-note'))
    assert.ok(ui.nodes(ui.nodes().find(node => node.props.className === 'dsh-tp-transcript')).some(node => node.props.className === 'dsh-tp-history-note'))
    assert.ok([...app.storage.values.values()].every(value => !value.includes('Synthetic translation')))
    const restored = mount({ quick: rpc.port })
    try { restored.renderer.render(restored.panel, { sessionId: 'synthetic-main' }); assert.ok(!restored.renderer.text().includes('Synthetic translation')) }
    finally { restored.dispose() }
  } finally { app.dispose() }
})

test('真实bundle取消未确认显示unknown并查询本轮，Host终态后恢复新发；普通模式不可执行', async () => {
  const rpc = remote(); rpc.domain.submit = async request => { rpc.calls.submit.push(request); return ok(rpc.job(request, { status: 'running', text: '' })) }
  rpc.domain.cancel = async request => { rpc.calls.cancel.push(request); return ok(rpc.job(rpc.calls.submit[0], { status: 'unknown', text: '' })) }
  rpc.domain.status = async request => { rpc.calls.status.push(request); return ok(rpc.job(rpc.calls.submit[0], { status: 'cancelled', text: '' })) }
  const app = mount({ quick: rpc.port })
  try {
    const ui = await start(app); await ui.input('待翻译内容', 'Synthetic source'); await ui.click('发送快译'); await ui.click('取消翻译')
    assert.match(ui.text(), /执行结果未知/); assert.match(ui.text(), /Host 停止尚未确认/)
    await ui.input('待翻译内容', 'New draft'); await ui.click('查询本轮结果')
    assert.equal(ui.control('待翻译内容').props.value, 'New draft')
    assert.equal(ui.button('发送快译').props.disabled, false); assert.equal(rpc.calls.submit.length, 1)
    await ui.input('翻译模式', 'normal')
    assert.equal(ui.button('发送快译').props.disabled, true)
    assert.match(ui.text(), /普通模式需主模型协作，尚未接入/)
    const statusLine = ui.nodes().find(node => node.props.className === 'dsh-tp-service-status')
    assert.match(ui.text(statusLine), /普通模式需主模型协作/)
    assert.ok(!ui.nodes(ui.nodes().find(node => node.props.className === 'dsh-tp-composer')).includes(statusLine))
    assert.equal(ui.button('发送快译').props['aria-description'], ui.button('发送快译').props.title)
  } finally { app.dispose() }
})

test('服务状态紧贴输入框外，检查图标仅检查服务，检查中禁用且就绪后隐藏', async () => {
  let release
  let checks = 0
  const held = new Promise(resolve => { release = resolve })
  const rpc = remote({ async capabilities() {
    checks++
    return checks === 1 ? ok({ ready: false, mode: 'quick', storage: 'runtime_only', reason: 'Synthetic host unavailable' }) : held
  } })
  const app = mount({ quick: rpc.port })
  try {
    const ui = app.renderer; ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush()
    await ui.input('待翻译内容', 'Synthetic draft')
    const area = ui.nodes().find(node => node.props.className === 'dsh-tp-composer-area')
    assert.equal(area.children[0].props.className, 'dsh-tp-service-status')
    assert.equal(area.children[1].props.className, 'dsh-tp-composer')
    assert.ok(!ui.nodes(area.children[1]).some(node => node.props.className === 'dsh-tp-service-status'))
    assert.equal(ui.button('发送快译').props.title, 'Synthetic host unavailable')
    const recheck = ui.button('重新检查翻译服务')
    assert.equal(recheck.props.type, 'button')
    assert.match(recheck.props.title, /不发送翻译请求/)
    assert.equal(ui.text(recheck), '')
    assert.equal(ui.nodes(recheck).filter(node => node.type === 'svg').length, 1)
    await ui.click('重新检查翻译服务')
    assert.equal(checks, 2)
    assert.equal(ui.button('重新检查翻译服务').props.disabled, true)
    assert.equal(ui.button('重新检查翻译服务').props['aria-busy'], true)
    assert.match(ui.text(ui.nodes().find(node => node.props.className === 'dsh-tp-service-status')), /正在检查翻译服务/)
    assert.equal(rpc.calls.open.length, 0); assert.equal(rpc.calls.submit.length, 0)
    assert.equal(ui.control('待翻译内容').props.value, 'Synthetic draft')
    release(ok({ ready: true, mode: 'quick', storage: 'runtime_only' })); await ui.flush()
    assert.ok(!ui.nodes().some(node => node.props.className === 'dsh-tp-service-status'))
    assert.equal(rpc.calls.submit.length, 0)
  } finally { app.dispose() }
})

test('真实bundle超限/能力异常保留说明与正文', async () => {
  const rpc = remote({ async capabilities() { return ok({ ready: false, mode: 'quick', storage: 'runtime_only', reason: 'Synthetic host unavailable' }) } })
  const app = mount({ quick: rpc.port, settings: { schemaVersion: 2, defaultMode: 'quick', targetLanguage: 'English', defaultInstruction: '', maxInputChars: 1, rememberHistory: false } })
  try {
    const ui = app.renderer; ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush()
    assert.match(ui.text(), /Synthetic host unavailable/)
    await ui.input('待翻译内容', '😀😀')
    assert.match(ui.text(), /已超过单次上限 1 个字符/)
    assert.equal(ui.control('待翻译内容').props.value, '😀😀'); assert.equal(rpc.calls.submit.length, 0)
  } finally { app.dispose() }
})

test('真实bundle主会话切换期间的迟到结果只回原会话且不清新输入', async () => {
  let release
  const held = new Promise(resolve => { release = resolve })
  const rpc = remote()
  rpc.domain.submit = async request => { rpc.calls.submit.push(request); return held }
  const app = mount({ quick: rpc.port })
  try {
    const ui = await start(app); await ui.input('待翻译内容', 'Synthetic source'); await ui.click('发送快译')
    ui.render(app.panel, { sessionId: 'synthetic-other-main' }); await ui.input('待翻译内容', 'Other source')
    release(ok(rpc.job(rpc.calls.submit[0]))); await ui.flush()
    assert.equal(ui.control('待翻译内容').props.value, 'Other source')
    assert.ok(!ui.text().includes('Synthetic translation'))
    ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush()
    assert.match(ui.text(), /Synthetic translation/); assert.equal(ui.control('待翻译内容').props.value, '')
  } finally { app.dispose() }
})

test('发布bundle版本交互：原文仅一次、旧版展开固定、当前模型重译不消费新草稿、每版复制与详情', async () => {
  const rpc = remote()
  rpc.domain.submit = async request => {
    rpc.calls.submit.push(structuredClone(request))
    return ok(rpc.job(request, { text: `Synthetic version ${rpc.calls.submit.length}` }))
  }
  const app = mount({ quick: rpc.port })
  try {
    const ui = await start(app)
    await ui.input('待翻译内容', 'Synthetic frozen source'); await ui.click('发送快译')
    assert.match(ui.text(), /待定稿/)
    await ui.input('待翻译内容', 'Synthetic next draft')
    await ui.input('目标语言', 'English')
    await ui.click('选择模型'); await ui.click('Model 2')
    await ui.click('重译文本 1')
    assert.equal(rpc.calls.submit.length, 2)
    assert.equal(rpc.calls.submit[1].sourceText, 'Synthetic frozen source')
    assert.equal(rpc.calls.submit[1].targetLanguage, '中文')
    assert.equal(rpc.calls.submit[1].model.modelId, 'm2')
    assert.equal(ui.control('待翻译内容').props.value, 'Synthetic next draft')
    assert.match(ui.text(), /Synthetic version 2/); assert.ok(!ui.text().includes('Synthetic version 1'))
    assert.equal(ui.nodes().filter(node => node.props.className === 'dsh-tp-translation-text' && ui.text(node) === 'Synthetic frozen source').length, 1)
    await ui.click('文本 1旧版本')
    assert.match(ui.text(), /Synthetic version 1/)
    await ui.click('文本 1 版本 1设为最终')
    assert.match(ui.text(), /用户固定：版本 1/)
    await ui.click('复制文本 1 版本 1'); assert.deepEqual(app.copies, ['Synthetic version 1'])
    await ui.click('重译文本 1')
    assert.match(ui.text(), /用户固定：版本 1/); assert.match(ui.text(), /Synthetic version 3/)
    assert.equal(ui.control('待翻译内容').props.value, 'Synthetic next draft')
    await ui.click('文本 1 版本 3详情')
    assert.match(ui.text(), /模型：provider-a\/m2 · 推理：Default/)
    assert.equal(ui.nodes().filter(node => node.type === 'time' && node.props.dateTime).length, 2)
    assert.equal(ui.button('文本 1 版本 1设为最终').props.disabled, true)
    await ui.click('文本 1旧版本')
    assert.ok(!ui.text().includes('Synthetic version 1'))
    await ui.click('发送快译')
    assert.match(ui.text(), /用户固定：版本 1/)
    assert.equal(rpc.calls.submit.length, 4)
  } finally { await app.dispose() }
})

test('发布bundle保存开关：真实保存并恢复版本/定稿，关闭保留旧副本且说明位于记录区', async () => {
  const rpc = remote()
  rpc.domain.submit = async request => {
    rpc.calls.submit.push(structuredClone(request))
    return ok(rpc.job(request, { text: `Synthetic saved version ${rpc.calls.submit.length}` }))
  }
  const app = mount({ quick: rpc.port, settings: { schemaVersion: 2, defaultMode: 'quick', targetLanguage: '中文', defaultInstruction: '', maxInputChars: 20000, rememberHistory: true } })
  let restored
  let reopened
  try {
    const ui = await start(app)
    await ui.input('待翻译内容', 'Synthetic saved source'); await ui.click('发送快译')
    await ui.click('重译文本 1'); await ui.click('文本 1旧版本'); await ui.click('文本 1 版本 1设为最终')
    await ui.flush(); await ui.flush()
    assert.match(ui.text(), /已开启历史保存/)
    await app.dispose()
    restored = mount({ quick: rpc.port, storage: app.storage, deferFunctionalUpdates: true })
    const saved = restored.renderer; saved.render(restored.panel, { sessionId: 'synthetic-main' }); await saved.flush()
    await saved.click('模型：provider-a/m1'); await saved.flush()
    assert.match(saved.text(), /用户固定：版本 1/); assert.match(saved.text(), /Synthetic saved version 2/)
    assert.ok(!saved.text().includes('Synthetic saved version 1'))
    await saved.click('文本 1旧版本'); assert.match(saved.text(), /Synthetic saved version 1/)
    saved.render(restored.settingsPage, {}); await saved.flush()
    await saved.check('允许保存会话历史到本地', false)
    saved.render(restored.panel, { sessionId: 'synthetic-main' }); await saved.flush()
    assert.match(saved.text(), /已保存的历史保留；后续内容仅保留在本次运行。/)
    await saved.click('重译文本 1'); await saved.flush()
    assert.match(saved.text(), /Synthetic saved version 3/)
    const transcript = saved.nodes().find(node => node.props.className === 'dsh-tp-transcript')
    assert.equal(saved.nodes(transcript).filter(node => node.props.className === 'dsh-tp-history-note').length, 1)
    assert.ok(!saved.nodes(saved.nodes().find(node => node.props.className === 'dsh-tp-composer-area')).some(node => node.props.className === 'dsh-tp-history-note'))
    await restored.dispose()
    reopened = mount({ quick: rpc.port, storage: app.storage })
    reopened.renderer.render(reopened.panel, { sessionId: 'synthetic-main' }); await reopened.renderer.flush()
    assert.match(reopened.renderer.text(), /Synthetic saved version 2/)
    assert.ok(!reopened.renderer.text().includes('Synthetic saved version 3'))
    assert.match(reopened.renderer.text(), /用户固定：版本 1/)
  } finally { await reopened?.dispose(); await restored?.dispose(); await app.dispose() }
})

test('发布bundle失败新版继续显示，不能设为最终；未定稿不自动取旧成功版', async () => {
  const rpc = remote()
  rpc.domain.submit = async request => {
    rpc.calls.submit.push(structuredClone(request))
    return ok(rpc.job(request, rpc.calls.submit.length === 2 ? { status: 'failed', text: 'Synthetic partial output', error: { code: 'EXECUTION_FAILED', message: 'Synthetic failure', stage: 'stream' } } : {}))
  }
  const app = mount({ quick: rpc.port })
  try {
    const ui = await start(app); await ui.input('待翻译内容', 'Synthetic source'); await ui.click('发送快译')
    await ui.click('重译文本 1')
    assert.match(ui.text(), /版本 2 · 翻译失败/); assert.match(ui.text(), /未完成输出/)
    assert.equal(ui.button('文本 1 版本 2设为最终').props.disabled, true)
    await ui.input('待翻译内容', 'Synthetic next source'); await ui.click('发送快译')
    assert.ok(!ui.text().includes('自动最终'))
    await ui.click('文本 1旧版本'); await ui.click('文本 1 版本 1设为最终')
    assert.match(ui.text(), /用户固定：版本 1/)
  } finally { await app.dispose() }
})

test('发布bundle新稿受理后展示自动最终最新版，手动固定仍可在旧版列表操作', async () => {
  const rpc = remote(); const app = mount({ quick: rpc.port })
  try {
    const ui = await start(app); await ui.input('待翻译内容', 'Synthetic first source'); await ui.click('发送快译')
    await ui.click('重译文本 1'); assert.match(ui.text(), /待定稿/)
    await ui.input('待翻译内容', 'Synthetic second source'); await ui.click('发送快译')
    assert.match(ui.text(), /自动最终：版本 2/)
    await ui.click('文本 1旧版本'); await ui.click('文本 1 版本 1设为最终')
    assert.match(ui.text(), /用户固定：版本 1/)
  } finally { await app.dispose() }
})

test('发布bundle恢复进行中历史显示中断，无虚假查询句柄，显式重译恢复且保护草稿', async () => {
  const rpc = remote()
  rpc.domain.submit = async request => {
    rpc.calls.submit.push(structuredClone(request))
    return ok(rpc.job(request, { status: rpc.calls.submit.length === 1 ? 'running' : 'completed', text: rpc.calls.submit.length === 1 ? '' : 'Synthetic recovery translation' }))
  }
  rpc.domain.cancel = async request => ok(rpc.job(rpc.calls.submit[0], { status: 'cancelled', text: '' }))
  const app = mount({ quick: rpc.port, settings: { schemaVersion: 2, defaultMode: 'quick', targetLanguage: '中文', defaultInstruction: '', maxInputChars: 20000, rememberHistory: true } })
  let restored
  try {
    const ui = await start(app); await ui.input('待翻译内容', 'Synthetic interrupted source'); await ui.click('发送快译')
    await ui.input('待翻译内容', 'Synthetic recovery draft'); await ui.flush(); await app.dispose()
    restored = mount({ quick: rpc.port, storage: app.storage })
    const saved = restored.renderer; saved.render(restored.panel, { sessionId: 'synthetic-main' }); await saved.flush()
    assert.match(saved.text(), /重启前未确认／已中断/)
    assert.ok(!saved.nodes().some(node => node.type === 'button' && saved.text(node) === '查询本轮结果'))
    await saved.click('模型：provider-a/m1'); await saved.flush(); await saved.click('重译文本 1')
    assert.match(saved.text(), /Synthetic recovery translation/)
    assert.equal(saved.control('待翻译内容').props.value, 'Synthetic recovery draft')
    assert.equal(rpc.calls.status.length, 0); assert.equal(rpc.calls.submit.length, 2)
    await saved.click('文本 1旧版本'); assert.match(saved.text(), /重启前未确认／已中断/)
  } finally { await restored?.dispose(); await app.dispose() }
})

test('发布bundle复制失败保留版本并显示可重试提示', async () => {
  let attempts = 0
  const app = mount({ quick: remote().port, clipboard: { async writeText() { if (++attempts === 1) throw new Error('Synthetic clipboard rejection') } } })
  try {
    const ui = await start(app); await ui.input('待翻译内容', 'Synthetic copy source'); await ui.click('发送快译')
    await ui.click('复制文本 1 版本 1'); assert.match(ui.text(), /复制失败，请重试。/)
    assert.match(ui.text(), /Synthetic translation/)
    await ui.click('复制文本 1 版本 1'); assert.ok(!ui.text().includes('复制失败'))
    assert.equal(ui.text(ui.button('复制文本 1 版本 1')), '已复制')
  } finally { await app.dispose() }
})
