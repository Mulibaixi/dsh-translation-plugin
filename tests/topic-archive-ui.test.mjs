import assert from 'node:assert/strict'
import test from 'node:test'
import { mount } from './quick-client-fixture.mjs'
import { deleteTopicArchiveEntry } from '../dist/memory/topic-archive.js'

// Published Client bundle with real Stores; transport, storage and React hooks are synthetic.
class Topics {
  queue = []; replies = []; wake; closed = false; sequence = 0; owner
  port = { capabilities: async () => ({ ok: true, value: { ready: true } }), connect: identity => {
    this.owner = identity.ownerId; this.closed = false; this.queue.push({ kind: 'ready', ...identity })
    return { send: reply => this.replies.push(structuredClone(reply)), dispose: () => { this.closed = true; this.wake?.() }, [Symbol.asyncIterator]: () => this.frames() }
  } }
  async *frames() { while (!this.closed) { if (this.queue.length) yield this.queue.shift(); else await new Promise(resolve => { this.wake = resolve }) } }
  async request(command, ui) {
    const count = this.replies.length, requestId = `archive-ui-${++this.sequence}`
    this.queue.push({ kind: 'request', requestId, mainSessionId: this.owner, callId: requestId, command }); this.wake?.(); this.wake = undefined
    for (let i = 0; i < 50 && count === this.replies.length; i++) await ui.flush()
    assert.equal(this.replies.length, count + 1); return this.replies.at(-1)
  }
}
const owner = 'synthetic-archive-ui-owner'
const on = { schemaVersion: 2, defaultMode: 'quick', targetLanguage: '中文', defaultInstruction: '', maxInputChars: 20000, rememberHistory: true }
function title(ui) { return ui.allNodes().find(node => node.type === 'button' && node.props.className === 'dsh-tp-current-title') }
async function assets(ui) {
  ui.showTranslation(); title(ui).props.onClick(); ui.render()
  const entry = ui.nodes().find(node => node.type === 'button' && (node.props['aria-label'] ?? '').startsWith('打开记忆资产：'))
  assert.ok(entry); entry.props.onClick(); ui.render(); await ui.flush()
}
async function setup(options = {}) {
  const topics = new Topics(), calls = [], receipt = value => ({ ok: true, value: { ok: true, value } })
  const quick = { capabilities: async () => receipt({ ready: true, mode: 'quick', storage: 'runtime_only' }), open: async request => receipt({ ...request, sessionKey: 'archive-ui-quick' }),
    submit: async request => { calls.push(request); return receipt({ sessionKey: request.sessionKey, operationId: request.operationId, draftVersion: request.draftVersion, accepted: true, status: 'completed', text: 'Synthetic excluded translation body' }) } }
  const app = mount({ topics: topics.port, quick, ...options }), ui = app.renderer
  ui.render(app.panel, { sessionId: owner }); await ui.flush(); await ui.flush()
  const request = command => topics.request(command, ui), session = (await request({ kind: 'list_sessions' })).value.sessions[0]
  return { app, ui, topics, calls, request, session }
}
async function snapshot(f, topicId = f.session.topicId) { const reply = await f.request({ kind: 'list_topic_archive', topicId }); assert.equal(reply.ok, true); return reply.value.snapshot }
function row(f, id) { const node = f.ui.nodes().find(node => node.type === 'article' && node.props['data-archive-id'] === id); assert.ok(node); return node }
async function rowClick(f, id, label) {
  const node = f.ui.nodes(row(f, id)).find(node => node.type === 'button' && f.ui.text(node) === label); assert.ok(node); assert.ok(!node.props.disabled)
  node.props.onClick(); f.ui.render(); await f.ui.flush()
}
async function entity(f, name) { await f.ui.input('档案类型', 'entity'); await f.ui.click('新增实体'); await f.ui.input('实体名称', name); await f.ui.input('实体别名', `${name}-alias`); await f.ui.click('保存并采用'); return (await snapshot(f)).entries.find(entry => entry.kind === 'entity' && entry.name === name) }
function put(topicId, expectedVersion, id, semantic, edits = {}) { return { kind: 'upsert_archive', topicId, expectedVersion, entry: { ...semantic, id, expectedEntryVersion: null, origin: 'inferred', status: 'proposal', evidence: [], ...edits } } }
async function selectTopic(f, id) {
  await f.ui.click('选择资产主题'); const choice = f.ui.nodes().find(node => node.type === 'button' && node.props['data-topic-id'] === id); assert.ok(choice)
  choice.props.onClick(); f.ui.render(); await f.ui.flush()
}

test('档案UI：直接保存实体/事实/关系，实体选择显示名称，同条目编辑保留ID与来源权限', async () => {
  const f = await setup({ deferFunctionalUpdates: true })
  try {
    await assets(f.ui); const a = await entity(f, '林'); const b = await entity(f, '组织')
    const note = f.ui.nodes().find(node => node.props.className === 'dsh-tp-muted dsh-tp-asset-note' && f.ui.text(node).includes('关联实体须为生效条目'))
    assert.ok(note)
    assert.equal(note.props.title, f.ui.text(note), 'asset guidance is one compact line with the full detail available on hover')
    assert.match(f.ui.text(note), /同主题共用；快译不使用。关联实体须为生效条目。.*保存状态：/u)
    assert.equal(a.origin, 'user_explicit'); assert.equal(a.status, 'active'); assert.ok(a.confirmation.eventId)
    await f.ui.input('档案类型', 'fact'); await f.ui.click('新增事实'); await f.ui.input('事实标题', '到访'); await f.ui.input('事实内容', '林到访组织。')
    await f.ui.check('关联实体：林', true); await f.ui.check('关联实体：组织', true); await f.ui.click('保存并采用')
    const fact = (await snapshot(f)).entries.find(entry => entry.kind === 'fact'); assert.deepEqual(fact.entityIds, [a.id, b.id])
    assert.match(f.ui.text(f.ui.nodes().find(node => node.props['aria-label'] === '档案详情')), /关联实体：林、组织/)
    await f.ui.input('档案类型', 'relation'); await f.ui.click('新增关系')
    assert.equal(f.ui.text(f.ui.nodes(f.ui.control('源实体')).find(node => node.props.value === a.id)), '林')
    await f.ui.input('源实体', a.id); await f.ui.input('关系', '属于'); await f.ui.input('目标实体', b.id); await f.ui.click('保存并采用')
    const relation = (await snapshot(f)).entries.find(entry => entry.kind === 'relation'); assert.match(f.ui.text(row(f, relation.id)), /林 · 属于 · 组织/)
    await f.ui.click('编辑'); await f.ui.input('关系', '加入'); await f.ui.click('保存并采用')
    const edited = (await snapshot(f)).entries.find(entry => entry.id === relation.id)
    assert.equal(edited.relation, '加入'); assert.equal(edited.createdAt, relation.createdAt); assert.ok(edited.version > relation.version)
    assert.equal((await snapshot(f)).entries.length, 4); assert.equal(f.calls.length, 0)
    assert.ok(![...f.app.storage.values.keys()].some(key => key.startsWith('dsh-translation-plugin:topic-archive:v1:')))
    const quick = await f.request({ kind: 'query_archive', translationSessionId: f.session.id, kinds: ['entity', 'fact', 'relation'], forms: ['林'] })
    assert.deepEqual(quick.value.snapshot.entries, [])
  } finally { await f.app.dispose() }
})

test('档案UI：模型提案采用/停用/恢复，删除实体标记依赖待复核，缺失关联可编辑修复', async () => {
  const f = await setup()
  try {
    await f.request(put(f.session.topicId, 0, 'proposal', { kind: 'entity', name: '待确认实体', aliases: [], description: '' }))
    await assets(f.ui); await f.ui.input('档案类型', 'entity'); await rowClick(f, 'proposal', '采用')
    assert.equal((await snapshot(f)).entries[0].origin, 'user_explicit')
    await rowClick(f, 'proposal', '停用'); await rowClick(f, 'proposal', '重新采用')
    const replacement = await entity(f, '替代实体'), target = await entity(f, '目标实体')
    await f.ui.input('档案类型', 'fact'); await f.ui.click('新增事实'); await f.ui.input('事实标题', '关联事实'); await f.ui.input('事实内容', '关联实体。')
    await f.ui.check('关联实体：待确认实体', true); await f.ui.click('保存并采用'); const fact = (await snapshot(f)).entries.find(entry => entry.kind === 'fact')
    await f.ui.input('档案类型', 'relation'); await f.ui.click('新增关系'); await f.ui.input('源实体', 'proposal'); await f.ui.input('关系', '关联'); await f.ui.input('目标实体', target.id); await f.ui.click('保存并采用')
    const relation = (await snapshot(f)).entries.find(entry => entry.kind === 'relation')
    await f.ui.input('档案类型', 'entity'); await rowClick(f, 'proposal', '删除'); await f.ui.click('确认删除档案')
    const deleted = await snapshot(f); assert.equal(deleted.entries.find(entry => entry.id === fact.id).status, 'review_required'); assert.equal(deleted.entries.find(entry => entry.id === relation.id).status, 'review_required')
    await f.ui.input('档案类型', 'fact'); await rowClick(f, fact.id, '详情'); assert.match(f.ui.text(), /实体不可用/); await f.ui.click('编辑')
    await f.ui.check('关联实体：实体不可用（ID：proposal）', false); await f.ui.check('关联实体：替代实体', true); await f.ui.click('保存并采用')
    assert.deepEqual((await snapshot(f)).entries.find(entry => entry.id === fact.id).entityIds, [replacement.id])
    await f.ui.input('档案类型', 'relation'); await rowClick(f, relation.id, '详情'); await f.ui.click('编辑')
    assert.equal(f.ui.control('源实体').props.value, 'proposal'); await f.ui.input('源实体', replacement.id); await f.ui.click('保存并采用')
    assert.equal((await snapshot(f)).entries.find(entry => entry.id === relation.id).status, 'active'); assert.equal(f.calls.length, 0)
  } finally { await f.app.dispose() }
})

test('档案UI：切换条目/类型/分类/主题保留独立草稿，关闭窗口释放草稿', async () => {
  const f = await setup()
  try {
    await assets(f.ui); const a = await entity(f, '甲'), b = await entity(f, '乙')
    await rowClick(f, a.id, '详情'); await f.ui.click('编辑'); await f.ui.input('描述', '甲的未保存描述')
    await rowClick(f, b.id, '详情'); await f.ui.click('编辑'); await f.ui.input('描述', '乙的未保存描述')
    await rowClick(f, a.id, '详情'); assert.equal(f.ui.control('描述').props.value, '甲的未保存描述')
    await f.ui.input('档案类型', 'fact'); await f.ui.click('新增事实'); await f.ui.input('事实标题', '未保存事实')
    await f.ui.input('档案类型', 'terms'); await f.ui.click('新增术语'); await f.ui.input('原文形式', 'draft term')
    await f.ui.input('档案类型', 'entity'); assert.equal(f.ui.control('描述').props.value, '甲的未保存描述')
    await f.ui.click('译文记录'); await f.ui.click('结构化档案'); assert.equal(f.ui.control('描述').props.value, '甲的未保存描述')
    const created = await f.request({ kind: 'create_session', start: { kind: 'new_topic' }, reason: 'Synthetic separate draft scope' })
    assert.equal(created.ok, true); const otherTopic = created.value.session.topicId
    await selectTopic(f, otherTopic); await f.ui.input('档案类型', 'entity'); await f.ui.click('新增实体'); await f.ui.input('实体名称', '另一主题草稿')
    await selectTopic(f, f.session.topicId); assert.equal(f.ui.control('描述').props.value, '甲的未保存描述')
    await f.ui.input('档案类型', 'fact'); assert.equal(f.ui.control('事实标题').props.value, '未保存事实')
    await f.ui.input('档案类型', 'terms'); assert.equal(f.ui.control('原文形式').props.value, 'draft term')
    f.app.resourceHost.closeAssetCaption(); await f.ui.flush(); await assets(f.ui); await f.ui.input('档案类型', 'entity')
    await rowClick(f, a.id, '详情'); await f.ui.click('编辑'); assert.equal(f.ui.control('描述').props.value, '')
    assert.equal((await snapshot(f)).entries.find(entry => entry.id === a.id).description, '')
  } finally { await f.app.dispose() }
})

test('档案UI：保存失败保留新增稿与已生成ID，恢复配额重试同条目且不造新版本', async () => {
  const f = await setup({ settings: on })
  try {
    await assets(f.ui); await f.ui.input('档案类型', 'entity'); await f.ui.click('新增实体'); await f.ui.input('实体名称', '配额实体'); await f.ui.input('描述', '保留输入')
    const originalSet = f.app.storage.setItem.bind(f.app.storage)
    f.app.storage.setItem = (key, value) => { if (key.startsWith('dsh-translation-plugin:topic-archive:v1:')) throw new Error('synthetic quota'); originalSet(key, value) }
    await f.ui.click('保存并采用'); assert.match(f.ui.text(), /尚未保存到本地/); assert.match(f.ui.text(), /保存状态：保存失败/)
    assert.equal(f.ui.control('实体名称').props.value, '配额实体'); assert.equal(f.ui.control('描述').props.value, '保留输入')
    const failed = await snapshot(f); assert.equal(failed.entries.length, 1)
    f.app.storage.setItem = originalSet; await f.ui.click('保存并采用')
    const saved = await snapshot(f); assert.equal(saved.entries.length, 1); assert.equal(saved.entries[0].id, failed.entries[0].id)
    assert.equal(saved.version, failed.version); assert.equal(saved.entries[0].version, failed.entries[0].version)
    assert.match(f.ui.text(), /保存状态：已保存/); assert.ok(!f.ui.nodes().some(node => node.props['aria-label'] === '编辑实体'))
    assert.equal(JSON.parse(f.app.storage.getItem(`dsh-translation-plugin:topic-archive:v1:${encodeURIComponent(f.session.topicId)}`)).entries.length, 1)
  } finally { await f.app.dispose() }
})

test('档案UI：等待保存时到达的新输入不被失败或成功回执覆盖', async () => {
  const f = await setup({ settings: on })
  try {
    await assets(f.ui); await f.ui.input('档案类型', 'entity'); await f.ui.click('新增实体'); await f.ui.input('实体名称', '等待实体')
    const originalSet = f.app.storage.setItem.bind(f.app.storage), lateInput = f.ui.control('描述').props.onChange
    f.app.storage.setItem = (key, value) => { if (key.startsWith('dsh-translation-plugin:topic-archive:v1:')) throw new Error('synthetic quota'); originalSet(key, value) }
    f.ui.button('保存并采用').props.onClick(); lateInput({ currentTarget: { value: '失败回执前的新输入' } }); f.ui.render(); await f.ui.flush()
    assert.equal(f.ui.control('描述').props.value, '失败回执前的新输入')
    const first = await snapshot(f); assert.equal(first.entries.length, 1)
    f.app.storage.setItem = originalSet; const newer = f.ui.control('描述').props.onChange
    f.ui.button('保存并采用').props.onClick(); newer({ currentTarget: { value: '成功回执前的新输入' } }); f.ui.render(); await f.ui.flush()
    assert.equal(f.ui.control('描述').props.value, '成功回执前的新输入')
    assert.equal((await snapshot(f)).entries[0].description, '失败回执前的新输入')
    await f.ui.click('保存并采用'); assert.equal((await snapshot(f)).entries[0].description, '成功回执前的新输入')
    assert.equal((await snapshot(f)).entries[0].id, first.entries[0].id)
  } finally { await f.app.dispose() }
})

test('档案UI：公共导出冻结整个主题所有类型，筛选不缩小内容且来源正文不复制', async () => {
  const f = await setup()
  try {
    await f.ui.click('模型：选择模型'); await f.ui.click('选择模型'); await f.ui.click('Model 1'); await f.ui.input('待翻译内容', 'Synthetic excluded source body'); await f.ui.click('发送快译')
    await f.ui.input('翻译模式', 'normal'); await f.ui.click('文本 1供主模型参考')
    const unitId = (await f.request({ kind: 'list_sessions' })).value.sessions[0].publishedUnitIds[0]
    const evidence = [{ kind: 'source', role: 'basis', sessionId: f.session.id, unitId, revisionId: null, selectionEventId: null, range: null }]
    await f.request(put(f.session.topicId, 0, 'source-entity', { kind: 'entity', name: '依据实体', aliases: [], description: '' }, { origin: 'source_checked', status: 'active', evidence }))
    await f.request({ kind: 'upsert_term', translationSessionId: f.session.id, expectedVersion: 0, entry: { id: 'term', expectedEntryVersion: null, sourceLanguage: 'English', targetLanguage: '中文', sourceForms: ['Synthetic'], aliases: [], sense: '', preferred: '合成', forbidden: [], origin: 'inferred', status: 'proposal', evidence: [] } })
    await assets(f.ui); const other = await entity(f, '其他实体')
    await f.ui.input('档案类型', 'fact'); await f.ui.click('新增事实'); await f.ui.input('事实标题', '主题事实'); await f.ui.input('事实内容', '事实正文'); await f.ui.click('保存并采用')
    await f.ui.input('档案类型', 'relation'); await f.ui.click('新增关系'); await f.ui.input('源实体', 'source-entity'); await f.ui.input('关系', '关联'); await f.ui.input('目标实体', other.id); await f.ui.click('保存并采用')
    await f.ui.input('搜索档案', 'no match'); await f.ui.input('档案状态', 'disabled')
    assert.equal(f.ui.nodes().filter(node => node.type === 'button' && f.ui.text(node) === '导出 JSON').length, 1)
    const before = await snapshot(f), stored = [...f.app.storage.values]
    f.ui.button('导出 JSON').props.onClick(); f.ui.render()
    await f.request(put(f.session.topicId, before.version, 'later', { kind: 'fact', title: '随后事实', body: '随后新增', entityIds: [] }))
    const text = await f.app.downloads.at(-1).blob.text(), data = JSON.parse(text)
    assert.equal(data.format, 'dsh-translation-topic-archive'); assert.equal(data.terms.entries.length, 1); assert.equal(data.archive.entries.length, 4)
    assert.equal(data.archive.version, before.version); assert.equal(data.evidenceAvailability.archive[0].readable, true); assert.equal(data.evidenceAvailability.archive[0].unitOrder, 1)
    assert.ok(!text.includes('Synthetic excluded source body')); assert.ok(!text.includes('Synthetic excluded translation body'))
    assert.deepEqual([...f.app.storage.values], stored); assert.equal(f.calls.length, 1)
    await f.ui.click('导出 Markdown'); assert.match(await f.app.downloads.at(-1).blob.text(), /主题事实/); assert.match(await f.app.downloads.at(-1).blob.text(), /随后事实/)
  } finally { await f.app.dispose() }
})

test('档案UI：外部删除正在编辑的条目保留稿供复制，禁用保存与rebase且不复活条目', async () => {
  const f = await setup({ settings: on })
  try {
    await assets(f.ui); const a = await entity(f, '被外删实体'); await entity(f, '保留实体')
    await rowClick(f, a.id, '详情'); await f.ui.click('编辑'); await f.ui.input('描述', '外部删除前的未保存稿')
    const key = `dsh-translation-plugin:topic-archive:v1:${encodeURIComponent(f.session.topicId)}`, saved = JSON.parse(f.app.storage.getItem(key))
    const remote = deleteTopicArchiveEntry(saved, a.id, a.version, new Date().toISOString()).snapshot
    f.app.changeStorage(key, JSON.stringify(remote)); await f.ui.flush()
    assert.equal(f.ui.control('描述').props.value, '外部删除前的未保存稿'); assert.match(f.ui.text(), /条目已删除，编辑稿保留供复制/)
    assert.equal(f.ui.button('保存并采用').props.disabled, true); assert.equal(f.ui.button('继续基于最新版本编辑').props.disabled, true)
    f.ui.button('保存并采用').props.onClick(); f.ui.render(); await f.ui.flush()
    assert.equal((await snapshot(f)).entries.some(entry => entry.id === a.id), false)
    await f.ui.click('复制编辑稿'); assert.match(f.app.copies.at(-1), /外部删除前的未保存稿/); assert.match(f.ui.text(), /已复制编辑稿/)
    await f.ui.click('取消'); assert.ok(!f.ui.text().includes('条目已删除，编辑稿保留供复制'))
    assert.equal((await snapshot(f)).entries.length, 1)
  } finally { await f.app.dispose() }
})

test('档案UI：外删缓存改动稿可再次查看；本窗口确认删除才清除对应稿', async () => {
  const f = await setup({ settings: on })
  try {
    await assets(f.ui); const a = await entity(f, '缓存实体'), b = await entity(f, '本窗删除实体')
    await rowClick(f, a.id, '详情'); await f.ui.click('编辑'); await f.ui.input('描述', '缓存中的未保存稿')
    await rowClick(f, b.id, '详情'); await f.ui.click('编辑'); await f.ui.input('描述', '本窗确认删除的稿')
    const key = `dsh-translation-plugin:topic-archive:v1:${encodeURIComponent(f.session.topicId)}`, saved = JSON.parse(f.app.storage.getItem(key))
    f.app.changeStorage(key, JSON.stringify(deleteTopicArchiveEntry(saved, a.id, a.version, new Date().toISOString()).snapshot)); await f.ui.flush()
    assert.equal(f.ui.control('描述').props.value, '本窗确认删除的稿')
    await f.ui.click('查看已删除条目的草稿：缓存实体'); assert.equal(f.ui.control('描述').props.value, '缓存中的未保存稿')
    assert.equal(f.ui.button('保存并采用').props.disabled, true)
    await rowClick(f, b.id, '详情'); assert.equal(f.ui.control('描述').props.value, '本窗确认删除的稿')
    await rowClick(f, b.id, '删除'); await f.ui.click('确认删除档案')
    assert.ok(!f.ui.nodes().some(node => node.props['aria-label'] === '编辑实体'))
    assert.ok(!f.ui.nodes().some(node => node.props['aria-label'] === '查看已删除条目的草稿：本窗删除实体'))
    assert.ok(f.ui.button('查看已删除条目的草稿：缓存实体'))
    assert.equal((await snapshot(f)).entries.length, 0)
  } finally { await f.app.dispose() }
})
