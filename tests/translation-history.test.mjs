import assert from 'node:assert/strict'
import test from 'node:test'
import {
  emptyTranslationHistory, decodeTranslationHistory, restoreTranslationHistory,
  appendTextUnit, appendTextRevision, acceptTextRevision, updateTextRevision, selectFinalRevision,
} from '../dist/client/translation-history.js'
import { SessionStore } from '../dist/client/session-store.js'
import { DEFAULT_SESSION_SETTINGS, SETTINGS_KEY, historyKey, newSession } from '../dist/client/sessions.js'
import { TOPIC_LOCK_NAME, deletedSessionKey } from '../dist/client/topics.js'
import { sessionModelKey, ownerModelKey } from '../dist/client/model-preferences.js'

const at = '2026-10-05T00:00:00.000Z', later = '2026-10-05T00:01:00.000Z'
const model = { provider: 'synthetic', model: 'translator', reasoningEffort: 'high' }
function revision(id, patch = {}) {
  return { id, operationId: `operation:${id}`, model, draftVersion: 1, createdAt: at, updatedAt: at,
    accepted: true, status: 'completed', text: `合成译文:${id}`, message: null, ...patch }
}
function material(id) { return { id, source: `合成原文:${id}`, targetLanguage: '中文', instruction: '保留合成标记', createdAt: at } }
function initial() { return appendTextUnit(emptyTranslationHistory(), material('unit:1'), revision('revision:1')) }
function clone(value) { return structuredClone(value) }
class Locks {
  tail = Promise.resolve()
  afterAction
  request(name, action) { assert.equal(name, TOPIC_LOCK_NAME); const next = this.tail.then(async () => { const result = await action(); this.afterAction?.(); return result }); this.tail = next.catch(() => {}); return next }
  block() { let release; this.tail = this.tail.then(() => new Promise(resolve => { release = resolve })); return async () => { await settle(); release() } }
}
class Storage {
  values = new Map()
  locks = new Locks()
  failSet = false
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { if (this.failSet) throw new Error('synthetic quota'); this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}
const settle = () => new Promise(resolve => setImmediate(resolve))
function makeStore(storage, listen) { return new SessionStore(storage, listen, storage?.locks) }
function enabled() { const storage = new Storage(); storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: true })); return storage }
async function update(store, id, callback) { const result = store.updateTranslationHistory(id, callback); await settle(); return result }
async function patch(store, edits) { const result = await store.patchSettingsAsync(edits); await settle(); return result }
function events() { let fn; return { listen(callback) { fn = callback; return () => { fn = undefined } }, send(key) { fn?.(key) } } }

test('新单元受理与上一单元自动定稿一次转换，正文仅保存在修订中', () => {
  const first = initial(), second = appendTextUnit(first, material('unit:2'), revision('revision:2'))
  assert.equal(first.units[0].final, null)
  assert.deepEqual(second.units[0].final, { revisionId: 'revision:1', selection: 'automatic', selectedAt: at })
  assert.equal(second.units[1].final, null)
  assert.deepEqual(second.units.map(unit => unit.order), [1, 2])
  assert.equal(second.events.filter(event => event.type === 'final.selected').length, 1)
  assert.equal(JSON.stringify(second).split('合成译文:revision:1').length - 1, 1)
  assert.ok(decodeTranslationHistory(second))
  assert.throws(() => appendTextUnit(first, material('unit:2'), revision('revision:2', { accepted: false, status: 'running', text: '' })))
})
test('同单元重译保留冻结材料与实际模型，受理顺序不取决于回执时间', () => {
  const first = initial(), revised = appendTextRevision(first, 'unit:1', revision('revision:2', { createdAt: '2026-10-04T00:00:00.000Z', model: { ...model, reasoningEffort: 'low' } }))
  const next = appendTextUnit(revised, material('unit:2'), revision('revision:3'))
  assert.equal(next.units[0].source, first.units[0].source)
  assert.equal(next.units[0].instruction, first.units[0].instruction)
  assert.deepEqual(next.units[0].revisions.map(revision => revision.order), [1, 2])
  assert.equal(next.units[0].revisions[0].model.reasoningEffort, 'high')
  assert.equal(next.units[0].revisions[1].model.reasoningEffort, 'low')
  assert.equal(next.units[0].final.revisionId, 'revision:2')
})
test('最新尝试失败、半截、未知或中断均不自动退回旧成功版', () => {
  for (const status of ['failed', 'running', 'unknown', 'cancelled', 'interrupted']) {
    const revised = appendTextRevision(initial(), 'unit:1', revision('revision:2', { status, text: '合成半截' }))
    assert.equal(appendTextUnit(revised, material('unit:2'), revision('revision:3')).units[0].final, null)
  }
  const rejected = appendTextRevision(initial(), 'unit:1', revision('revision:2', { status: 'failed', text: '', accepted: false }))
  assert.equal(appendTextUnit(rejected, material('unit:2'), revision('revision:3')).units[0].final, null)
})
test('用户固定最终版后继续试译与推进不覆盖，明确选择其他版只切换引用', () => {
  let history = selectFinalRevision(initial(), 'unit:1', 'revision:1', later)
  history = appendTextRevision(history, 'unit:1', revision('revision:2'))
  history = appendTextUnit(history, material('unit:2'), revision('revision:3'))
  assert.equal(history.units[0].final.revisionId, 'revision:1')
  assert.equal(history.units[0].final.selection, 'user_fixed')
  history = selectFinalRevision(history, 'unit:1', 'revision:2', later)
  assert.equal(history.units[0].final.revisionId, 'revision:2')
  assert.equal(history.units[0].revisions.length, 2)
  assert.equal(history.events.filter(event => event.reason === 'user_selection').length, 2)
  assert.equal(selectFinalRevision(history, 'unit:1', 'revision:2', later), history)
})
test('旧自动最终版遇到新失败保留，显式选择只允许本单元完整已受理版本', () => {
  let history = appendTextUnit(initial(), material('unit:2'), revision('revision:2'))
  history = appendTextRevision(history, 'unit:1', revision('revision:3', { status: 'failed', text: '' }))
  const next = appendTextUnit(history, material('unit:3'), revision('revision:4'))
  assert.equal(next.units[0].final.revisionId, 'revision:1')
  assert.throws(() => selectFinalRevision(next, 'unit:1', 'revision:3', later))
  assert.throws(() => selectFinalRevision(next, 'unit:1', 'revision:2', later))
})
test('重译受理不推进其他单元，重复受理及仅时间变化的轮询不新增事件', () => {
  let history = appendTextRevision(initial(), 'unit:1', revision('revision:2', { status: 'submitting', text: '', accepted: false }))
  history = acceptTextRevision(history, 'unit:1', 'revision:2', later)
  assert.equal(history.units[0].final, null)
  assert.equal(acceptTextRevision(history, 'unit:1', 'revision:2', later), history)
  assert.equal(updateTextRevision(history, 'unit:1', 'revision:2', { updatedAt: later }), history)
  const completed = updateTextRevision(history, 'unit:1', 'revision:2', { status: 'completed', text: '合成完成', updatedAt: later })
  assert.equal(completed.events.length, history.events.length + 1)
  assert.throws(() => updateTextRevision(completed, 'unit:1', 'revision:2', { text: '改写旧版本' }))
})
test('存储校验拒绝运行能力、凭据、坏指针和不合格完成，unknown可尚未确认受理', () => {
  const history = initial()
  for (const mutate of [
    value => { value.sessionKey = 'synthetic-only' },
    value => { value.units[0].revisions[0].sessionKey = 'synthetic-only' },
    value => { value.units[0].revisions[0].model.credentials = 'synthetic-only' },
    value => { value.units[0].final = { revisionId: 'missing', selection: 'automatic', selectedAt: at } },
    value => { value.units[0].revisions[0].accepted = false },
    value => { value.units[0].revisions[0].text = '' },
    value => { value.events[0].revisionId = 'missing' },
  ]) { const value = clone(history); mutate(value); assert.equal(decodeTranslationHistory(value), undefined) }
  const unknown = appendTextRevision(history, 'unit:1', revision('revision:2', { status: 'unknown', accepted: false, text: '' }))
  assert.ok(decodeTranslationHistory(unknown))
  assert.throws(() => appendTextRevision(history, 'unit:1', revision('revision:1')))
})
test('解析保留实时状态，真正恢复才转中断且不改变成功正文和最终选择', () => {
  let history = selectFinalRevision(initial(), 'unit:1', 'revision:1', at)
  history = appendTextRevision(history, 'unit:1', revision('revision:2', { status: 'running', text: '合成流式' }))
  history = appendTextRevision(history, 'unit:1', revision('revision:3', { status: 'unknown', text: '' }))
  assert.equal(decodeTranslationHistory(history).units[0].revisions[1].status, 'running')
  const restored = restoreTranslationHistory(history, later)
  assert.equal(history.units[0].revisions[1].status, 'running')
  assert.deepEqual(restored.units[0].revisions.map(revision => revision.status), ['completed', 'interrupted', 'interrupted'])
  assert.match(restored.units[0].revisions[2].message, /结果未知/)
  assert.equal(restored.units[0].final.revisionId, 'revision:1')
  assert.equal(restored.units[0].revisions[1].updatedAt, at)
  assert.ok(restored.events.filter(event => event.type === 'operation.restored').every(event => event.at === later))
  assert.equal(restoreTranslationHistory(restored), restored)
  assert.ok(decodeTranslationHistory(restored))
})

test('旧schema2/3正文与人工稿无损读取，空记录仍保存schema3', async () => {
  for (const version of [2, 3]) {
    const storage = enabled(), session = { ...newSession(DEFAULT_SESSION_SETTINGS, 'owner', `old:${version}`), input: '合成旧草稿', legacyManualText: '合成旧人工稿' }
    if (version === 2) {
      for (const field of ['topicId', 'sequenceNamespaceId', 'topicName', 'sequence', 'remark', 'legacyName']) delete session[field]
      session.schemaVersion = 2
    }
    storage.setItem(historyKey(session.id), JSON.stringify({ schemaVersion: version, token: 'synthetic', session }))
    const store = makeStore(storage)
    assert.equal(store.getSession(session.id).input, '合成旧草稿')
    assert.equal(store.getSession(session.id).legacyManualText, '合成旧人工稿')
    assert.deepEqual(store.getTranslationHistory(session.id), emptyTranslationHistory())
    assert.equal(store.updateSession(session.id, { input: '合成新草稿' }), true); await settle()
    assert.equal(JSON.parse(storage.getItem(historyKey(session.id))).schemaVersion, 3)
  }
})
test('翻译记录与草稿共用一个历史快照，重启恢复不写入或重放任何请求', async () => {
  const storage = enabled(), store = makeStore(storage), session = await store.createSessionAsync('owner')
  assert.equal(JSON.parse(storage.getItem(historyKey(session.id))).schemaVersion, 3)
  assert.equal(await update(store, session.id, () => initial()), true)
  store.updateSession(session.id, { input: '合成下一段草稿' }); await settle()
  const snapshot = JSON.parse(storage.getItem(historyKey(session.id)))
  assert.equal(snapshot.schemaVersion, 4)
  assert.equal(snapshot.session.input, '合成下一段草稿')
  assert.equal(snapshot.translationHistory.units[0].source, '合成原文:unit:1')
  const keys = [...storage.values.keys()], before = storage.getItem(historyKey(session.id))
  const restarted = makeStore(storage)
  assert.deepEqual(restarted.getTranslationHistory(session.id), store.getTranslationHistory(session.id))
  assert.equal(storage.getItem(historyKey(session.id)), before)
  assert.deepEqual([...storage.values.keys()], keys)
})
test('关闭后保留已保存翻译，临时修订重启丢弃而模型偏好独立保留；重新开启保存现存记录', async () => {
  const storage = enabled(), store = makeStore(storage), session = await store.createSessionAsync('owner')
  await update(store, session.id, () => initial())
  const saved = storage.getItem(historyKey(session.id))
  await patch(store, { rememberHistory: false })
  await update(store, session.id, history => appendTextRevision(history, 'unit:1', revision('revision:2')))
  store.updateSession(session.id, { model: { ...model, reasoningEffort: 'low' } }); await settle()
  assert.equal(storage.getItem(historyKey(session.id)), saved)
  const restarted = makeStore(storage)
  assert.equal(restarted.getTranslationHistory(session.id).units[0].revisions.length, 1)
  assert.equal(restarted.getSession(session.id).model.reasoningEffort, 'low')
  await patch(store, { rememberHistory: true })
  assert.equal(makeStore(storage).getTranslationHistory(session.id).units[0].revisions.length, 2)
})
test('其他窗口关闭保存或等待锁期间关闭时，记录只留本窗口', async () => {
  const storage = enabled(), first = makeStore(storage), session = await first.createSessionAsync('owner'), second = makeStore(storage)
  const before = storage.getItem(historyKey(session.id))
  await patch(second, { rememberHistory: false })
  await update(first, session.id, () => initial())
  assert.equal(storage.getItem(historyKey(session.id)), before)
  assert.equal(first.getTranslationHistory(session.id).units.length, 1)
  await patch(first, { rememberHistory: true })
  const saved = storage.getItem(historyKey(session.id)), release = storage.locks.block()
  first.updateTranslationHistory(session.id, history => appendTextRevision(history, 'unit:1', revision('revision:2')))
  storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: false }))
  await release(); await settle()
  assert.equal(storage.getItem(historyKey(session.id)), saved)
})
test('损坏历史与凭据字段原副本保留，更新错误不修改当前材料', async () => {
  const storage = enabled(), store = makeStore(storage), session = await store.createSessionAsync('owner')
  await update(store, session.id, () => initial())
  const before = clone(store.getTranslationHistory(session.id))
  assert.equal(store.updateTranslationHistory(session.id, history => { history.units[0].source = ''; return history }), false)
  assert.deepEqual(store.getTranslationHistory(session.id), before)
  const snapshot = JSON.parse(storage.getItem(historyKey(session.id)))
  snapshot.translationHistory.units[0].revisions[0].sessionKey = 'synthetic-capability'
  const corrupt = JSON.stringify(snapshot); storage.setItem(historyKey(session.id), corrupt)
  const restarted = makeStore(storage)
  assert.equal(restarted.getSession(session.id), undefined)
  assert.equal(restarted.getUnreadableHistory().length, 1)
  assert.equal(storage.getItem(historyKey(session.id)), corrupt)
})
test('配额失败保留翻译记录；两窗口冲突拒绝覆盖，明确覆盖与重载包含全部历史', async () => {
  const storage = enabled(), first = makeStore(storage), session = await first.createSessionAsync('owner')
  await update(first, session.id, () => initial())
  const second = makeStore(storage)
  await update(first, session.id, history => appendTextRevision(history, 'unit:1', revision('revision:2')))
  await update(second, session.id, history => appendTextRevision(history, 'unit:1', revision('revision:3')))
  assert.equal(second.getStatus(session.id), 'conflict')
  assert.equal(second.getTranslationHistory(session.id).units[0].revisions.at(-1).id, 'revision:3')
  assert.equal(second.reloadSession(session.id), true)
  assert.equal(second.getTranslationHistory(session.id).units[0].revisions.at(-1).id, 'revision:2')
  await update(second, session.id, history => appendTextRevision(history, 'unit:1', revision('revision:3')))
  assert.equal(await first.overwriteSessionAsync(session.id), true)
  assert.equal(makeStore(storage).getTranslationHistory(session.id).units[0].revisions.at(-1).id, 'revision:2')
  storage.failSet = true
  assert.equal(await update(first, session.id, history => appendTextRevision(history, 'unit:1', revision('revision:4'))), true)
  assert.equal(first.getStatus(session.id), 'error')
  assert.equal(first.getTranslationHistory(session.id).units[0].revisions.at(-1).id, 'revision:4')
})
test('实时存储通知同步新版本；本窗口未保存翻译遇到通知保留并提示冲突', async () => {
  const storage = enabled(), first = makeStore(storage), session = await first.createSessionAsync('owner'), bus = events(), second = makeStore(storage, bus.listen)
  await update(first, session.id, () => initial()); bus.send(historyKey(session.id))
  assert.equal(second.getTranslationHistory(session.id).units[0].revisions[0].status, 'completed')
  await update(first, session.id, history => appendTextRevision(history, 'unit:1', revision('revision:2', { status: 'running', text: '' })))
  bus.send(historyKey(session.id))
  assert.equal(second.getTranslationHistory(session.id).units[0].revisions[1].status, 'running')
  await patch(second, { rememberHistory: false })
  await update(second, session.id, history => appendTextRevision(history, 'unit:1', revision('revision:3')))
  await patch(first, { rememberHistory: true })
  await update(first, session.id, history => updateTextRevision(history, 'unit:1', 'revision:2', { status: 'completed', text: '合成完成', updatedAt: later }))
  bus.send(historyKey(session.id))
  assert.equal(second.getStatus(session.id), 'conflict')
  assert.equal(second.getTranslationHistory(session.id).units[0].revisions.at(-1).id, 'revision:3')
})
test('删除确认冻结翻译变更；确认后清除正文及专属模型偏好，迟到回执不可复活', async () => {
  const storage = enabled(), store = makeStore(storage), session = await store.createSessionAsync('owner')
  await update(store, session.id, () => initial())
  store.updateSession(session.id, { model }); await settle()
  const frozen = store.captureHistoryVersions([session.id])
  await patch(store, { rememberHistory: false })
  await update(store, session.id, history => appendTextRevision(history, 'unit:1', revision('revision:2')))
  assert.equal(await store.deleteHistoryAsync([session.id], false, [], frozen), false)
  assert.equal(await store.deleteHistoryAsync([session.id]), true)
  assert.equal(storage.getItem(historyKey(session.id)), null)
  assert.equal(storage.getItem(sessionModelKey(session.id)), null)
  assert.ok(storage.getItem(ownerModelKey('owner')))
  assert.ok(storage.getItem(deletedSessionKey(session.id)))
  assert.equal(store.updateTranslationHistory(session.id, () => initial()), false)
  assert.equal(makeStore(storage).getSession(session.id), undefined)
})
test('外部删除屏障拒绝尚存窗口的新记录与明确覆盖', async () => {
  const storage = enabled(), first = makeStore(storage), session = await first.createSessionAsync('owner')
  await update(first, session.id, () => initial())
  const second = makeStore(storage)
  assert.equal(await first.deleteHistoryAsync([session.id]), true)
  assert.equal(second.updateTranslationHistory(session.id, history => appendTextRevision(history, 'unit:1', revision('revision:2'))), false)
  assert.equal(second.getTranslationHistory(session.id).units[0].revisions.length, 1)
  assert.equal(await second.overwriteSessionAsync(session.id), false)
  assert.equal(storage.getItem(historyKey(session.id)), null)
})
test('恢复中的running/unknown标中断，仅再次开启保存时纳入恢复事实', async () => {
  const storage = enabled(), first = makeStore(storage), session = await first.createSessionAsync('owner')
  await update(first, session.id, () => initial())
  await update(first, session.id, history => appendTextRevision(history, 'unit:1', revision('revision:2', { status: 'unknown', accepted: false, text: '' })))
  await patch(first, { rememberHistory: false })
  const before = storage.getItem(historyKey(session.id)), restarted = makeStore(storage)
  assert.equal(restarted.getTranslationHistory(session.id).units[0].revisions[1].status, 'interrupted')
  assert.equal(storage.getItem(historyKey(session.id)), before)
  await patch(restarted, { rememberHistory: true })
  assert.equal(JSON.parse(storage.getItem(historyKey(session.id))).translationHistory.units[0].revisions[1].status, 'interrupted')
})
test('锁已写入而保存promise尚未结束时的新结果仍再次保存，不遗失最终状态', async () => {
  const storage = enabled(), store = makeStore(storage), session = await store.createSessionAsync('owner')
  storage.locks.afterAction = () => {
    storage.locks.afterAction = undefined
    assert.equal(store.updateTranslationHistory(session.id, history => updateTextRevision(history, 'unit:1', 'revision:1', { status: 'completed', text: '合成最终完成', updatedAt: later })), true)
  }
  assert.equal(await update(store, session.id, () => appendTextUnit(emptyTranslationHistory(), material('unit:1'), revision('revision:1', { status: 'running', text: '' }))), true)
  await settle()
  assert.equal(store.getStatus(session.id), 'saved')
  assert.equal(JSON.parse(storage.getItem(historyKey(session.id))).translationHistory.units[0].revisions[0].status, 'completed')
  assert.equal(makeStore(storage).getTranslationHistory(session.id).units[0].revisions[0].text, '合成最终完成')
})
