import assert from 'node:assert/strict'
import test from 'node:test'
import { mount } from './quick-client-fixture.mjs'

// Real published Client bundle and stores; synthetic transport and light hook renderer.
class Topics {
  queue = []; replies = []; wake; closed = false; sequence = 0; owner
  port = { capabilities: async () => ({ ok: true, value: { ready: true } }), connect: identity => {
    this.owner = identity.ownerId; this.closed = false; this.queue.push({ kind: 'ready', ...identity })
    return { send: value => this.replies.push(structuredClone(value)), dispose: () => { this.closed = true; this.wake?.() },
      [Symbol.asyncIterator]: () => this.frames() }
  } }
  async *frames() { while (!this.closed) { if (this.queue.length) yield this.queue.shift(); else await new Promise(resolve => { this.wake = resolve }) } }
  async request(command, ui) {
    const count = this.replies.length, id = `synthetic-export-${++this.sequence}`
    this.queue.push({ kind: 'request', requestId: id, mainSessionId: this.owner, callId: id, command }); this.wake?.(); this.wake = undefined
    for (let i = 0; i < 50 && this.replies.length === count; i++) await ui.flush()
    assert.equal(this.replies.length, count + 1)
    return this.replies.at(-1)
  }
}
const owner = 'synthetic-export-owner'
function title(ui) { return ui.allNodes().find(node => node.type === 'button' && node.props.className === 'dsh-tp-current-title') }
function picker(ui) { ui.showTranslation(); title(ui).props.onClick(); ui.render() }
async function terms(ui) { picker(ui); await ui.click('主题术语') }
async function archive(ui, topicName) {
  picker(ui)
  const group = ui.nodes().find(node => node.props['aria-label'] === '主题档案'); assert.ok(group)
  const target = ui.nodes(group).find(node => node.type === 'button' && ui.text(node) === topicName); assert.ok(target)
  target.props.onClick(); ui.render(); await ui.flush()
  assert.equal(title(ui).props['aria-expanded'], false)
}
function put(session, id = 'synthetic-term', version = 0, edits = {}) {
  return { kind: 'upsert_term', translationSessionId: session.id, expectedVersion: version, entry: {
    id, expectedEntryVersion: null, sourceLanguage: 'English', targetLanguage: '中文', sourceForms: ['API'], aliases: [],
    sense: 'synthetic sense', preferred: '接口', forbidden: [], origin: 'inferred', status: 'proposal', evidence: [], ...edits,
  } }
}
async function setup(options = {}) {
  const topics = new Topics(), calls = [], receipt = value => ({ ok: true, value: { ok: true, value } })
  const quick = { capabilities: async () => receipt({ ready: true, mode: 'quick', storage: 'runtime_only' }),
    open: async request => receipt({ ...request, sessionKey: 'quick:synthetic-export' }),
    submit: async request => { calls.push(request); return receipt({ sessionKey: request.sessionKey, operationId: request.operationId, draftVersion: request.draftVersion, accepted: true, status: 'completed', text: 'Synthetic secret translation body' }) },
  }
  const app = mount({ topics: topics.port, quick, ...options }), ui = app.renderer
  ui.render(app.panel, { sessionId: owner }); await ui.flush(); await ui.flush()
  const request = command => topics.request(command, ui)
  const session = (await request({ kind: 'list_sessions' })).value.sessions[0]
  return { app, ui, topics, calls, request, session }
}
async function snapshot(f) { return (await f.request({ kind: 'list_terms', translationSessionId: f.session.id })).value.snapshot }
async function downloaded(f, index = -1) { return f.app.downloads.at(index).blob.text() }
const on = { schemaVersion: 2, defaultMode: 'quick', targetLanguage: '中文', defaultInstruction: '', maxInputChars: 20000, rememberHistory: true }

test('主题快照真实bundle：history off可下载两格式，按钮即时冻结，无写入/模型请求/整理', async () => {
  const f = await setup()
  try {
    assert.equal((await f.request(put(f.session))).ok, true)
    const before = await snapshot(f), stored = [...f.app.storage.values]
    await terms(f.ui)
    assert.match(f.ui.text(), /仅现有术语快照/)
    f.ui.button('导出 JSON').props.onClick(); f.ui.render()
    await f.request(put(f.session, 'synthetic-later', before.version, { sourceForms: ['Later'] }))
    const data = JSON.parse(await downloaded(f))
    assert.equal(data.snapshot.version, before.version); assert.equal(data.snapshot.entries.length, 1)
    assert.equal(data.ownerId, owner); assert.equal(data.topicId, f.session.topicId)
    assert.equal(data.storage.rememberHistory, false); assert.equal(data.automaticExtractionTriggered, false)
    assert.deepEqual([...f.app.storage.values], stored)
    await f.ui.click('导出 Markdown')
    assert.match(await downloaded(f), /Later → 接口/)
    assert.match(f.ui.text(), /已向浏览器发起下载/); assert.ok(!f.ui.text().includes('文件已保存'))
    assert.equal(f.calls.length, 0); assert.equal((await snapshot(f)).version, before.version + 1)
    assert.equal(f.app.downloadAnchorCount, 0); await f.ui.flush(); assert.equal(f.app.revokedUrls.length, 2)
  } finally { await f.app.dispose() }
})

test('主题快照真实bundle：标题档案按owner/主题去重，删最后会话保留可看可下载，重启仍可见', async () => {
  const f = await setup({ settings: on }); let restored
  try {
    await f.request(put(f.session))
    f.ui.context(title(f.ui)); await f.ui.click('新建同主题子会话')
    picker(f.ui)
    const group = f.ui.nodes().find(node => node.props['aria-label'] === '主题档案')
    assert.equal(f.ui.nodes(group).filter(node => node.type === 'button').length, 1)
    title(f.ui).props.onClick(); f.ui.render()
    f.ui.context(title(f.ui)); await f.ui.click('删除'); await f.ui.click('确认删除会话')
    f.ui.context(title(f.ui)); await f.ui.click('删除'); await f.ui.click('确认删除会话')
    assert.equal((await f.request({ kind: 'list_sessions' })).value.sessions.length, 0)
    assert.equal(title(f.ui).props['aria-label'], '选择翻译会话')
    await archive(f.ui, f.session.name); assert.match(f.ui.text(), /接口/)
    await f.ui.click('导出 JSON'); const exported = JSON.parse(await downloaded(f))
    assert.equal(exported.topicId, f.session.topicId); assert.equal(exported.snapshot.entries.length, 1)
    await f.app.dispose()
    restored = await setup({ storage: f.app.storage })
    await archive(restored.ui, f.session.name)
    await restored.ui.click('导出 Markdown'); assert.match(await downloaded(restored), /API → 接口/)
    assert.equal(restored.calls.length, 0)
  } finally { await restored?.app.dispose(); await f.app.dispose() }
})

test('主题快照真实bundle：别的owner不出现保留档案入口；普通send仍禁用，快译未新增步骤', async () => {
  const f = await setup()
  try {
    await f.request(put(f.session))
    f.ui.context(title(f.ui)); await f.ui.click('重命名主题'); await f.ui.input('主题名称', 'Synthetic private topic'); await f.ui.click('确认重命名主题')
    f.ui.render(f.app.panel, { sessionId: 'synthetic-other-owner' }); await f.ui.flush(); await f.ui.flush()
    picker(f.ui)
    const group = f.ui.nodes().find(node => node.props['aria-label'] === '主题档案')
    assert.ok(group); assert.ok(!f.ui.text(group).includes('Synthetic private topic'))
    title(f.ui).props.onClick(); f.ui.render()
    await f.ui.input('翻译模式', 'normal')
    assert.equal(f.ui.button('发送快译').props.disabled, true)
    assert.equal(f.calls.length, 0)
  } finally { await f.app.dispose() }
})

test('主题快照真实bundle：引用冻结可读性但不复制正文，删除来源后明确不可用', async () => {
  const f = await setup({ settings: on })
  try {
    await f.ui.click('模型：选择模型'); await f.ui.click('选择模型'); await f.ui.click('Model 1')
    await f.ui.input('待翻译内容', 'Synthetic secret source body'); await f.ui.click('发送快译')
    await f.ui.input('翻译模式', 'normal'); await f.ui.click('文本 1供主模型参考')
    const unitId = (await f.request({ kind: 'list_sessions' })).value.sessions[0].publishedUnitIds[0]
    const evidence = [{ kind: 'source', role: 'basis', sessionId: f.session.id, unitId, revisionId: null, selectionEventId: null, range: null }]
    assert.equal((await f.request(put(f.session, 'synthetic-source', 0, { origin: 'source_checked', status: 'active', evidence }))).ok, true)
    await terms(f.ui); await f.ui.click('导出 JSON')
    const text = await downloaded(f), data = JSON.parse(text)
    assert.equal(data.evidenceAvailability[0].readable, true); assert.equal(data.evidenceAvailability[0].unitOrder, 1)
    assert.ok(!text.includes('Synthetic secret source body')); assert.ok(!text.includes('Synthetic secret translation body'))
    await f.ui.click('关闭记忆资产'); f.ui.context(title(f.ui)); await f.ui.click('删除'); await f.ui.click('确认删除会话')
    await archive(f.ui, f.session.name); await f.ui.click('导出 Markdown')
    const markdown = await downloaded(f)
    assert.match(markdown, /待复核/); assert.match(markdown, /依据已变化或不可用/)
    assert.ok(markdown.replace(/\\-/g, '-').includes(unitId)); assert.ok(!markdown.includes('Synthetic secret source body'))
    assert.equal(f.calls.length, 1, 'export adds no model calls')
  } finally { await f.app.dispose() }
})

test('主题快照真实bundle：浏览器拒绝下载仅报告启动失败，档案不改变并清理anchor/URL', async () => {
  const f = await setup({ downloadError: true })
  try {
    await f.request(put(f.session)); const before = await snapshot(f)
    await terms(f.ui); await f.ui.click('导出 Markdown')
    assert.match(f.ui.text(), /无法启动下载，请重试/); assert.equal(f.app.downloads.length, 0)
    assert.deepEqual(await snapshot(f), before); assert.equal(f.calls.length, 0)
    assert.equal(f.app.downloadAnchorCount, 0); await f.ui.flush(); assert.equal(f.app.revokedUrls.length, 1)
  } finally { await f.app.dispose() }
})

test('主题快照真实bundle：关闭保存后导出当前人工采用版本，既有已保存副本保持不变', async () => {
  const f = await setup({ settings: on })
  try {
    await f.request(put(f.session))
    const key = [...f.app.storage.values.keys()].find(key => key.startsWith('dsh-translation-plugin:topic-terms:v1:'))
    const saved = f.app.storage.getItem(key)
    f.ui.render(f.app.settingsPage, {}); await f.ui.flush(); await f.ui.check('允许保存会话历史到本地', false)
    f.ui.render(f.app.panel, { sessionId: owner }); await f.ui.flush(); await terms(f.ui)
    await f.ui.click('采用'); await f.ui.click('导出 JSON')
    const data = JSON.parse(await downloaded(f))
    assert.equal(data.storage.rememberHistory, false); assert.equal(data.storage.status, 'memory')
    assert.equal(data.snapshot.entries[0].origin, 'user_explicit'); assert.ok(data.snapshot.entries[0].confirmation.eventId)
    assert.equal(JSON.parse(saved).entries[0].origin, 'inferred'); assert.equal(f.app.storage.getItem(key), saved)
    assert.equal(f.calls.length, 0)
  } finally { await f.app.dispose() }
})
