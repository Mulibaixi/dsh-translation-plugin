import assert from 'node:assert/strict'
import test from 'node:test'
import { mount } from './quick-client-fixture.mjs'

// Synthetic transport, real published Client bundle and its SessionStore/TopicMemoryStore.
class Topics {
  queue = []; replies = []; wake; closed = false; sequence = 0; owner
  port = { capabilities: async () => ({ ok: true, value: { ready: true } }), connect: identity => {
    this.owner = identity.ownerId; this.closed = false; this.queue.push({ kind: 'ready', ...identity })
    return { send: value => this.replies.push(structuredClone(value)), dispose: () => { this.closed = true; this.wake?.() },
      [Symbol.asyncIterator]: () => this.frames() }
  } }
  async *frames() { while (!this.closed) { if (this.queue.length) yield this.queue.shift(); else await new Promise(resolve => { this.wake = resolve }) } }
  async request(command, ui) {
    const count = this.replies.length, id = `synthetic-ui-${++this.sequence}`
    this.queue.push({ kind: 'request', requestId: id, mainSessionId: this.owner, callId: id, command }); this.wake?.(); this.wake = undefined
    for (let i = 0; i < 50 && this.replies.length === count; i++) await ui.flush()
    assert.equal(this.replies.length, count + 1)
    return this.replies.at(-1)
  }
}
function quickPort() {
  const calls = []
  const receipt = value => ({ ok: true, value: { ok: true, value } })
  return { calls, port: {
    capabilities: async () => receipt({ ready: true, mode: 'quick', storage: 'runtime_only' }),
    open: async request => receipt({ ...request, sessionKey: 'quick:synthetic-terms-ui' }),
    submit: async request => { calls.push(request); return receipt({ sessionKey: request.sessionKey, operationId: request.operationId, draftVersion: request.draftVersion, accepted: true, status: 'completed', text: '合成译文' }) },
  } }
}
const owner = 'synthetic-terms-ui-main'
function title(ui) { return ui.allNodes().find(node => node.props.className === 'dsh-tp-current-title' && node.type === 'button') }
async function terms(ui) {
  ui.showTranslation(); title(ui).props.onClick(); ui.render()
  const group = ui.nodes().find(node => node.props['aria-label'] === '记忆资产'); assert.ok(group)
  const current = ui.nodes(group).find(node => node.type === 'button' && ui.text(node) === '记忆资产'); assert.ok(current)
  current.props.onClick(); ui.render(); await ui.flush()
}
function details(ui) { return ui.nodes().find(node => node.props['aria-label'] === '术语详情') }
function row(ui, preferred) { const found = ui.nodes().find(node => node.type === 'article' && node.props.className === 'dsh-tp-term' && ui.text(node).includes(`→ ${preferred}`)); assert.ok(found); return found }
async function rowClick(ui, preferred, label) {
  const button = ui.nodes(row(ui, preferred)).find(node => node.type === 'button' && ui.text(node) === label)
    ?? ui.nodes(details(ui)).find(node => node.type === 'button' && ui.text(node) === label)
  assert.ok(button); assert.ok(!button.props.disabled); button.props.onClick(); ui.render(); await ui.flush()
}
async function setup(options = {}) {
  const topics = new Topics(), quick = quickPort(), app = mount({ topics: topics.port, quick: quick.port, ...options }), ui = app.renderer
  ui.render(app.panel, { sessionId: owner }); await ui.flush(); await ui.flush()
  const listed = await topics.request({ kind: 'list_sessions' }, ui)
  assert.equal(listed.ok, true)
  const session = listed.value.sessions[0]
  return { app, ui, topics, quick, session, request: command => topics.request(command, ui) }
}
function put(session, id, preferred, edits = {}, expectedVersion = 0) {
  return { kind: 'upsert_term', translationSessionId: session.id, expectedVersion, entry: {
    id, expectedEntryVersion: null, sourceLanguage: 'English', targetLanguage: '中文', sourceForms: ['API'], aliases: ['interface'],
    sense: '合成接口', preferred, forbidden: [], origin: 'inferred', status: 'proposal', evidence: [], ...edits,
  } }
}
async function snapshot(f, sessionId = f.session.id) { return (await f.request({ kind: 'list_terms', translationSessionId: sessionId })).value.snapshot }
async function translate(f) {
  await f.ui.click('模型：选择模型'); await f.ui.click('选择模型'); await f.ui.click('Model 1')
  await f.ui.input('待翻译内容', 'Synthetic API source'); await f.ui.click('发送快译')
  assert.equal(f.quick.calls.length, 1)
}

test('术语UI：标题菜单紧凑列表，采用/停用/重新采用真实事件；浏览不改档案更新时间', async () => {
  const f = await setup()
  try {
    await f.request(put(f.session, 'synthetic-term', '接口'))
    const before = await snapshot(f)
    await terms(f.ui); assert.equal(title(f.ui).props['aria-expanded'], false)
    assert.match(f.ui.text(), /待确认/); assert.match(f.ui.text(), /档案更新于/)
    await rowClick(f.ui, '接口', '详情')
    assert.match(f.ui.text(details(f.ui)), /English → 中文/)
    assert.equal((await snapshot(f)).updatedAt, before.updatedAt)
    await rowClick(f.ui, '接口', '采用')
    let current = await snapshot(f)
    assert.equal(current.entries[0].origin, 'user_explicit'); assert.ok(current.entries[0].confirmation.eventId)
    await rowClick(f.ui, '接口', '停用'); assert.equal((await snapshot(f)).entries[0].status, 'disabled')
    await rowClick(f.ui, '接口', '重新采用'); assert.equal((await snapshot(f)).entries[0].status, 'active')
    assert.equal(f.quick.calls.length, 0)
    assert.equal(f.ui.allNodes().find(node => node.props['aria-label'] === '发送快译').props.disabled, true, 'management does not prepare or translate a draft')
    assert.equal(f.app.mountCalls, 1); assert.equal(f.app.topicMountCalls, 1)
  } finally { await f.app.dispose() }
  assert.equal(f.app.unmountCalls, 1); assert.equal(f.app.topicUnmountCalls, 1)
  assert.equal(f.app.remote.translationQuick, undefined); assert.equal(f.app.remote.translationTopics, undefined)
})

test('术语UI：历史主动参考仅normal，来源展开真实材料；conflict采用给具体原因，停用冲突后可采用', async () => {
  const f = await setup()
  try {
    await translate(f)
    assert.ok(!f.ui.nodes().some(node => node.props['aria-label'] === '文本 1供主模型参考'))
    await f.ui.input('翻译模式', 'normal')
    const listed = await f.request({ kind: 'list_sessions' }); assert.deepEqual(listed.value.sessions[0].publishedUnitIds, [])
    assert.equal(f.ui.button('发送快译').props.disabled, true)
    await f.ui.click('文本 1供主模型参考')
    const selected = (await f.request({ kind: 'list_sessions' })).value.sessions[0].publishedUnitIds[0]
    const fact = (await f.request({ kind: 'read_unit', translationSessionId: f.session.id, unitId: selected })).value.unit
    const evidence = [{ kind: 'source', sessionId: f.session.id, unitId: selected, revisionId: null, selectionEventId: null, range: null, role: 'basis' }]
    await f.request(put(f.session, 'synthetic-one', '接口一', { origin: 'source_checked', status: 'active', evidence }))
    await f.request(put(f.session, 'synthetic-two', '接口二', { origin: 'source_checked', status: 'active', evidence }, 1))
    await terms(f.ui); assert.match(f.ui.text(row(f.ui, '接口二')), /有冲突/)
    await rowClick(f.ui, '接口二', '采用'); assert.match(f.ui.text(), /先停用或处理同范围的冲突条目/)
    await rowClick(f.ui, '接口一', '详情')
    await rowClick(f.ui, '接口一', '查看来源'); assert.match(f.ui.text(details(f.ui)), /Synthetic API source/)
    assert.equal(fact.source, 'Synthetic API source')
    await rowClick(f.ui, '接口一', '停用'); await rowClick(f.ui, '接口二', '采用')
    assert.equal((await snapshot(f)).entries.find(entry => entry.id === 'synthetic-two').origin, 'user_explicit')
    assert.equal(f.quick.calls.length, 1)
    f.ui.showTranslation(); await f.ui.click('取消文本 1参考')
    assert.equal((await f.request({ kind: 'read_unit', translationSessionId: f.session.id, unitId: selected })).ok, false)
  } finally { await f.app.dispose() }
})

test('术语UI：同主题子会话共用，删除当前和最后会话默认保留档案', async () => {
  const f = await setup({ settings: { schemaVersion: 2, defaultMode: 'quick', targetLanguage: '中文', defaultInstruction: '', maxInputChars: 20000, rememberHistory: true } })
  try {
    await f.request(put(f.session, 'synthetic-term', '接口'))
    f.ui.context(title(f.ui)); await f.ui.click('新建同主题子会话')
    const child = (await f.request({ kind: 'list_sessions' })).value.sessions.find(session => session.id !== f.session.id)
    assert.equal(child.topicId, f.session.topicId)
    await terms(f.ui); assert.match(f.ui.text(), /接口/); f.app.resourceHost.closeAssetCaption(); await f.ui.flush()
    f.ui.context(title(f.ui)); await f.ui.click('删除')
    assert.equal(f.ui.control('同时删除所选主题术语').props.checked, false)
    await f.ui.click('确认删除会话')
    assert.equal((await snapshot(f)).entries.length, 1)
    await terms(f.ui); f.app.resourceHost.closeAssetCaption(); await f.ui.flush()
    f.ui.context(title(f.ui)); await f.ui.click('删除'); await f.ui.click('确认删除会话')
    assert.equal((await f.request({ kind: 'list_sessions' })).value.sessions.length, 0)
    assert.ok([...f.app.storage.values.entries()].some(([key, value]) => key.startsWith('dsh-translation-plugin:topic-terms:v1:') && value.includes('接口')))
  } finally { await f.app.dispose() }
})

test('术语UI：显式共享删除checkbox捕获事件值，主题去重且未选中兄弟失去档案', async () => {
  const f = await setup({ deferFunctionalUpdates: true })
  try {
    await f.request(put(f.session, 'synthetic-term', '接口'))
    f.ui.context(title(f.ui)); await f.ui.click('新建同主题子会话')
    const child = (await f.request({ kind: 'list_sessions' })).value.sessions.find(session => session.id !== f.session.id)
    f.ui.context(title(f.ui)); await f.ui.click('删除')
    assert.match(f.ui.text(), /未选中的同主题会话也会失去这些术语/)
    await f.ui.check('同时删除所选主题术语', true)
    assert.equal(f.ui.control('同时删除所选主题术语').props.checked, true)
    assert.ok(f.ui.deferredUpdateCount > 0)
    await f.ui.click('确认删除会话')
    assert.equal((await snapshot(f)).entries.length, 0)
    const left = (await f.request({ kind: 'list_sessions' })).value.sessions
    assert.ok(left.some(session => session.id === f.session.id)); assert.ok(!left.some(session => session.id === child.id))
  } finally { await f.app.dispose() }
})

test('术语UI：确认范围冻结，等待时新提案到达不误删会话/档案；条目单层删除取消安全', async () => {
  const f = await setup()
  try {
    await f.request(put(f.session, 'synthetic-term', '接口'))
    f.ui.context(title(f.ui)); await f.ui.click('删除'); await f.ui.check('同时删除所选主题术语', true)
    await f.request(put(f.session, 'synthetic-late', '另一个接口', { sourceForms: ['OtherAPI'] }, 1))
    await f.ui.click('确认删除会话')
    assert.match(f.ui.text(), /会话及术语均未删除/)
    assert.equal((await snapshot(f)).entries.length, 2)
    await f.ui.click('取消'); await terms(f.ui)
    await rowClick(f.ui, '接口', '删除'); await f.ui.click('取消')
    assert.equal((await snapshot(f)).entries.length, 2)
    await rowClick(f.ui, '接口', '删除'); await f.ui.click('确认删除术语')
    assert.equal((await snapshot(f)).entries.length, 1)
    assert.equal(f.quick.calls.length, 0)
  } finally { await f.app.dispose() }
})

test('术语UI：保存on真实恢复术语，off保留旧副本并显示准确说明', async () => {
  const f = await setup({ settings: { schemaVersion: 2, defaultMode: 'quick', targetLanguage: '中文', defaultInstruction: '', maxInputChars: 20000, rememberHistory: true } })
  let restored
  try {
    await f.request(put(f.session, 'synthetic-term', '接口'))
    const key = [...f.app.storage.values.keys()].find(key => key.startsWith('dsh-translation-plugin:topic-terms:v1:'))
    const original = f.app.storage.getItem(key)
    f.ui.render(f.app.settingsPage, {}); await f.ui.flush(); await f.ui.check('允许保存会话历史到本地', false)
    f.ui.render(f.app.panel, { sessionId: owner }); await f.ui.flush(); await terms(f.ui)
    assert.match(f.ui.text(), /后续修改仅保留在本次运行/)
    await rowClick(f.ui, '接口', '采用')
    assert.equal(f.app.storage.getItem(key), original)
    await f.app.dispose()
    restored = await setup({ storage: f.app.storage })
    await terms(restored.ui); assert.match(restored.ui.text(), /待确认/)
    assert.equal((await snapshot(restored)).entries[0].origin, 'inferred')
  } finally { await restored?.app.dispose(); await f.app.dispose() }
})

test('资产UI：独立keyed Body首次浮出、重复复用，隐藏翻译的人工稿保持', async () => {
  const f = await setup()
  try {
    await translate(f)
    await f.ui.click('编辑文本 1 版本 1'); await f.ui.input('编辑文本 1 版本 1译文', '工作区未保存人工稿')
    await terms(f.ui)
    assert.equal(f.app.resourceHost.definitions.size, 2)
    assert.equal(f.app.resourceHost.registrations.size, 4)
    assert.equal(f.app.resourceHost.floats.length, 1)
    assert.equal(f.app.resourceHost.sidebarRight.openTabs.getSnapshot().length, 1)
    assert.match(f.ui.text(), /所属主会话：synthetic-terms-ui-main/)
    assert.equal(f.ui.button('其他记忆 · 暂未开放').props.disabled, true)
    assert.equal(f.ui.button('临时文件 · 暂未开放').props.disabled, true)
    f.ui.showTranslation()
    assert.equal(f.ui.control('编辑文本 1 版本 1译文').props.value, '工作区未保存人工稿')
    await terms(f.ui)
    assert.equal(f.app.resourceHost.floats.length, 1)
    f.app.resourceHost.closeAssetCaption(); await f.ui.flush()
    assert.equal(f.ui.control('编辑文本 1 版本 1译文').props.value, '工作区未保存人工稿')
    assert.equal(f.app.resourceHost.sidebarRight.openTabs.getSnapshot().length, 0)
    assert.equal(f.quick.calls.length, 1)
  } finally { await f.app.dispose() }
})

test('资产UI：搜索语义字段/状态仅筛列表，导出保持完整快照与时间', async () => {
  const f = await setup()
  try {
    await f.request(put(f.session, 'one', '接口', { aliases: ['interface'], forbidden: ['端口'], sense: '连接语境' }))
    await f.request(put(f.session, 'two', '数据', { sourceForms: ['Data'], aliases: [], sense: '资料' }, 1))
    const before = await snapshot(f)
    await terms(f.ui)
    for (const query of ['API', 'interface', '接口', '端口', '连接语境']) {
      await f.ui.input('搜索术语', query)
      assert.equal(f.ui.nodes().filter(node => node.type === 'article').length, 1)
    }
    await f.ui.input('术语状态', 'active'); assert.match(f.ui.text(), /没有匹配的术语/)
    await f.ui.click('导出 JSON')
    const exported = JSON.parse(await f.app.downloads.at(-1).blob.text())
    assert.equal(exported.snapshot.entries.length, 2)
    assert.equal(exported.snapshot.updatedAt, before.updatedAt)
    assert.deepEqual(await snapshot(f), before)
    assert.equal(f.quick.calls.length, 0)
  } finally { await f.app.dispose() }
})

test('资产UI：新增/编辑一次保存采用，dirty门禁，条目/category切换保留草稿且new ID不混淆', async () => {
  const f = await setup({ settings: { schemaVersion: 2, defaultMode: 'quick', targetLanguage: '日文', defaultInstruction: '', maxInputChars: 20000, rememberHistory: false } })
  try {
    await f.request(put(f.session, 'new', '接口'))
    await terms(f.ui); await f.ui.click('新增术语')
    assert.equal(f.ui.control('目标语言').props.value, '日文')
    assert.equal(f.ui.button('保存并采用').props.disabled, true)
    await f.ui.input('原文形式', 'Cache'); await f.ui.input('首选译法', '缓存新稿')
    await rowClick(f.ui, '接口', '详情'); await f.ui.click('编辑')
    assert.equal(f.ui.control('首选译法').props.value, '接口')
    await f.ui.input('首选译法', '接口编辑稿')
    await f.ui.click('译文记录'); await f.ui.click('结构化档案')
    assert.equal(f.ui.control('首选译法').props.value, '接口编辑稿')
    await f.ui.click('取消'); await f.ui.click('新增术语')
    assert.equal(f.ui.control('首选译法').props.value, '缓存新稿')
    await f.ui.click('保存并采用')
    let current = await snapshot(f)
    const created = current.entries.find(entry => entry.preferred === '缓存新稿')
    assert.equal(created.status, 'active'); assert.equal(created.origin, 'user_explicit'); assert.equal(created.version, 2)
    assert.ok(created.confirmation.eventId)
    await rowClick(f.ui, '接口', '详情'); await f.ui.click('编辑')
    assert.equal(f.ui.button('保存并采用').props.disabled, true)
    await f.ui.input('首选译法', '新接口'); await f.ui.click('保存并采用')
    current = await snapshot(f)
    assert.equal(current.entries.find(entry => entry.id === 'new').preferred, '新接口')
    assert.equal(current.entries.find(entry => entry.id === 'new').origin, 'user_explicit')
    assert.equal(f.quick.calls.length, 0)
  } finally { await f.app.dispose() }
})

test('资产UI：陈旧术语保存保留输入，显式核对后重试；删除清掉旧条目草稿', async () => {
  const f = await setup()
  try {
    await f.request(put(f.session, 'one', '接口'))
    await terms(f.ui); await rowClick(f.ui, '接口', '详情'); await f.ui.click('编辑'); await f.ui.input('首选译法', '编辑中的接口')
    await f.request(put(f.session, 'late', '数据', { sourceForms: ['Data'] }, 1))
    await f.ui.click('保存并采用')
    assert.match(f.ui.text(), /术语已变化，输入仍保留/)
    assert.equal(f.ui.control('首选译法').props.value, '编辑中的接口')
    await f.ui.click('继续基于最新版本编辑'); await f.ui.click('保存并采用')
    assert.equal((await snapshot(f)).entries.find(entry => entry.id === 'one').preferred, '编辑中的接口')
    await f.ui.click('编辑'); await f.ui.input('首选译法', '将被删除的稿')
    await rowClick(f.ui, '编辑中的接口', '删除'); await f.ui.click('确认删除术语')
    assert.ok(!f.ui.nodes().some(node => node.props['aria-label'] === '编辑术语'))
    assert.equal((await snapshot(f)).entries.length, 1)
  } finally { await f.app.dispose() }
})

test('资产UI：译文原文只读，人工候选及固定独立执行，草稿跨分类保留且归档只读', async () => {
  const f = await setup()
  try {
    await translate(f); await terms(f.ui); await f.ui.click('译文记录')
    await f.ui.click(`${f.session.name} · 文本 1`)
    assert.match(f.ui.text(), /Synthetic API source/)
    await f.ui.click('编辑译文'); assert.equal(f.ui.button('保存新版本').props.disabled, true)
    await f.ui.input('编辑译文', '资产窗口人工候选')
    await f.ui.click('结构化档案'); await f.ui.click('译文记录')
    assert.equal(f.ui.control('编辑译文').props.value, '资产窗口人工候选')
    await f.ui.click('保存新版本')
    assert.match(f.ui.text(), /尚无最终译文/); assert.match(f.ui.text(), /候选 · 版本 2/)
    assert.equal(f.quick.calls.length, 1)
    await f.ui.click('设为最终'); assert.match(f.ui.text(), /用户固定/)
    await f.ui.click('复制最终译文'); assert.equal(f.app.copies.at(-1), '资产窗口人工候选')
    f.ui.showTranslation(); f.ui.context(title(f.ui)); await f.ui.click('归档')
    // The asset tab remains mounted; focus its exact existing resource again.
    const resource = f.app.resourceHost.sidebarRight.openTabs.getSnapshot()[0]
    f.app.resourceHost.restoreResource(owner, resource.contentId); await f.ui.flush()
    assert.match(f.ui.text(), /会话已归档/)
    assert.equal(f.ui.button('编辑译文').props.disabled, true)
    assert.equal(f.quick.calls.length, 1)
  } finally { await f.app.dispose() }
})

test('资产UI：URI范围不随工作区选择变化，主题标题实时更新，外owner URI拒绝读取', async () => {
  const f = await setup()
  try {
    await f.request(put(f.session, 'scope', '原主题接口')); await terms(f.ui)
    const address = f.app.resourceHost.activeResource.contentId
    const renamed = await f.request({ kind: 'rename_topic', topicId: f.session.topicId, expectedName: f.session.topicName, name: '合成已重命名主题' })
    assert.equal(renamed.ok, true); assert.match(f.ui.text(), /合成已重命名主题 · 记忆资产/)
    f.ui.showTranslation(); title(f.ui).props.onClick(); f.ui.render(); await f.ui.click('新建主题及首会话')
    const sessions = (await f.request({ kind: 'list_sessions' })).value.sessions
    assert.equal(sessions.length, 2)
    f.app.resourceHost.restoreResource(owner, address); await f.ui.flush()
    assert.match(f.ui.text(), /原主题接口/); assert.match(f.ui.text(), /合成已重命名主题 · 记忆资产/)
    f.app.resourceHost.restoreResource('synthetic-other-owner', address); await f.ui.flush()
    assert.match(f.ui.text(), /不可用/); assert.ok(!f.ui.text().includes('原主题接口'))
    assert.equal(f.quick.calls.length, 0)
  } finally { await f.app.dispose() }
})

test('资产UI：记忆资产是可点击主入口并按需列出其他主题，右键具体会话同入口，Body没有关闭按钮', async () => {
  const f = await setup()
  try {
    await f.request(put(f.session, 'one', '接口'))
    f.ui.context(title(f.ui)); await f.ui.click('新建同主题子会话')
    title(f.ui).props.onClick(); f.ui.render()
    let groups = f.ui.nodes().filter(node => node.props.role === 'group' && node.props['aria-label'] === '记忆资产')
    assert.equal(groups.length, 1)
    assert.ok(!f.ui.nodes().some(node => node.props['aria-label'] === '主题档案'))
    assert.ok(!f.ui.nodes().some(node => node.type === 'button' && f.ui.text(node) === '主题术语'))
    const entries = f.ui.nodes(groups[0]).filter(node => node.type === 'button')
    assert.equal(entries.length, 1)
    assert.equal(f.ui.text(entries[0]), '记忆资产')
    assert.ok(!entries[0].props.disabled)
    entries[0].props.onClick(); f.ui.render(); await f.ui.flush()
    const body = f.ui.nodes().find(node => node.props.className === 'dsh-tp dsh-tp-assets')
    assert.ok(body)
    assert.equal(f.ui.nodes(body).filter(node => node.type === 'button' && (f.ui.text(node) === '×' || /关闭/.test(node.props['aria-label'] ?? ''))).length, 0)
    f.app.resourceHost.closeAssetCaption(); await f.ui.flush()
    assert.equal(f.app.resourceHost.sidebarRight.openTabs.getSnapshot().length, 0)
    f.ui.context(title(f.ui))
    assert.equal(f.ui.nodes().filter(node => node.type === 'button' && f.ui.text(node) === '记忆资产').length, 1)
    await f.ui.click('记忆资产'); assert.match(f.ui.text(), /接口/)
    f.app.resourceHost.closeAssetCaption(); await f.ui.flush()
    title(f.ui).props.onClick(); f.ui.render()
    const createTopic = f.ui.nodes().find(node => node.props['aria-label'] === '新建主题及首会话'); assert.ok(createTopic)
    createTopic.props.onClick(); f.ui.render(); await f.ui.flush()
    title(f.ui).props.onClick(); f.ui.render()
    groups = f.ui.nodes().filter(node => node.props.role === 'group' && node.props['aria-label'] === '记忆资产')
    assert.equal(groups.length, 1)
    const topicButtons = f.ui.nodes(groups[0]).filter(node => node.type === 'button')
    assert.equal(topicButtons.length, 2)
    assert.equal(f.ui.text(topicButtons[0]), '记忆资产')
    assert.equal(f.ui.text(topicButtons[1]), f.session.topicName)
    topicButtons[1].props.onClick(); f.ui.render(); await f.ui.flush()
    assert.match(f.ui.text(), new RegExp(`${f.session.topicName} · 记忆资产`))
    f.app.resourceHost.closeAssetCaption(); await f.ui.flush()
    // Archived sessions remain in the same unique theme asset group.
    f.ui.context(title(f.ui)); await f.ui.click('归档')
    title(f.ui).props.onClick(); f.ui.render()
    groups = f.ui.nodes().filter(node => node.props.role === 'group' && node.props['aria-label'] === '记忆资产')
    assert.equal(groups.length, 1); assert.equal(f.ui.nodes(groups[0]).filter(node => node.type === 'button').length, 2)
    assert.equal(f.quick.calls.length, 0)
  } finally { await f.app.dispose() }
})
