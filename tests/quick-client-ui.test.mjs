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
    assert.equal(ui.button('发送待译材料').props.disabled, true)
    assert.match(ui.text(), /当前 DSH 缺少同步发送材料接口/)
    const statusLine = ui.nodes().find(node => node.props.className === 'dsh-tp-service-status')
    assert.match(ui.text(statusLine), /当前 DSH 缺少同步发送材料接口/)
    assert.ok(!ui.nodes(ui.nodes().find(node => node.props.className === 'dsh-tp-composer')).includes(statusLine))
    assert.equal(ui.button('发送待译材料').props['aria-description'], ui.button('发送待译材料').props.title)
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
    const children = area.children.filter(Boolean)
    assert.equal(children[0].props.className, 'dsh-tp-service-status')
    assert.equal(children[1].props.className, 'dsh-tp-composer')
    assert.ok(!ui.nodes(children[1]).some(node => node.props.className === 'dsh-tp-service-status'))
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
    assert.doesNotMatch(ui.text(), /已开启历史保存/)
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

const currentTitle = ui => ui.nodes().find(node => node.props.className === 'dsh-tp-current-title')
async function exportFromTitle(ui, label, scope = '当前会话') {
  const model = ui.nodes().find(node => node.props.className === 'dsh-tp-model-trigger' && node.props['aria-expanded'])
  if (model) await ui.click(model.props['aria-label'])
  ui.context(currentTitle(ui)); await ui.click(label)
  await ui.click(scope)
}
function callMetadata(request, inputTokens = 7, outputTokens = 4) {
  return { promptVersion: 'text-runtime-v1', model: { provider: request.model.providerId, model: request.model.modelId, reasoningEffort: request.model.reasoningEffort ?? null }, configVersion: null, maxOutputTokens: 1024, usage: { inputTokens, outputTokens } }
}
async function exportFromSession(ui, sessionId, label, scope) {
  currentTitle(ui).props.onClick(); ui.render()
  const row = ui.nodes().find(node => node.props.className === 'dsh-tp-session-choice' && node.props.key === sessionId); assert.ok(row)
  ui.context(row); await ui.click(label)
  assert.equal(currentTitle(ui).props['aria-expanded'], false)
  await ui.click(scope)
}

test('发布bundle人工编辑：跨会话保留草稿、新机器版到达仍基于原版追加，保存候选不调用模型', async () => {
  const rpc = remote()
  rpc.domain.submit = async request => { rpc.calls.submit.push(structuredClone(request)); return ok(rpc.job(request, { text: `Synthetic machine ${rpc.calls.submit.length}` })) }
  const app = mount({ quick: rpc.port, deferFunctionalUpdates: true })
  try {
    const ui = await start(app); await ui.input('待翻译内容', 'Synthetic immutable source'); await ui.click('发送快译')
    await ui.click('编辑文本 1 版本 1'); await ui.input('编辑文本 1 版本 1译文', 'Synthetic manual draft')
    ui.render(app.panel, { sessionId: 'synthetic-other-main' }); await ui.flush()
    assert.ok(!ui.nodes().some(node => node.props['aria-label'] === '编辑文本 1 版本 1译文'))
    await ui.input('待翻译内容', 'Synthetic other input')
    ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush()
    assert.equal(ui.control('编辑文本 1 版本 1译文').props.value, 'Synthetic manual draft')
    await ui.input('待翻译内容', 'Synthetic next composer draft'); await ui.click('重译文本 1')
    assert.equal(ui.control('编辑文本 1 版本 1译文').props.value, 'Synthetic manual draft')
    assert.match(ui.text(), /基于版本 1保存为新版本/)
    await ui.click('保存文本 1 版本 1编辑')
    assert.match(ui.text(), /版本 3 · 人工修订 · 中文 · 基于版本 1/)
    assert.match(ui.text(), /待定稿/); assert.equal(rpc.calls.submit.length, 2)
    assert.equal(ui.control('待翻译内容').props.value, 'Synthetic next composer draft')
    await ui.click('文本 1 版本 3详情'); assert.match(ui.text(), /人工修订，未调用模型/)
    await ui.click('复制文本 1 版本 3'); assert.deepEqual(app.copies, ['Synthetic manual draft'])
    await ui.click('文本 1 版本 3设为最终'); assert.match(ui.text(), /用户固定：版本 3/)
    const session = app.store.getActiveSession('synthetic-main')
    const history = app.store.getTranslationHistory(session.id)
    assert.equal(history.units[0].source, 'Synthetic immutable source')
    assert.equal(history.units[0].revisions[2].baseRevisionId, history.units[0].revisions[0].id)
    assert.equal(history.units[0].revisions[2].model, null); assert.equal(history.units[0].revisions[2].callRecord, null)
    assert.equal(history.units[0].final.selection, 'user_fixed')
    await exportFromTitle(ui, '导出对照 JSON')
    const result = JSON.parse(await app.downloads[0].blob.text())
    assert.equal(result.format, 'dsh-translation-bilingual'); assert.equal(result.scope, 'session')
    assert.equal(result.sessions[0].units[0].source, 'Synthetic immutable source')
    assert.equal(result.sessions[0].units[0].translation, 'Synthetic manual draft')
    assert.ok(!('history' in result)); assert.ok(!('revisions' in result.sessions[0].units[0]))
    assert.equal(rpc.calls.submit.length, 2)
  } finally { await app.dispose() }
})

test('发布bundle调用详情：Host metadata照实显示prompt与用量，未知不填零，真实零保留', async () => {
  const rpc = remote()
  rpc.domain.submit = async request => {
    rpc.calls.submit.push(structuredClone(request)); const count = rpc.calls.submit.length
    return ok(rpc.job(request, { ...(count === 2 ? {} : { metadata: callMetadata(request, count === 3 ? 0 : 7, count === 3 ? 0 : 4) }) }))
  }
  const app = mount({ quick: rpc.port })
  try {
    const ui = await start(app); await ui.input('待翻译内容', 'Synthetic usage source'); await ui.click('发送快译')
    await ui.click('文本 1 版本 1详情')
    assert.match(ui.text(), /提示词版本：text-runtime-v1/); assert.match(ui.text(), /用量：输入 7 · 输出 4 token/)
    await ui.click('重译文本 1'); await ui.click('文本 1 版本 2详情')
    assert.match(ui.text(), /提示词版本：未提供/); assert.match(ui.text(), /用量：输入 未提供 · 输出 未提供 token/)
    await ui.click('重译文本 1'); await ui.click('文本 1 版本 3详情')
    assert.match(ui.text(), /用量：输入 0 · 输出 0 token/)
  } finally { await app.dispose() }
})

test('发布bundle导出：TXT和对照JSON只收尾最后单元，缺项一层选择且冻结确认范围', async () => {
  const rpc = remote()
  rpc.domain.submit = async request => {
    rpc.calls.submit.push(structuredClone(request)); const count = rpc.calls.submit.length
    return ok(rpc.job(request, { status: count === 2 ? 'failed' : 'completed', text: count === 2 ? 'Synthetic incomplete' : `Synthetic export result ${count}`, metadata: callMetadata(request), ...(count === 2 ? { error: { code: 'EXECUTION_FAILED', message: 'Synthetic truncation', stage: 'stream' } } : {}) }))
  }
  const app = mount({ quick: rpc.port })
  try {
    const ui = await start(app); await ui.input('待翻译内容', 'Synthetic old source'); await ui.click('发送快译'); await ui.click('重译文本 1')
    await ui.input('待翻译内容', 'Synthetic last source'); await ui.click('发送快译')
    await exportFromTitle(ui, '导出对照 JSON')
    assert.match(ui.text(), /尚无最终译文：文本 1/); assert.match(ui.text(), /自动最终：版本 1/)
    assert.equal(app.downloads.length, 0)
    const session = app.store.getActiveSession('synthetic-main'), history = app.store.getTranslationHistory(session.id)
    assert.equal(history.units[0].final, null); assert.equal(history.units[0].revisions[1].status, 'failed')
    assert.equal(history.units[1].revisions[0].callRecord.usage.inputTokens, 7)
    await ui.click('仅导出已定稿')
    const json = JSON.parse(await app.downloads[0].blob.text())
    assert.equal(json.summary.complete, false); assert.equal(json.sessions[0].units[0].translation, null)
    assert.equal(json.sessions[0].units[0].status, 'missing')
    assert.equal(json.sessions[0].units[1].translation, 'Synthetic export result 3')
    assert.equal(rpc.calls.submit.length, 3)
    await exportFromTitle(ui, '导出译文 TXT')
    assert.match(ui.text(), /尚无最终译文：文本 1/); assert.match(ui.text(), /自动最终：版本 1/)
    assert.equal(app.downloads.length, 1); assert.ok(!ui.nodes().some(node => node.props.role === 'menu'))
    await ui.click('重译文本 2'); await ui.click('文本 2 版本 2设为最终')
    await ui.click('仅导出已定稿')
    const text = await app.downloads[1].blob.text()
    assert.match(text, /Synthetic export result 3/); assert.ok(!text.includes('Synthetic export result 4'))
    assert.ok(!text.includes('Synthetic export result 1')); assert.match(app.downloads[1].fileName, /partial/)
    assert.equal(rpc.calls.submit.length, 4)
    await new Promise(resolve => setTimeout(resolve, 0)); await ui.flush()
    assert.equal(app.downloadAnchorCount, 0); assert.equal(app.revokedUrls.length, 2)
    assert.ok(!ui.nodes().some(node => node.props.role === 'dialog' || node.props.role === 'menu'))
  } finally { await app.dispose() }
})

test('发布bundle人工修正失败输出并导出，取消编辑保留原版本，TXT候选本地自动收尾', async () => {
  const rpc = remote()
  rpc.domain.submit = async request => { rpc.calls.submit.push(structuredClone(request)); return ok(rpc.job(request, { status: 'failed', text: 'Synthetic half translation', error: { code: 'EXECUTION_FAILED', message: 'Synthetic stream failure', stage: 'stream' } })) }
  const app = mount({ quick: rpc.port })
  try {
    const ui = await start(app); await ui.input('待翻译内容', 'Synthetic failed source'); await ui.click('发送快译')
    await ui.click('编辑文本 1 版本 1'); await ui.input('编辑文本 1 版本 1译文', 'Synthetic cancelled edit')
    await ui.click('取消文本 1 版本 1编辑'); assert.match(ui.text(), /Synthetic half translation/)
    assert.ok(!ui.text().includes('Synthetic cancelled edit'))
    await ui.click('编辑文本 1 版本 1'); await ui.input('编辑文本 1 版本 1译文', 'Synthetic human complete')
    await ui.click('保存文本 1 版本 1编辑'); assert.match(ui.text(), /待定稿/)
    const session = app.store.getActiveSession('synthetic-main')
    assert.equal(app.store.getTranslationHistory(session.id).units[0].final, null)
    await exportFromTitle(ui, '导出对照 JSON')
    const json = JSON.parse(await app.downloads[0].blob.text())
    assert.equal(json.sessions[0].units[0].source, 'Synthetic failed source')
    assert.equal(json.sessions[0].units[0].translation, 'Synthetic human complete')
    assert.match(ui.text(), /自动最终：版本 2/)
    await exportFromTitle(ui, '导出译文 TXT')
    assert.match(ui.text(), /自动最终：版本 2/)
    assert.equal((await app.downloads[1].blob.text()).trim(), 'Synthetic human complete')
    assert.equal(rpc.calls.submit.length, 1)
    await ui.click('文本 1旧版本'); assert.equal(ui.button('文本 1 版本 1设为最终').props.disabled, true)
  } finally { await app.dispose() }
})

test('发布bundle下载失败保留正文与编辑草稿，菜单收起后可重新导出', async () => {
  const options = { quick: remote().port, downloadError: true }, app = mount(options)
  try {
    const ui = await start(app); await ui.input('待翻译内容', 'Synthetic download source'); await ui.click('发送快译')
    await ui.click('编辑文本 1 版本 1'); await ui.input('编辑文本 1 版本 1译文', 'Synthetic preserved edit')
    await exportFromTitle(ui, '导出对照 JSON')
    assert.match(ui.text(), /无法启动下载，请重试/)
    assert.equal(ui.control('编辑文本 1 版本 1译文').props.value, 'Synthetic preserved edit')
    assert.equal(app.downloads.length, 0); assert.equal(app.downloadAnchorCount, 0)
    assert.ok(!ui.nodes().some(node => node.props.role === 'menu'))
    options.downloadError = false
    await exportFromTitle(ui, '导出对照 JSON')
    assert.equal(app.downloads.length, 1)
    assert.equal(JSON.parse(await app.downloads[0].blob.text()).sessions[0].units[0].source, 'Synthetic download source')
    assert.equal(ui.control('编辑文本 1 版本 1译文').props.value, 'Synthetic preserved edit')
  } finally { await app.dispose() }
})

test('发布bundle范围导出：绑定非当前空会话，整个主题含归档并稳定排序，固定最终不被新候选覆盖', async () => {
  const rpc = remote()
  rpc.domain.submit = async request => { rpc.calls.submit.push(structuredClone(request)); return ok(rpc.job(request, { text: `Synthetic scoped ${rpc.calls.submit.length}` })) }
  const app = mount({ quick: rpc.port })
  try {
    const ui = await start(app)
    await ui.input('待翻译内容', 'A source 1'); await ui.click('发送快译'); await ui.click('文本 1 版本 1设为最终')
    await ui.click('重译文本 1'); await ui.input('待翻译内容', 'A source 2'); await ui.click('发送快译')
    const first = app.store.getActiveSession('synthetic-main')
    ui.context(currentTitle(ui)); await ui.click('新建子会话')
    const archived = app.store.getActiveSession('synthetic-main')
    await ui.input('待翻译内容', 'B archived source'); await ui.click('发送快译')
    ui.context(currentTitle(ui)); await ui.click('归档')
    ui.context(currentTitle(ui)); await ui.click('新建子会话')
    const empty = app.store.getActiveSession('synthetic-main')
    currentTitle(ui).props.onClick(); ui.render(); await ui.click('新建主题及首会话')
    const otherTopic = app.store.getActiveSession('synthetic-main')
    assert.equal(otherTopic.topicName, first.topicName); assert.notEqual(otherTopic.topicId, first.topicId)
    await ui.input('待翻译内容', 'Other topic source'); await ui.click('发送快译')
    await exportFromSession(ui, first.id, '导出译文 TXT', '当前会话')
    assert.equal(await app.downloads[0].blob.text(), 'Synthetic scoped 1\n\nSynthetic scoped 3')
    assert.equal(app.store.getTranslationHistory(archived.id).units[0].final, null)
    assert.equal(app.store.getTranslationHistory(otherTopic.id).units[0].final, null)
    currentTitle(ui).props.onClick(); ui.render()
    const emptyRow = ui.nodes().find(node => node.props.className === 'dsh-tp-session-choice' && node.props.key === empty.id); assert.ok(emptyRow)
    ui.context(emptyRow); assert.equal(ui.button('导出译文 TXT').props.disabled, false)
    await ui.click('导出译文 TXT')
    assert.equal(currentTitle(ui).props['aria-expanded'], false)
    assert.equal(ui.button('当前会话').props.disabled, true); assert.equal(ui.button('整个主题').props.disabled, false)
    assert.equal(app.downloads.length, 1)
    await ui.click('整个主题')
    assert.equal(await app.downloads[1].blob.text(), 'Synthetic scoped 1\n\nSynthetic scoped 3\n\nSynthetic scoped 4')
    await exportFromSession(ui, empty.id, '导出对照 JSON', '整个主题')
    const json = JSON.parse(await app.downloads[2].blob.text())
    assert.equal(json.scope, 'topic'); assert.equal(json.topic.topicId, first.topicId)
    assert.deepEqual(json.sessions.map(session => session.id), [first.id, archived.id, empty.id])
    assert.deepEqual(json.sessions.map(session => session.sequence), [0, 1, 2])
    assert.equal(json.sessions[2].units.length, 0)
    assert.deepEqual(json.sessions[0].units.map(unit => [unit.source, unit.translation]), [['A source 1', 'Synthetic scoped 1'], ['A source 2', 'Synthetic scoped 3']])
    assert.equal(app.store.getTranslationHistory(first.id).units[0].final.selection, 'user_fixed')
    assert.equal(app.store.getTranslationHistory(archived.id).units[0].final.selection, 'automatic')
    assert.ok(app.store.getSession(archived.id).archivedAt)
    assert.equal(app.store.getActiveSession('synthetic-main').id, otherTopic.id)
    assert.equal(rpc.calls.submit.length, 5)
  } finally { await app.dispose() }
})

test('发布bundle主题缺项：确认冻结会话集合与最终正文，新增会话或固定新版本不改变待导出文件', async () => {
  const rpc = remote()
  rpc.domain.submit = async request => {
    rpc.calls.submit.push(structuredClone(request)); const count = rpc.calls.submit.length
    return ok(rpc.job(request, { status: count === 1 ? 'failed' : 'completed', text: `Synthetic frozen ${count}`,
      ...(count === 1 ? { error: { code: 'EXECUTION_FAILED', message: 'Synthetic failed first unit', stage: 'stream' } } : {}) }))
  }
  const app = mount({ quick: rpc.port })
  try {
    const ui = await start(app)
    await ui.input('待翻译内容', 'Missing source'); await ui.click('发送快译')
    await ui.input('待翻译内容', 'Final A source'); await ui.click('发送快译')
    const first = app.store.getActiveSession('synthetic-main')
    ui.context(currentTitle(ui)); await ui.click('新建子会话')
    await ui.input('待翻译内容', 'Final B source'); await ui.click('发送快译')
    const second = app.store.getActiveSession('synthetic-main')
    await exportFromTitle(ui, '导出对照 JSON', '整个主题')
    assert.match(ui.text(), new RegExp(`尚无最终译文：${first.name} · 文本 1`))
    assert.equal(app.downloads.length, 0)
    await ui.click('重译文本 1'); await ui.click('文本 1 版本 2设为最终')
    ui.context(currentTitle(ui)); await ui.click('新建子会话')
    await ui.input('待翻译内容', 'Late C source'); await ui.click('发送快译')
    const late = app.store.getActiveSession('synthetic-main')
    await ui.click('仅导出已定稿')
    const json = JSON.parse(await app.downloads[0].blob.text())
    assert.deepEqual(json.sessions.map(session => session.id), [first.id, second.id])
    assert.equal(json.sessions[0].units[0].status, 'missing'); assert.equal(json.sessions[0].units[0].source, 'Missing source')
    assert.equal(json.sessions[0].units[0].translation, null)
    assert.equal(json.sessions[1].units[0].translation, 'Synthetic frozen 3')
    assert.ok(!JSON.stringify(json).includes('Synthetic frozen 4')); assert.ok(!JSON.stringify(json).includes(late.id))
    assert.match(app.downloads[0].fileName, /partial/)
    await exportFromTitle(ui, '导出译文 TXT', '整个主题'); await ui.click('仅导出已定稿')
    assert.equal(await app.downloads[1].blob.text(), 'Synthetic frozen 2\n\nSynthetic frozen 4\n\nSynthetic frozen 5')
    assert.equal(rpc.calls.submit.length, 5)
    assert.equal(app.store.getTranslationHistory(second.id).units[0].final.selection, 'user_fixed')
    assert.ok(!ui.nodes().some(node => node.props.role === 'dialog' || node.props.role === 'menu'))
  } finally { await app.dispose() }
})

test('发布bundle二级导出菜单：返回、Escape和外部关闭后重开主菜单，全缺两格式不生成文件', async () => {
  const rpc = remote({ submit: async request => ok({ sessionKey: request.sessionKey, operationId: request.operationId, draftVersion: request.draftVersion, accepted: true, status: 'failed', text: 'Synthetic incomplete', error: { code: 'EXECUTION_FAILED', message: 'Synthetic failed', stage: 'stream' } }) })
  const app = mount({ quick: rpc.port })
  try {
    const ui = await start(app); await ui.input('待翻译内容', 'All missing source'); await ui.click('发送快译')
    const model = ui.nodes().find(node => node.props.className === 'dsh-tp-model-trigger' && node.props['aria-expanded'])
    if (model) await ui.click(model.props['aria-label'])
    ui.context(currentTitle(ui)); await ui.click('导出对照 JSON')
    assert.ok(ui.button('当前会话')); await ui.click('返回')
    assert.ok(ui.button('导出译文 TXT')); assert.ok(!ui.nodes().some(node => node.props['aria-label'] === '导出内容范围'))
    await ui.click('导出译文 TXT')
    ui.nodes().find(node => node.props['aria-label'] === '翻译会话右键操作').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); ui.render()
    assert.ok(!ui.nodes().some(node => node.props.role === 'menu'))
    ui.context(currentTitle(ui)); assert.ok(ui.button('导出对照 JSON')); await ui.click('导出对照 JSON')
    const nativeMenu = ui.nodes().find(node => node.props.role === 'menu' && ui.nodes(node).some(child => child.props['aria-label'] === '导出内容范围'))
    nativeMenu.props.onClose(); ui.render()
    ui.context(currentTitle(ui)); assert.ok(ui.button('导出译文 TXT'))
    await ui.click('导出译文 TXT'); await ui.click('整个主题')
    assert.equal(ui.button('仅导出已定稿').props.disabled, true); assert.equal(app.downloads.length, 0); await ui.click('取消')
    await exportFromTitle(ui, '导出对照 JSON')
    assert.equal(ui.button('仅导出已定稿').props.disabled, true); assert.equal(app.downloads.length, 0); await ui.click('取消')
  } finally { await app.dispose() }
})

test('发布bundle普通升档后仍可编辑导出既有记录，删除会话清除私有编辑草稿', async () => {
  const rpc = remote(); const app = mount({ quick: rpc.port, deferFunctionalUpdates: true })
  try {
    const ui = await start(app); await ui.input('待翻译内容', 'Synthetic upgrade source'); await ui.click('发送快译')
    await ui.input('翻译模式', 'normal')
    assert.equal(ui.button('发送待译材料').props.disabled, true)
    await ui.click('编辑文本 1 版本 1'); await ui.input('编辑文本 1 版本 1译文', 'Synthetic normal manual')
    await ui.click('保存文本 1 版本 1编辑'); assert.match(ui.text(), /版本 2 · 人工修订/)
    await exportFromTitle(ui, '导出译文 TXT')
    assert.equal((await app.downloads[0].blob.text()).trim(), 'Synthetic normal manual')
    assert.equal(rpc.calls.submit.length, 1)
    await ui.click('编辑文本 1 版本 2'); await ui.input('编辑文本 1 版本 2译文', 'Synthetic private edit to delete')
    assert.equal(ui.hasStateText('Synthetic private edit to delete'), true)
    ui.context(currentTitle(ui)); await ui.click('删除'); await ui.click('确认删除会话')
    assert.equal(ui.hasStateText('Synthetic private edit to delete'), false)
    assert.ok(!ui.text().includes('Synthetic normal manual'))
  } finally { await app.dispose() }
})
