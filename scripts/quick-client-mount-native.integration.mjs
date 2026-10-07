import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createQuickHostFixture } from '../tests/quick-host-fixture.mjs'
import { mount } from '../tests/quick-client-fixture.mjs'
import { createTopicToolsNativeFixture } from '../tests/topic-tools-native-fixture.mjs'

// Real DSH ClientRemoteService + Cordis lifecycle + current plugin bundle.
// The Connection carrier only addresses the synthetic Host fixture; no real profile or network is used.
const runtimeRoot = process.env.DSH_RUNTIME_ROOT
if (!runtimeRoot) throw new Error('DSH_RUNTIME_ROOT is required; it must contain an external dsh/node_modules tree from DSH 0.2.0-rc.2')
const native = name => import(pathToFileURL(join(resolve(runtimeRoot, 'dsh/node_modules'), name)).href)
const [{ Context }, { TypertRegistry }, gateway] = await Promise.all([
  native('@deepseek-ai/cordis/lib/index.js'), native('@deepseek-ai/dsh-typert-registry/lib/index.js'),
  native('@deepseek-ai/dsh-api-gateway/lib/types/client/index.js'),
])
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function fixture({ mountGate, storage, settings, deferFunctionalUpdates } = {}) {
  const host = await createQuickHostFixture({ runtimeRoot })
  const { OperatorPeer } = await host.native('@deepseek-ai/dsh-client-connection')
  const topicPeer = new OperatorPeer(host.ctx)
  host.provider.catalog = ['model-a', 'model-b']
  const ctx = new Context()
  const calls = []
  ctx.provide('connection', {
    rpc: {
      async call(path, endpoint, payload, signal) {
        assert.equal(path, '/api'); assert.match(endpoint, /^(translationQuick|translationTopics)\//)
        calls.push({ endpoint, payload: structuredClone(payload) })
        if (endpoint.startsWith('translationTopics/')) return host.ctx.typertGateway.dispatchRpc(endpoint, payload, signal, topicPeer)
        return host.call(endpoint.split('/')[1], payload.args.request)
      },
      async *open() { throw new Error('Synthetic carrier does not open streams') },
    },
    registerGenerationSource() { return () => {} },
    start() { return { stop() {} } },
  })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(gateway)
  assert.equal(ctx.remote.translationQuick, undefined)
  if (mountGate) void ctx.remote.enqueue(() => mountGate.promise)
  let fiber
  const app = mount({ storage, settings, deferFunctionalUpdates, applyClient(plugin, mock) {
    ctx.provide('remote.session', { async modelCatalog() { return { ok: true, value: {
      default: null, failures: [], groups: [{ id: 'synthetic', name: 'Synthetic', models: [
        { id: 'model-a', name: 'Synthetic Model', reasoning: { defaultEffort: 'high', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
        { id: 'model-b', name: 'Synthetic Second Model', reasoning: { defaultEffort: 'high', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
      ] }],
    } } } })
    ctx.provide('slots', mock.slots)
    ctx.provide('sidebarRightTabs', mock.sidebarRightTabs)
    ctx.provide('sidebarRight', mock.sidebarRight)
    fiber = ctx.plugin({ name: plugin.name, inject: plugin.inject, apply(child) {
      plugin.apply(child)
      assert.equal(child.remote.translationQuick, undefined, 'actual $mount has not installed the namespace when apply returns')
    } })
    return fiber
  } })
  await app.applied
  let closed = false
  return { app, ctx, host, calls, fiber, async close() {
    if (closed) return
    closed = true
    await app.dispose(); await ctx.fiber.dispose(); await host.dispose()
  } }
}

test('实际ClientRemoteService.$mount + 发布bundle：异步namespace可就绪、发送，禁用后完整卸载', async () => {
  const state = await fixture(); const { app, ctx, calls, host } = state; const ui = app.renderer
  try {
    ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush()
    for (let i = 0; i < 100 && !calls.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 5)); await ui.flush()
    }
    assert.ok(ctx.remote.translationQuick)
    assert.ok(calls.length, `capabilities RPC was not called: ${ui.text()} / ${ui.button('发送快译').props.title}`)
    assert.ok(calls.some(call => call.endpoint === 'translationQuick/capabilities'))
    await ui.click('模型：选择模型'); await ui.click('选择模型'); await ui.click('Synthetic Model')
    await ui.input('待翻译内容', 'Synthetic source'); await ui.click('发送快译')
    for (let i = 0; i < 100 && !ui.text().includes('合成译文'); i++) {
      await new Promise(resolve => setTimeout(resolve, 5)); await ui.flush()
    }
    assert.match(ui.text(), /合成译文/)
    assert.equal(host.provider.calls.length, 1)
    assert.equal(calls.filter(call => call.endpoint === 'translationQuick/submit').length, 1)
    ui.dispose(); await state.fiber.dispose()
    assert.equal(ctx.remote.translationQuick, undefined)
    assert.deepEqual(ctx.typert.remotes.list(), [])
  } finally { await state.close() }
})

test('实际ClientRemoteService.$mount + Cordis：挂载队列等待时禁用，晚到namespace与贡献被清理', async () => {
  const gate = deferred(); const state = await fixture({ mountGate: gate }); const { app, ctx, calls } = state
  try {
    app.renderer.render(app.panel, { sessionId: 'synthetic-main' }); await app.renderer.flush()
    assert.equal(ctx.remote.translationQuick, undefined)
    const disposing = state.fiber.dispose()
    gate.resolve(); await disposing
    assert.equal(ctx.remote.translationQuick, undefined)
    assert.deepEqual(ctx.typert.remotes.list(), [])
    assert.equal(calls.length, 0)
  } finally { gate.resolve(); await state.close() }
})

async function waitUi(ui, predicate, label) {
  for (let i = 0; i < 200; i++) {
    await ui.flush()
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out: ${label}`)
}
const currentTitle = ui => ui.nodes().find(node => node.props.className === 'dsh-tp-current-title')
const version = (ui, unit, order) => ui.nodes().find(node => node.props['aria-label'] === `文本 ${unit} 版本 ${order}`)
async function exportFromTitle(ui, label, scope = '当前会话') {
  const model = ui.nodes().find(node => node.props.className === 'dsh-tp-model-trigger' && node.props['aria-expanded'])
  if (model) await ui.click(model.props['aria-label'])
  ui.context(currentTitle(ui)); await ui.click(label)
  assert.ok(ui.nodes().some(node => node.props['aria-label'] === '导出内容范围'))
  await ui.click(scope)
  assert.ok(!ui.nodes().some(node => node.props.role === 'menu'))
}

test('实际mount + Host/Gateway/LLM：版本展开固定/重译/草稿保护、菜单勾选、完整存储恢复与关闭保留旧副本', async () => {
  const state = await fixture({ settings: { schemaVersion: 2, defaultMode: 'quick', targetLanguage: '中文', defaultInstruction: 'Keep synthetic terms', maxInputChars: 20000, rememberHistory: true } })
  let restored
  let reopened
  try {
    const { app, host, calls } = state; const ui = app.renderer
    ui.render(app.panel, { sessionId: 'synthetic-main' })
    await waitUi(ui, () => !!state.ctx.remote.translationQuick && calls.length > 0, 'mounted')
    await ui.click('模型：选择模型'); await ui.click('选择模型'); await ui.click('Synthetic Model')
    await ui.input('待翻译内容', 'Synthetic frozen native source'); await ui.click('发送快译')
    await waitUi(ui, () => version(ui, 1, 1) && ui.text(version(ui, 1, 1)).includes(' · 译文 · '), 'first complete')
    assert.match(ui.text(), /待定稿/)
    await ui.input('待翻译内容', 'Synthetic native next draft'); await ui.input('目标语言', 'English')
    await ui.click('选择模型'); await ui.click('Synthetic Second Model'); await ui.click('选择推理等级'); await ui.click('Low')
    await ui.click('重译文本 1')
    await waitUi(ui, () => version(ui, 1, 2) && ui.text(version(ui, 1, 2)).includes(' · 译文 · '), 'second complete')
    assert.equal(ui.control('待翻译内容').props.value, 'Synthetic native next draft')
    assert.equal(ui.nodes().filter(node => node.props.className === 'dsh-tp-translation-text' && ui.text(node) === 'Synthetic frozen native source').length, 1)
    assert.ok(!version(ui, 1, 1))
    const submissions = calls.filter(call => call.endpoint === 'translationQuick/submit').map(call => call.payload.args.request)
    assert.equal(submissions.length, 2); assert.equal(submissions[1].unitId, submissions[0].unitId)
    assert.equal(submissions[1].sourceText, submissions[0].sourceText)
    assert.equal(submissions[1].targetLanguage, '中文'); assert.equal(submissions[1].instruction, 'Keep synthetic terms')
    assert.equal(host.provider.calls[1].model, 'model-b'); assert.equal(host.provider.calls[1].reasoningEffort, 'low')
    assert.deepEqual(host.provider.calls[1].messages.map(message => message.role), ['system', 'user'])
    assert.ok(!JSON.stringify(host.provider.calls[1].messages).includes('合成译文'))
    await ui.click('文本 1 版本 2详情'); assert.match(ui.text(), /synthetic\/model-b · 推理：low/)
    await ui.click('文本 1旧版本'); await ui.click('文本 1 版本 1设为最终'); await ui.click('复制文本 1 版本 1')
    assert.deepEqual(app.copies, ['合成译文']); assert.match(ui.text(), /用户固定：版本 1/)
    host.provider.mode = 'truncated'
    await ui.click('重译文本 1')
    await waitUi(ui, () => version(ui, 1, 3) && ui.text(version(ui, 1, 3)).includes('翻译失败'), 'third failed')
    assert.match(ui.text(), /用户固定：版本 1/); assert.equal(ui.button('文本 1 版本 3设为最终').props.disabled, true)
    assert.equal(ui.control('待翻译内容').props.value, 'Synthetic native next draft')
    host.provider.mode = 'success'
    await ui.click('发送快译')
    await waitUi(ui, () => version(ui, 2, 1) && ui.text(version(ui, 2, 1)).includes(' · 译文 · '), 'next unit complete')
    const parentName = ui.text(currentTitle(ui))
    ui.context(currentTitle(ui)); await ui.click('新建子会话')
    assert.ok(!ui.nodes().some(node => node.props.role === 'menu'))
    assert.ok(!version(ui, 1, 1)); await ui.input('待翻译内容', 'Synthetic child draft')
    await ui.click(currentTitle(ui).props['aria-label']); await ui.click(`切换翻译会话：${parentName}`)
    assert.equal(ui.control('待翻译内容').props.value, '')
    assert.match(ui.text(), /用户固定：版本 1/)
    assert.equal(ui.nodes().filter(node => node.props['aria-label'] === '选择翻译模式').length, 1)
    assert.equal(ui.nodes().filter(node => node.props['aria-label'] === '选择目标语言').length, 1)
    assert.equal(ui.button('发送快译').props.style.cornerShape, 'round')
    await ui.flush(); await state.close()

    restored = await fixture({ storage: app.storage, deferFunctionalUpdates: true })
    const saved = restored.app.renderer; saved.render(restored.app.panel, { sessionId: 'synthetic-main' })
    await waitUi(saved, () => !!restored.ctx.remote.translationQuick && restored.calls.length > 0, 'restored mounted')
    await saved.click(currentTitle(saved).props['aria-label']); await saved.click(`切换翻译会话：${parentName}`)
    assert.match(saved.text(), /用户固定：版本 1/); assert.ok(version(saved, 1, 3)); assert.ok(!version(saved, 1, 1))
    await saved.click('文本 1旧版本'); assert.ok(version(saved, 1, 1)); assert.ok(version(saved, 1, 2))
    saved.render(restored.app.settingsPage, {}); await saved.flush()
    await saved.check(`选择会话 ${parentName}`, true); assert.equal(saved.control(`选择会话 ${parentName}`).props.checked, true)
    await saved.click('删除所选历史（1）'); await saved.click('取消')
    assert.equal(saved.control(`选择会话 ${parentName}`).props.checked, true)
    await saved.check(`选择会话 ${parentName}`, false)
    await saved.check('允许保存会话历史到本地', false)
    saved.render(restored.app.panel, { sessionId: 'synthetic-main' }); await saved.flush()
    assert.match(saved.text(), /已保存的历史保留；后续内容仅保留在本次运行。/)
    await saved.click('模型：synthetic/model-b · low'); await saved.flush()
    await saved.click('重译文本 1')
    await waitUi(saved, () => version(saved, 1, 4) && saved.text(version(saved, 1, 4)).includes(' · 译文 · '), 'off revision complete')
    assert.equal(restored.host.provider.calls.length, 1)
    assert.match(saved.text(), /用户固定：版本 1/)
    await restored.close()
    reopened = await fixture({ storage: app.storage })
    const old = reopened.app.renderer; old.render(reopened.app.panel, { sessionId: 'synthetic-main' }); await old.flush()
    await old.click(currentTitle(old).props['aria-label']); await old.click(`切换翻译会话：${parentName}`)
    assert.ok(version(old, 1, 3)); assert.ok(!version(old, 1, 4))
    assert.match(old.text(), /用户固定：版本 1/)
    assert.equal(reopened.host.provider.calls.length, 0)
  } finally { await reopened?.close(); await restored?.close(); await state.close() }
})

test('实际mount + Host/Gateway/LLM：人工编辑与浏览器导出无额外模型请求，prompt/真实用量与缺失值可追溯', async () => {
  const state = await fixture({ settings: { schemaVersion: 2, defaultMode: 'quick', targetLanguage: '中文', defaultInstruction: 'Keep synthetic terms', maxInputChars: 20000, rememberHistory: true } })
  let restored
  try {
    const { app, host, calls } = state; const ui = app.renderer
    ui.render(app.panel, { sessionId: 'synthetic-main' })
    await waitUi(ui, () => !!state.ctx.remote.translationQuick && calls.length > 0, 'manual mounted')
    await ui.click('模型：选择模型'); await ui.click('选择模型'); await ui.click('Synthetic Model')
    await ui.input('待翻译内容', 'Synthetic manual native source'); await ui.click('发送快译')
    await waitUi(ui, () => version(ui, 1, 1) && ui.text(version(ui, 1, 1)).includes(' · 译文 · '), 'manual base complete')
    await ui.click('文本 1 版本 1详情')
    assert.match(ui.text(), /调用模型：synthetic\/model-a · 推理：high/)
    assert.match(ui.text(), /提示词版本：text-runtime-v1/); assert.match(ui.text(), /用量：输入 7 · 输出 4 token/)
    await ui.click('编辑文本 1 版本 1'); await ui.input('编辑文本 1 版本 1译文', '合成人工译文\nSynthetic second line')
    const parentName = ui.text(currentTitle(ui))
    ui.context(currentTitle(ui)); await ui.click('新建子会话')
    await ui.input('待翻译内容', 'Synthetic child isolation draft')
    await ui.click(currentTitle(ui).props['aria-label']); await ui.click(`切换翻译会话：${parentName}`)
    assert.equal(ui.control('编辑文本 1 版本 1译文').props.value, '合成人工译文\nSynthetic second line')
    await ui.input('待翻译内容', 'Synthetic later draft')
    host.provider.mode = 'no-usage'; await ui.click('重译文本 1')
    await waitUi(ui, () => version(ui, 1, 2) && ui.text(version(ui, 1, 2)).includes(' · 译文 · '), 'manual newer machine complete')
    await ui.click('文本 1 版本 2详情')
    assert.match(ui.text(version(ui, 1, 2)), /提示词版本：text-runtime-v1/)
    assert.match(ui.text(version(ui, 1, 2)), /用量：输入 未提供 · 输出 未提供 token/)
    assert.equal(ui.control('编辑文本 1 版本 1译文').props.value, '合成人工译文\nSynthetic second line')
    await ui.click('保存文本 1 版本 1编辑')
    assert.match(ui.text(), /版本 3 · 人工修订 · 中文 · 基于版本 1/)
    assert.match(ui.text(), /待定稿/); assert.equal(host.provider.calls.length, 2)
    assert.equal(ui.control('待翻译内容').props.value, 'Synthetic later draft')
    await ui.click('文本 1 版本 3详情'); assert.match(ui.text(version(ui, 1, 3)), /人工修订，未调用模型/)
    assert.match(ui.text(version(ui, 1, 3)), /保存：/)
    const session = app.store.getActiveSession('synthetic-main'), history = app.store.getTranslationHistory(session.id)
    const revisions = history.units[0].revisions
    assert.equal(history.units[0].source, 'Synthetic manual native source'); assert.equal(history.units[0].final, null)
    assert.equal(revisions[0].callRecord.promptVersion, 'text-runtime-v1')
    assert.deepEqual(revisions[0].callRecord.usage, { inputTokens: 7, outputTokens: 4 })
    assert.deepEqual(revisions[1].callRecord.usage, { inputTokens: null, outputTokens: null })
    assert.equal(revisions[2].baseRevisionId, revisions[0].id); assert.equal(revisions[2].callRecord, null); assert.equal(revisions[2].model, null)
    ui.context(currentTitle(ui))
    assert.ok(!ui.nodes().some(node => ui.text(node) === '导出完整记录 JSON'))
    await ui.click('导出对照 JSON'); await ui.click('当前会话')
    const json = JSON.parse(await app.downloads[0].blob.text())
    assert.equal(json.format, 'dsh-translation-bilingual'); assert.equal(json.scope, 'session')
    assert.equal(json.sessions.length, 1); assert.equal(json.sessions[0].id, session.id)
    assert.equal(json.sessions[0].units[0].source, 'Synthetic manual native source')
    assert.equal(json.sessions[0].units[0].translation, '合成人工译文\nSynthetic second line')
    assert.equal(json.sessions[0].units[0].status, 'final'); assert.equal(json.summary.complete, true)
    assert.ok(!('history' in json)); assert.ok(!('promptDefinitions' in json))
    assert.ok(!('revisions' in json.sessions[0].units[0])); assert.ok(!('callRecord' in json.sessions[0].units[0]))
    assert.ok(!JSON.stringify(json).includes('Synthetic later draft'))
    assert.equal(app.store.getTranslationHistory(session.id).units[0].final.revisionId, revisions[2].id)
    assert.equal(app.store.getTranslationHistory(session.id).units[0].final.selection, 'automatic')
    assert.equal(host.provider.calls.length, 2); assert.equal(calls.filter(call => call.endpoint === 'translationQuick/submit').length, 2)
    await exportFromTitle(ui, '导出译文 TXT')
    assert.equal(await app.downloads[1].blob.text(), '合成人工译文\nSynthetic second line')
    assert.match(ui.text(), /自动最终：版本 3/)
    assert.equal(host.provider.calls.length, 2)
    await ui.click('文本 1 版本 1设为最终')
    await ui.click('编辑文本 1 版本 3'); await ui.input('编辑文本 1 版本 3译文', 'Synthetic another human candidate')
    await ui.click('保存文本 1 版本 3编辑')
    assert.match(ui.text(), /用户固定：版本 1/); assert.equal(host.provider.calls.length, 2)
    host.provider.mode = 'truncated'; await ui.click('发送快译')
    await waitUi(ui, () => version(ui, 2, 1) && ui.text(version(ui, 2, 1)).includes('翻译失败'), 'export failed next unit')
    await exportFromTitle(ui, '导出译文 TXT')
    assert.match(ui.text(), /尚无最终译文：文本 2/)
    assert.equal(app.downloads.length, 2)
    await ui.click('仅导出已定稿')
    assert.equal(await app.downloads[2].blob.text(), '合成译文'); assert.match(app.downloads[2].fileName, /partial/)
    assert.equal(host.provider.calls.length, 3)
    const incomplete = app.store.getTranslationHistory(session.id)
    assert.equal(incomplete.units[0].final.revisionId, revisions[0].id); assert.equal(incomplete.units[0].final.selection, 'user_fixed')
    assert.equal(incomplete.units[1].final, null); assert.equal(incomplete.units[1].revisions[0].status, 'failed')
    await exportFromTitle(ui, '导出对照 JSON', '整个主题')
    assert.equal(app.downloads.length, 3); assert.match(ui.text(), /尚无最终译文：.*文本 2/)
    await ui.click('仅导出已定稿')
    const partial = JSON.parse(await app.downloads[3].blob.text())
    assert.equal(partial.scope, 'topic'); assert.equal(partial.sessions.length, 2)
    assert.equal(partial.sessions[0].id, session.id); assert.deepEqual(partial.sessions[1].units, [])
    assert.equal(partial.sessions[0].units[0].translation, '合成译文')
    assert.equal(partial.sessions[0].units[1].source, 'Synthetic later draft')
    assert.equal(partial.sessions[0].units[1].translation, null); assert.equal(partial.sessions[0].units[1].status, 'missing')
    assert.equal(partial.summary.complete, false); assert.equal(partial.summary.missingUnits[0].sessionId, session.id)
    assert.ok(!JSON.stringify(partial).includes('Synthetic child isolation draft')); assert.ok(!('history' in partial))
    assert.equal(host.provider.calls.length, 3)
    host.provider.mode = 'zero-usage'; await ui.input('待翻译内容', 'Synthetic zero native source'); await ui.click('发送快译')
    await waitUi(ui, () => version(ui, 3, 1) && ui.text(version(ui, 3, 1)).includes(' · 译文 · '), 'zero usage complete')
    await ui.click('文本 3 版本 1详情'); assert.match(ui.text(version(ui, 3, 1)), /用量：输入 0 · 输出 0 token/)
    await ui.flush(); assert.equal(app.downloadAnchorCount, 0); assert.equal(app.revokedUrls.length, 4)
    await state.close()
    restored = await fixture({ storage: app.storage })
    const saved = restored.app.renderer; saved.render(restored.app.panel, { sessionId: 'synthetic-main' }); await saved.flush()
    await saved.click(currentTitle(saved).props['aria-label']); await saved.click(`切换翻译会话：${parentName}`)
    assert.match(saved.text(), /版本 4 · 人工修订/); assert.match(saved.text(), /用户固定：版本 1/)
    await saved.click('文本 1旧版本'); await saved.click('文本 1 版本 1详情')
    assert.match(saved.text(version(saved, 1, 1)), /提示词版本：text-runtime-v1/)
    assert.match(saved.text(version(saved, 1, 1)), /用量：输入 7 · 输出 4 token/)
    assert.equal(restored.host.provider.calls.length, 0)
  } finally { await restored?.close(); await state.close() }
})
