import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionStore } from '../dist/client/session-store.js'
import { DEFAULT_SESSION_SETTINGS, SETTINGS_KEY, LEGACY_SETTINGS_KEY, LEGACY_DRAFT_PREFIX, HISTORY_PREFIX, decodeSession, historyKey, parseSettings, validateSessionSettings } from '../dist/client/sessions.js'
import { DEFAULT_SETTINGS, createDraft } from '../dist/client/legacy-state.js'
import { TOPIC_LOCK_NAME, decodeTopicIdentity, topicIdentityKey, topicNameKey, deletedSessionKey } from '../dist/client/topics.js'

class Locks {
  tail = Promise.resolve()
  request(name, action) {
    assert.equal(name, TOPIC_LOCK_NAME)
    const operation = this.tail.then(action)
    this.tail = operation.catch(() => {})
    return operation
  }
  block() {
    let release
    const gate = new Promise(resolve => { release = resolve })
    this.tail = this.tail.then(() => gate)
    return release
  }
}
class Storage {
  locks = new Locks()
  values = new Map()
  failSet = false
  failRemoveKey
  get length() { return this.values.size }
  key(i) { return [...this.values.keys()][i] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { if (this.failSet) throw new Error('quota'); this.values.set(key, value) }
  removeItem(key) { if (key === this.failRemoveKey) throw new Error('blocked'); this.values.delete(key) }
}
function makeStore(storage, listen) { return new SessionStore(storage, listen, storage?.locks) }
const settle = () => new Promise(resolve => setImmediate(resolve))
async function update(store, ...args) { const result = store.updateSession(...args); await settle(); return result }
async function archive(store, ...args) { const result = store.archiveSession(...args); await settle(); return result }
async function patch(store, ...args) { const result = await store.patchSettingsAsync(...args); await settle(); return result }
function enabled() { const storage = new Storage(); storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: true })); return storage }
function events() { let fn; let stopped = false; return { listen(listener) { fn = listener; return () => { fn = undefined; stopped = true } }, send(key) { fn?.(key) }, get stopped() { return stopped } } }
function oldDraft(storage, mode = 'quick') {
  const key = `${LEGACY_DRAFT_PREFIX}main-a:${mode}`
  storage.setItem(key, JSON.stringify({ schemaVersion: 1, token: 'old', draft: { ...createDraft(DEFAULT_SETTINGS, mode), sourceText: '旧原文', manualTranslation: '旧人工稿', providerId: 'old-provider', modelId: 'old-model' } }))
  return key
}

test('新设置只包含新会话默认值和历史开关，默认关闭保存', async () => {
  assert.deepEqual(validateSessionSettings(DEFAULT_SESSION_SETTINGS), [])
  assert.equal(DEFAULT_SESSION_SETTINGS.rememberHistory, false)
  assert.ok(validateSessionSettings({ ...DEFAULT_SESSION_SETTINGS, providerId: 'unexpected' }).length)
  assert.ok(validateSessionSettings({ ...DEFAULT_SESSION_SETTINGS, maxInputChars: 0 }).length)
  assert.ok(validateSessionSettings({ ...DEFAULT_SESSION_SETTINGS, targetLanguage: '' }).length)
})
test('旧默认值兼容读取，手动保存开关不自动升级为自动历史保存', async () => {
  const legacy = JSON.stringify({ ...DEFAULT_SETTINGS, rememberDrafts: true, targetLanguage: '日本語' })
  assert.equal(parseSettings(null, legacy).targetLanguage, '日本語')
  assert.equal(parseSettings(null, legacy).rememberHistory, false)
  assert.equal(parseSettings('{broken', legacy), undefined)
})
test('即时设置按修改字段合并最新值，多个窗口不会覆盖彼此未修改的字段', async () => {
  const storage = new Storage(); const first = makeStore(storage); const second = makeStore(storage)
  assert.equal(await patch(first, { targetLanguage: 'English' }), true)
  assert.equal(await patch(second, { maxInputChars: 300 }), true)
  const saved = JSON.parse(storage.getItem(SETTINGS_KEY))
  assert.equal(saved.targetLanguage, 'English'); assert.equal(saved.maxInputChars, 300)
})
test('无效设置不写入，存储失败报告失败，不伪造保存成功', async () => {
  const storage = new Storage(); const store = makeStore(storage)
  assert.equal(await patch(store, { targetLanguage: '' }), false)
  assert.equal(storage.getItem(SETTINGS_KEY), null)
  storage.failSet = true
  assert.equal(await patch(store, { targetLanguage: 'English' }), false)
  assert.equal(store.getSettings().targetLanguage, '中文')
  assert.equal(await makeStore().patchSettingsAsync({ defaultMode: 'normal' }), false)
})
test('新会话有独立 ID，默认名称与父会话编号命名正确，内容不隐式继承', async () => {
  const store = makeStore(new Storage())
  const a = await store.createSessionAsync('main-a'); const b = await store.createSessionAsync('main-a')
  assert.notEqual(a.id, b.id); assert.equal(a.name, '新翻译会话')
  await store.renameSessionAsync(a.id, '故事A'); await update(store, a.id, { input: '父会话输入' })
  const c = await store.createSessionAsync('main-a', a.id); const d = await store.createSessionAsync('main-a', a.id)
  assert.equal(c.name, '故事A-01'); assert.equal(d.name, '故事A-02'); assert.equal(c.parentId, a.id); assert.equal(c.input, '')
  assert.equal(store.getActiveSessions('main-a').length, 4)
  assert.equal(await store.createSessionAsync('other', a.id), undefined)
})
test('长名称编号不截断 emoji 编码且保持名称长度合法', async () => {
  const store = makeStore(new Storage()); const a = await store.createSessionAsync('main-a')
  assert.equal(await store.renameSessionAsync(a.id, '😀'.repeat(120)), true)
  const child = await store.createSessionAsync('main-a', a.id)
  assert.ok(decodeSession(child)); assert.equal(Array.from(child.topicName).length, 120)
  assert.equal(child.name, `${'😀'.repeat(120)}-01`); assert.equal(Array.from(child.name).length, 123)
  assert.equal(await store.renameSessionAsync(a.id, ' '), false)
})
test('模式是会话属性，切换保留内容；主窗口范围和不同翻译会话不串输入', async () => {
  const store = makeStore(new Storage()); const a = await store.createSessionAsync('main-a'); const b = await store.createSessionAsync('main-a'); const c = await store.createSessionAsync('main-b')
  await update(store, a.id, { input: 'A', mode: 'normal' }); await update(store, b.id, { input: 'B' })
  assert.equal(store.getSession(a.id).input, 'A'); assert.equal(store.getSession(a.id).mode, 'normal')
  assert.equal(store.getSession(b.id).input, 'B'); assert.equal(store.getSession(c.id).input, '')
  store.openSession('main-b', a.id); assert.equal(store.getActiveSession('main-b').id, c.id)
})
test('归档保留当前窗口会话与输入，恢复后回到使用列表', async () => {
  const store = makeStore(new Storage()); const a = await store.createSessionAsync('main-a')
  await update(store, a.id, { input: '未保存输入' }); await archive(store, 'main-a', a.id)
  assert.equal(store.getActiveSessions('main-a').length, 0)
  assert.equal(store.getArchivedSessions('main-a').length, 1)
  assert.equal(store.getAvailableSessions('main-a')[0].input, '未保存输入')
  store.openSession('main-a', a.id); assert.equal(store.getActiveSession('main-a'), undefined)
  await archive(store, 'main-a', a.id, false); assert.equal(store.getActiveSession('main-a').input, '未保存输入')
})
test('新会话冻结默认模式、语言、要求、单次上限，修改默认值只影响后续会话', async () => {
  const store = makeStore(new Storage()); const a = await store.createSessionAsync('main-a')
  await patch(store, { targetLanguage: 'English', defaultInstruction: '保持术语', maxInputChars: 3, defaultMode: 'normal' })
  const b = await store.createSessionAsync('main-a')
  assert.equal(store.getSession(a.id).targetLanguage, '中文'); assert.equal(store.getSession(a.id).maxInputChars, 20000)
  assert.equal(b.targetLanguage, 'English'); assert.equal(b.instruction, '保持术语'); assert.equal(b.maxInputChars, 3)
})
test('开启历史后自动保存；关闭保留旧历史并停止写入；恢复默认也保留历史', async () => {
  const storage = new Storage(); const store = makeStore(storage); const a = await store.createSessionAsync('main-a')
  await update(store, a.id, { input: '先在内存' }); assert.equal(store.getHistory().length, 0)
  await patch(store, { rememberHistory: true }); assert.equal(store.getHistory()[0].input, '先在内存')
  await update(store, a.id, { input: '已保存输入' }); const saved = storage.getItem(historyKey(a.id))
  await patch(store, { rememberHistory: false }); await update(store, a.id, { input: '关闭后的输入', mode: 'normal' })
  assert.equal(storage.getItem(historyKey(a.id)), saved); assert.equal(store.getHistory()[0].input, '已保存输入'); assert.equal(store.getHistory()[0].mode, 'quick')
  await patch(store, { ...DEFAULT_SESSION_SETTINGS }); assert.equal(store.getHistory().length, 1)
  const restarted = makeStore(storage); restarted.ensureWorkspace('main-a')
  assert.equal(restarted.getActiveSession('main-a').input, '已保存输入')
})
test('历史清理支持快译、单条和多条，范围外记录与其他应用数据保留', async () => {
  const storage = enabled(); storage.setItem('other-app', 'keep'); const store = makeStore(storage)
  const quick = await store.createSessionAsync('main-a'); const normal = await store.createSessionAsync('main-a'); await update(store, normal.id, { mode: 'normal' })
  assert.equal(await store.deleteHistoryAsync(store.getHistory().filter(item => item.mode === 'quick').map(item => item.id)), true)
  assert.equal(store.getSession(quick.id), undefined); assert.equal(store.getSession(normal.id).mode, 'normal')
  assert.equal(storage.getItem('other-app'), 'keep')
  const b = await store.createSessionAsync('main-b'); assert.equal(await store.deleteHistoryAsync([normal.id, b.id]), true); assert.equal(store.getHistory().length, 0)
})
test('关联记忆删除尚未实现时明确拒绝，不提前删除历史', async () => {
  const storage = enabled(); const store = makeStore(storage); const a = await store.createSessionAsync('main-a')
  assert.equal(await store.deleteHistoryAsync([a.id], true), false); assert.ok(storage.getItem(historyKey(a.id)))
})
test('损坏历史原样保留，全部清理的明确范围可包含无法读取副本', async () => {
  const storage = enabled(); storage.setItem(`${HISTORY_PREFIX}broken`, '{broken'); storage.setItem('foreign', 'keep')
  const store = makeStore(storage); const a = await store.createSessionAsync('main-a'); const bad = store.getUnreadableHistory()
  assert.equal(bad.length, 1); assert.equal(await store.deleteHistoryAsync([a.id], false, bad), true)
  assert.equal(storage.getItem(`${HISTORY_PREFIX}broken`), null); assert.equal(storage.getItem('foreign'), 'keep')
  assert.equal(await store.deleteHistoryAsync([], false, [{ key: 'foreign', raw: 'keep' }]), false)
})
test('删除失败时保留当前输入，修复存储后允许重试', async () => {
  const storage = enabled(); const store = makeStore(storage); const a = await store.createSessionAsync('main-a')
  await update(store, a.id, { input: '保留输入' }); storage.failRemoveKey = historyKey(a.id)
  assert.equal(await store.deleteHistoryAsync([a.id]), false); assert.equal(store.getSession(a.id).input, '保留输入')
  storage.failRemoveKey = undefined; assert.equal(await store.deleteHistoryAsync([a.id]), true)
})
test('旧草稿转为可查看历史，编辑后写新版；删除同时处理新版与旧版副本', async () => {
  const storage = enabled(); const oldKey = oldDraft(storage); const store = makeStore(storage)
  const a = store.getHistory()[0]; assert.equal(a.input, '旧原文'); assert.equal(a.legacyManualText, '旧人工稿'); assert.equal(a.model.model, 'old-model')
  store.openSession('main-a', a.id); await update(store, a.id, { input: '新版编辑' })
  assert.ok(storage.getItem(oldKey)); assert.ok(storage.getItem(historyKey(a.id)))
  storage.failRemoveKey = oldKey
  assert.equal(await store.deleteHistoryAsync([a.id]), false); assert.equal(store.getSession(a.id).input, '新版编辑')
  storage.failRemoveKey = undefined; assert.equal(await store.deleteHistoryAsync([a.id]), true)
  assert.equal(storage.getItem(oldKey), null); assert.equal(storage.getItem(historyKey(a.id)), null)
})
test('存储配额失败只影响持久化，不丢当前输入', async () => {
  const storage = enabled(); const store = makeStore(storage); const a = await store.createSessionAsync('main-a')
  storage.failSet = true; assert.equal(await update(store, a.id, { input: '仍可编辑😀' }), true)
  assert.equal(store.getSession(a.id).input, '仍可编辑😀'); assert.equal(store.getStatus(a.id), 'error'); assert.ok(store.getNotice())
})
test('两窗口陈旧保存被拒绝，明确覆盖才可替换；读取不存在副本保留编辑', async () => {
  const storage = enabled(); const first = makeStore(storage); const a = await first.createSessionAsync('main-a'); const second = makeStore(storage)
  await update(first, a.id, { input: '第一窗口' }); await update(second, a.id, { input: '第二窗口' })
  assert.equal(second.getStatus(a.id), 'conflict'); assert.equal(second.getSession(a.id).input, '第二窗口')
  assert.equal(await second.overwriteSessionAsync(a.id), true); assert.equal(JSON.parse(storage.getItem(historyKey(a.id))).session.input, '第二窗口')
  storage.removeItem(historyKey(a.id)); assert.equal(second.reloadSession(a.id), false); assert.equal(second.getSession(a.id).input, '第二窗口')
})
test('其他窗口关闭历史保存后，旧窗口写前重新检查开关', async () => {
  const storage = enabled(); const first = makeStore(storage); const a = await first.createSessionAsync('main-a'); const second = makeStore(storage)
  const before = storage.getItem(historyKey(a.id)); await patch(first, { rememberHistory: false })
  await update(second, a.id, { input: '不再落盘' }); assert.equal(storage.getItem(historyKey(a.id)), before); assert.equal(second.getSettings().rememberHistory, false)
})
test('存储事件自动同步设置，未保存输入遇到外部更新保留并提示冲突', async () => {
  const storage = enabled(); const first = makeStore(storage); const a = await first.createSessionAsync('main-a'); const bus = events(); const second = makeStore(storage, bus.listen)
  await patch(first, { rememberHistory: false, targetLanguage: 'English' }); bus.send(SETTINGS_KEY)
  assert.equal(second.getSettings().targetLanguage, 'English'); await update(second, a.id, { input: '本窗口编辑' })
  await patch(first, { rememberHistory: true }); await update(first, a.id, { input: '其他窗口编辑' }); bus.send(historyKey(a.id))
  assert.equal(second.getSession(a.id).input, '本窗口编辑'); assert.equal(second.getStatus(a.id), 'conflict')
})
test('删除前检测外部版本变化，防止清理新历史；监听按生命周期释放', async () => {
  const storage = enabled(); const bus = events(); const store = makeStore(storage, bus.listen); const a = await store.createSessionAsync('main-a'); const other = makeStore(storage)
  await update(other, a.id, { input: '外部更新' }); assert.equal(await store.deleteHistoryAsync([a.id]), false); assert.ok(storage.getItem(historyKey(a.id)))
  store.dispose(); assert.equal(bus.stopped, true)
})
test('单次上限不会裁剪输入，绝对边界拒绝时保留原值', async () => {
  const store = makeStore(new Storage()); await patch(store, { maxInputChars: 1 }); const a = await store.createSessionAsync('main-a')
  await update(store, a.id, { input: '😀中' }); assert.equal(store.getSession(a.id).input, '😀中')
  assert.equal(await update(store, a.id, { input: 'x'.repeat(200001) }), false); assert.equal(store.getSession(a.id).input, '😀中')
})
test('删除确认冻结版本；收到同步事件后仍不删除确认期间更新的历史', async () => {
  const storage = enabled(); const bus = events(); const first = makeStore(storage, bus.listen); const a = await first.createSessionAsync('main-a')
  const frozen = first.captureHistoryVersions([a.id]); const second = makeStore(storage)
  await update(second, a.id, { input: '确认期间新增内容' }); bus.send(historyKey(a.id))
  assert.equal(first.getSession(a.id).input, '确认期间新增内容')
  assert.equal(await first.deleteHistoryAsync([a.id], false, [], frozen), false)
  assert.ok(storage.getItem(historyKey(a.id)))
})
test('损坏设置拒绝猜测覆盖，只有明确恢复默认才修复；历史仍保留', async () => {
  const storage = enabled(); const store = makeStore(storage); const a = await store.createSessionAsync('main-a')
  storage.setItem(SETTINGS_KEY, '{broken')
  assert.equal(await patch(store, { targetLanguage: 'English' }), false); assert.equal(storage.getItem(SETTINGS_KEY), '{broken')
  assert.equal(await patch(store, {}, true), true); assert.equal(JSON.parse(storage.getItem(SETTINGS_KEY)).rememberHistory, false)
  assert.ok(storage.getItem(historyKey(a.id)))
})

test('归档与恢复遵守历史开关，保存的归档状态重启后保留', async () => {
  const storage = enabled(); const store = makeStore(storage); const a = await store.createSessionAsync('main-a'); const b = await store.createSessionAsync('main-a')
  await update(store, a.id, { input: '归档原文' }); store.openSession('main-a', a.id)
  assert.equal(await archive(store, 'wrong-owner', a.id), false)
  assert.equal(await archive(store, 'main-a', a.id), true); assert.equal(store.getActiveSession('main-a').id, b.id)
  assert.equal(store.getArchivedSessions('main-a')[0].input, '归档原文'); assert.ok(JSON.parse(storage.getItem(historyKey(a.id))).session.archivedAt)
  const restarted = makeStore(storage); restarted.ensureWorkspace('main-a')
  assert.equal(restarted.getActiveSession('main-a').id, b.id); assert.equal(restarted.getArchivedSessions('main-a').length, 1)
  await archive(restarted, 'main-a', a.id, false); assert.equal(restarted.getActiveSession('main-a').input, '归档原文')
  assert.equal(JSON.parse(storage.getItem(historyKey(a.id))).session.archivedAt, null)
})

test('关闭保存后归档只改变当前窗口，不改写已有历史；开启后保存归档内容', async () => {
  const storage = enabled(); const store = makeStore(storage); const a = await store.createSessionAsync('main-a'); const raw = storage.getItem(historyKey(a.id))
  await patch(store, { rememberHistory: false }); await archive(store, 'main-a', a.id)
  assert.equal(storage.getItem(historyKey(a.id)), raw); assert.ok(store.getSession(a.id).archivedAt)
  await patch(store, { rememberHistory: true }); assert.ok(JSON.parse(storage.getItem(historyKey(a.id))).session.archivedAt)
})

test('旧 v2 会话缺少归档字段时兼容读取，不因读取改写历史', async () => {
  const storage = enabled(); const original = makeStore(storage); const a = await original.createSessionAsync('main-a')
  const data = JSON.parse(storage.getItem(historyKey(a.id)))
  const { archivedAt: _archived, topicId: _topic, sequenceNamespaceId: _namespace, topicName: _name, sequence: _sequence, remark: _remark, legacyName: _legacy, ...v2 } = data.session
  data.schemaVersion = 2; data.session = { ...v2, schemaVersion: 2 }
  const raw = JSON.stringify(data); storage.setItem(historyKey(a.id), raw)
  const store = makeStore(storage); assert.equal(store.getSession(a.id).archivedAt, null); assert.equal(storage.getItem(historyKey(a.id)), raw)
  assert.equal(decodeSession({ ...data.session, archivedAt: 'not-date' }), undefined)
})

test('无本地存储时可删除纯内存会话，删除后切换到剩余会话', async () => {
  const store = makeStore(); const a = await store.createSessionAsync('main-a'); const b = await store.createSessionAsync('main-a')
  await update(store, b.id, { input: '内存文本' }); const expected = store.captureHistoryVersions([b.id])
  assert.equal(await store.deleteHistoryAsync([b.id], false, [], expected), true)
  assert.equal(store.getSession(b.id), undefined); assert.equal(store.getActiveSession('main-a').id, a.id)
})

test('删除确认期间内存输入修改，即使没有落盘也拒绝陈旧删除', async () => {
  const store = makeStore(new Storage()); const a = await store.createSessionAsync('main-a'); const expected = store.captureHistoryVersions([a.id])
  await update(store, a.id, { input: '确认后新增输入' })
  assert.equal(await store.deleteHistoryAsync([a.id], false, [], expected), false); assert.equal(store.getSession(a.id).input, '确认后新增输入')
})

test('其他窗口归档已保存的当前会话后，干净窗口同步归档并切换选择', async () => {
  const storage = enabled(); const first = makeStore(storage); const a = await first.createSessionAsync('main-a'); const b = await first.createSessionAsync('main-a')
  const bus = events(); const second = makeStore(storage, bus.listen); second.ensureWorkspace('main-a'); second.openSession('main-a', a.id)
  await archive(first, 'main-a', a.id); bus.send(historyKey(a.id))
  assert.equal(second.getArchivedSessions('main-a').length, 1); assert.equal(second.getActiveSession('main-a').id, b.id)
})

test('历史清理包含已归档会话，删除一个归档不会删除兄弟或父子会话', async () => {
  const storage = enabled(); const store = makeStore(storage); const a = await store.createSessionAsync('main-a'); const child = await store.createSessionAsync('main-a', a.id)
  await archive(store, 'main-a', a.id); assert.equal(store.getHistory().length, 2)
  assert.equal(await store.deleteHistoryAsync([a.id]), true); assert.ok(store.getSession(child.id)); assert.ok(storage.getItem(historyKey(child.id)))
})

test('同主题从任意分支统一递增，删除归档重命名均不回填编号', async () => {
  const storage = enabled(); const store = makeStore(storage)
  const root = await store.createSessionAsync('main-a')
  const one = await store.createSessionAsync('main-a', root.id)
  const two = await store.createSessionAsync('main-a', one.id)
  assert.equal(two.name, '新翻译会话-02'); assert.equal(two.parentId, one.id)
  assert.equal(two.topicId, root.topicId); assert.equal(two.sequenceNamespaceId, root.sequenceNamespaceId)
  await store.deleteHistoryAsync([one.id]); await archive(store, 'main-a', two.id)
  assert.equal(await store.renameSessionAsync(root.id, '统一主题'), true)
  assert.equal(store.getSession(root.id).name, '统一主题'); assert.equal(store.getSession(two.id).name, '统一主题-02')
  const three = await store.createSessionAsync('main-a', two.id)
  assert.equal(three.name, '统一主题-03'); assert.equal(three.sequence, 3)
  assert.equal(store.getTopics('main-a')[0].nextSequence, 4)
})

test('子会话继承起点配置，草稿备注和同主题其他会话档位相互独立', async () => {
  const store = makeStore(new Storage()); const root = await store.createSessionAsync('main-a')
  const quick = await store.createSessionAsync('main-a', root.id)
  await update(store, root.id, { mode: 'normal', targetLanguage: 'English', instruction: '保留术语', maxInputChars: 12, model: { provider: 'p', model: 'm', reasoningEffort: 'high' }, input: '父稿', remark: '重复备注' })
  const child = await store.createSessionAsync('main-a', root.id)
  assert.equal(child.mode, 'normal'); assert.equal(child.targetLanguage, 'English'); assert.equal(child.instruction, '保留术语'); assert.equal(child.maxInputChars, 12)
  assert.deepEqual(child.model, { provider: 'p', model: 'm', reasoningEffort: 'high' }); assert.notEqual(child.model, store.getSession(root.id).model)
  assert.equal(child.input, ''); assert.equal(child.remark, ''); assert.equal(store.getSession(quick.id).mode, 'quick')
  assert.equal(await update(store, child.id, { mode: 'quick' }), false); assert.equal(store.getSession(child.id).mode, 'normal')
  assert.equal(await update(store, child.id, { remark: '重复备注' }), true)
  assert.equal(await update(store, child.id, { remark: '' }), true); assert.equal(store.getSession(root.id).remark, '重复备注')
})

test('关闭历史的新子会话仅写编号身份，不写新名称备注原文或历史', async () => {
  const storage = enabled(); const store = makeStore(storage); const root = await store.createSessionAsync('main-a')
  const history = storage.getItem(historyKey(root.id)), name = storage.getItem(topicNameKey(root.topicId))
  await patch(store, { rememberHistory: false }); await store.renameSessionAsync(root.id, '关闭后的私有名称')
  const child = await store.createSessionAsync('main-a', root.id)
  await update(store, child.id, { input: '关闭后的私有原文', remark: '关闭后的私有备注' })
  assert.equal(storage.getItem(historyKey(root.id)), history); assert.equal(storage.getItem(topicNameKey(root.topicId)), name)
  assert.equal(storage.getItem(historyKey(child.id)), null)
  const identity = storage.getItem(topicIdentityKey(root.topicId))
  assert.equal(decodeTopicIdentity(identity).nextSequence, 2)
  for (const secret of ['关闭后的私有名称', '关闭后的私有原文', '关闭后的私有备注']) assert.ok(![...storage.values.values()].some(raw => raw.includes(secret)))
  const restarted = makeStore(storage); assert.equal(restarted.getSession(child.id), undefined)
  const next = await restarted.createSessionAsync('main-a', root.id); assert.equal(next.sequence, 2)
  assert.equal(storage.getItem(historyKey(next.id)), null)
})

test('删除最后一个会话后主题与高水位保留，同名新主题使用不同身份', async () => {
  const storage = enabled(); const store = makeStore(storage); const root = await store.createSessionAsync('main-a')
  const child = await store.createSessionAsync('main-a', root.id)
  await store.deleteHistoryAsync([root.id, child.id]); assert.equal(store.getAvailableSessions('main-a').length, 0)
  const restarted = makeStore(storage); const continued = await restarted.createSessionForTopicAsync('main-a', root.topicId)
  assert.equal(continued.sequence, 2); assert.equal(continued.topicId, root.topicId)
  const different = await restarted.createSessionAsync('main-a')
  assert.notEqual(different.topicId, root.topicId); assert.notEqual(different.sequenceNamespaceId, root.sequenceNamespaceId); assert.equal(different.sequence, 0)
})

test('两窗口并发新建子会话由同一锁取得唯一连续编号', async () => {
  const storage = enabled(); const first = makeStore(storage); const root = await first.createSessionAsync('main-a'); const second = makeStore(storage)
  const [a, b] = await Promise.all([first.createSessionAsync('main-a', root.id), second.createSessionAsync('main-a', root.id)])
  assert.deepEqual([a.sequence, b.sequence].sort(), [1, 2]); assert.notEqual(a.id, b.id)
  const identity = decodeTopicIdentity(storage.getItem(topicIdentityKey(root.topicId)))
  assert.equal(identity.nextSequence, 3); assert.equal(new Set(identity.allocations.map(item => item.sequence)).size, 3)
  assert.equal(makeStore(storage).getHistory().length, 3)
})

test('另一窗口重新开启保存后自动保存本窗口关闭期间的输入', async () => {
  const storage = enabled(); const first = makeStore(storage); const root = await first.createSessionAsync('main-a')
  const bus = events(); const second = makeStore(storage, bus.listen)
  await patch(first, { rememberHistory: false }); bus.send(SETTINGS_KEY)
  await update(second, root.id, { input: '关闭期间的本窗口输入' })
  await patch(first, { rememberHistory: true }); bus.send(SETTINGS_KEY); await settle()
  assert.equal(second.getSettings().rememberHistory, true)
  assert.equal(JSON.parse(storage.getItem(historyKey(root.id))).session.input, '关闭期间的本窗口输入')
  assert.equal(second.getStatus(root.id), 'saved')
})

test('排在关闭保存后的异步正文保存不落盘，保留新输入', async () => {
  const storage = enabled(); const store = makeStore(storage); const root = await store.createSessionAsync('main-a')
  const before = storage.getItem(historyKey(root.id)), release = storage.locks.block()
  const closing = store.patchSettingsAsync({ rememberHistory: false })
  assert.equal(store.updateSession(root.id, { input: '排队期间的新输入' }), true)
  release(); assert.equal(await closing, true); await settle()
  assert.equal(storage.getItem(historyKey(root.id)), before); assert.equal(store.getSession(root.id).input, '排队期间的新输入')
  assert.equal(store.getStatus(root.id), 'memory')
})

test('删除屏障阻止另一窗口排队保存与明确覆盖恢复已删除身份', async () => {
  const storage = enabled(); const first = makeStore(storage); const root = await first.createSessionAsync('main-a'); const second = makeStore(storage)
  const release = storage.locks.block(), deleting = first.deleteHistoryAsync([root.id])
  assert.equal(second.updateSession(root.id, { input: '另一窗口的迟到草稿' }), true)
  release(); assert.equal(await deleting, true); await settle()
  assert.ok(storage.getItem(deletedSessionKey(root.id))); assert.equal(storage.getItem(historyKey(root.id)), null)
  assert.equal(second.getSession(root.id).input, '另一窗口的迟到草稿'); assert.equal(second.getStatus(root.id), 'conflict')
  assert.equal(await second.overwriteSessionAsync(root.id), false); assert.equal(makeStore(storage).getSession(root.id), undefined)
})

function v2Record(id, name, parentId = null, childSequence = 0) {
  return { schemaVersion: 2, id, ownerId: 'main-a', name, parentId, childSequence, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', mode: 'quick', targetLanguage: '中文', instruction: '', maxInputChars: 20000, model: null, input: `原文-${id}`, legacyManualText: '', legacyKey: null }
}
test('旧父子关系迁移为统一主题，保留旧名称且同名独立会话不合并', async () => {
  const storage = new Storage(), raws = new Map()
  for (const session of [v2Record('a', '旧主题', null, 5), v2Record('b', '旧主题-01', 'a'), v2Record('c', '旧主题-01-01', 'b'), v2Record('d', '旧主题')]) {
    const raw = JSON.stringify({ schemaVersion: 2, token: session.id, session }); raws.set(historyKey(session.id), raw); storage.setItem(historyKey(session.id), raw)
  }
  const store = makeStore(storage)
  assert.equal(store.getSession('c').legacyName, '旧主题-01-01'); assert.equal(store.getSession('c').name, '旧主题-02')
  assert.equal(store.getSession('a').topicId, store.getSession('c').topicId); assert.notEqual(store.getSession('a').topicId, store.getSession('d').topicId)
  for (const [key, raw] of raws) assert.equal(storage.getItem(key), raw)
  assert.equal(await store.deleteHistoryAsync(['a']), true)
  const next = await store.createSessionAsync('main-a', 'c'); assert.equal(next.sequence, 6); assert.equal(next.name, '旧主题-06')
  assert.equal(storage.getItem(historyKey('c')), raws.get(historyKey('c')))
})

test('删除旧草稿即使副本清理失败，重启也不会重新导入', async () => {
  const storage = new Storage(), key = oldDraft(storage), store = makeStore(storage), root = store.getHistory()[0]
  storage.failRemoveKey = key; assert.equal(await store.deleteHistoryAsync([root.id]), false)
  assert.equal(storage.getItem(key) !== null, true); assert.ok(storage.getItem(deletedSessionKey(root.id)))
  const restarted = makeStore(storage); assert.equal(restarted.getSession(root.id), undefined)
  const stale = store.getSession(root.id); assert.equal(stale.input, '旧原文')
})

test('缺少Web Locks时保留临时编辑并拒绝持久新建保存及删除', async () => {
  const storage = new Storage(), store = new SessionStore(storage, undefined, null)
  const root = await store.createSessionAsync('main-a'); assert.ok(root)
  assert.equal(await store.patchSettingsAsync({ rememberHistory: true }), false)
  assert.equal(store.updateSession(root.id, { input: '临时原文' }), true)
  assert.equal(storage.getItem(historyKey(root.id)), null)
  const reliableStorage = enabled(), reliable = makeStore(reliableStorage), saved = await reliable.createSessionAsync('main-a')
  const unavailable = new SessionStore(reliableStorage, undefined, null)
  assert.equal(await unavailable.createSessionAsync('main-a', saved.id), undefined)
  assert.equal(await unavailable.deleteHistoryAsync([saved.id]), false)
  assert.ok(reliableStorage.getItem(historyKey(saved.id)))
})

test('编号记录保存失败不创建会话，恢复存储后继续安全取号', async () => {
  const storage = enabled(), store = makeStore(storage), root = await store.createSessionAsync('main-a')
  storage.failSet = true; assert.equal(await store.createSessionAsync('main-a', root.id), undefined)
  assert.equal(store.getAvailableSessions('main-a').length, 1); assert.ok(store.getNotice())
  storage.failSet = false; const next = await store.createSessionAsync('main-a', root.id)
  assert.equal(next.sequence, 1); assert.equal(decodeTopicIdentity(storage.getItem(topicIdentityKey(root.topicId))).nextSequence, 2)
})

test('读取副本拒绝与主题编号身份不一致的数据并保留当前输入', async () => {
  const storage = enabled(), store = makeStore(storage), root = await store.createSessionAsync('main-a')
  await patch(store, { rememberHistory: false }); await update(store, root.id, { input: '不能丢失的当前输入' })
  const raw = JSON.parse(storage.getItem(historyKey(root.id)))
  raw.token = 'invalid-sequence'; raw.session.sequence = 9; raw.session.name = `${raw.session.topicName}-09`
  storage.setItem(historyKey(root.id), JSON.stringify(raw))
  assert.equal(store.reloadSession(root.id), false); assert.equal(store.getSession(root.id).input, '不能丢失的当前输入')
})

test('主题身份解码拒绝重复编号和无效高水位，名称正文不混入身份', async () => {
  const storage = enabled(), store = makeStore(storage), root = await store.createSessionAsync('main-a')
  const identity = decodeTopicIdentity(storage.getItem(topicIdentityKey(root.topicId)))
  assert.deepEqual(Object.keys(identity).sort(), ['schemaVersion', 'id', 'ownerId', 'sequenceNamespaceId', 'nextSequence', 'version', 'allocations'].sort())
  assert.equal(decodeTopicIdentity(JSON.stringify({ ...identity, allocations: [...identity.allocations, { sessionId: 'different', sequence: 0 }] })), undefined)
  assert.equal(decodeTopicIdentity(JSON.stringify({ ...identity, nextSequence: 0 })), undefined)
  assert.equal(decodeTopicIdentity(JSON.stringify({ ...identity, remark: '不应保存' })), undefined)
})
