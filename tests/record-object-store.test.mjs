import assert from 'node:assert/strict'
import test from 'node:test'
import { RecordObjectStore, recordObjectsKey, RECORD_OBJECTS_PREFIX } from '../dist/client/record-object-store.js'
import { SessionStore } from '../dist/client/session-store.js'
import { DEFAULT_SESSION_SETTINGS, SETTINGS_KEY, historyKey } from '../dist/client/sessions.js'
import { TOPIC_LOCK_NAME } from '../dist/client/topics.js'
import { appendTextUnit, appendTextRevision, appendManualRevision, updateTextRevision, selectFinalRevision } from '../dist/client/translation-history.js'

const at = '2026-10-07T00:00:00.000Z'
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)) }
const uuid = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const asset = (value = 1, edits = {}) => ({ objectId: `object-${uuid(value)}`, assetId: `asset-${uuid(value)}`, version: 1, kind: 'image', name: `synthetic-${value}.png`, bytes: 12, ...edits })
class Locks {
  tail = Promise.resolve()
  names = []
  request(name, action) { assert.equal(name, TOPIC_LOCK_NAME); this.names.push(name); const next = this.tail.then(action); this.tail = next.catch(() => {}); return next }
}
class Storage {
  values = new Map()
  locks = new Locks()
  failSet
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, raw) { if (key === this.failSet) throw new Error('synthetic quota'); this.values.set(key, raw) }
  removeItem(key) { this.values.delete(key) }
}
function events() { let listener; return { listen(fn) { listener = fn; return () => { listener = undefined } }, send(key) { listener?.(key) } } }
async function fixture(enabled = true, storage = new Storage(), listen) {
  if (!storage.getItem(SETTINGS_KEY)) storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: enabled }))
  const sessions = new SessionStore(storage, undefined, storage.locks), session = await sessions.createSessionAsync('synthetic-owner')
  sessions.updateTranslationHistory(session.id, history => appendTextUnit(history,
    { id: 'unit', source: 'SOURCE😀[图片1]', targetLanguage: '中文', instruction: '', createdAt: at },
    { id: 'revision', operationId: 'operation', model: { provider: 'synthetic', model: 'translator' }, draftVersion: 1, createdAt: at, updatedAt: at, accepted: true, status: 'completed', text: 'TARGET😀[图片1]', message: null }))
  await settle()
  const objects = new RecordObjectStore(sessions, storage, listen, storage.locks)
  return { storage, sessions, session, objects }
}
const scope = (f, edits = {}) => ({ ownerId: f.session.ownerId, topicId: f.session.topicId, sessionId: f.session.id, unitId: 'unit', side: 'source', revisionId: null, ...edits })
const snapshot = f => f.objects.getSnapshot(f.session.ownerId, f.session.topicId, f.session.id)
const input = (f, edits = {}) => ({ ...scope(f), offset: 0, asset: asset(), ...edits })
const add = (f, edits = {}, expectedVersion = snapshot(f).version) => f.objects.addReference(input(f, edits), expectedVersion)

test('session sidecar保存元数据且不改变唯一正文schema，owner/topic范围受限', async () => {
  const f = await fixture(), canonical = f.storage.getItem(historyKey(f.session.id))
  const result = await add(f)
  assert.equal(result.status, 'updated'); assert.equal(f.objects.getStatus(f.session.ownerId, f.session.topicId, f.session.id), 'saved')
  assert.equal(f.storage.getItem(historyKey(f.session.id)), canonical)
  const raw = f.storage.getItem(recordObjectsKey(f.session.id))
  assert.equal(raw.includes('SOURCE'), false); assert.equal(raw.includes('TARGET'), false); assert.equal(raw.includes('path'), false)
  assert.match(result.reference.refId, /^record-object-ref:/); assert.equal(result.reference.asset.objectId, asset().objectId)
  assert.equal(f.objects.getAvailability(result.reference), 'available')
  assert.throws(() => f.objects.getSnapshot('other', f.session.topicId, f.session.id), /scope/)
  assert.throws(() => f.objects.getSnapshot(f.session.ownerId, 'other', f.session.id), /scope/)
  assert.throws(() => f.objects.getSnapshot(f.session.ownerId, f.session.topicId, 'unknown'), /scope/)
  assert.equal([...f.storage.values.keys()].filter(key => key.startsWith(RECORD_OBJECTS_PREFIX)).length, 1)
})

test('offset按Unicode码点检查0/末尾，具体unit与revision不互相借用正文', async () => {
  const f = await fixture(), source = f.sessions.getTranslationHistory(f.session.id).units[0].source
  assert.equal((await add(f, { offset: Array.from(source).length })).status, 'updated')
  assert.equal((await add(f, { offset: Array.from(source).length + 1, asset: asset(2) })).status, 'invalid')
  assert.equal((await add(f, { unitId: 'unknown', asset: asset(2) })).status, 'invalid')
  assert.equal((await add(f, { side: 'revision', revisionId: 'unknown', asset: asset(2) })).status, 'invalid')
  assert.equal((await add(f, { revisionId: 'revision', asset: asset(2) })).status, 'invalid')
  assert.equal((await add(f, { side: 'revision', revisionId: null, asset: asset(2) })).status, 'invalid')
  assert.equal((await add(f, { offset: -1, asset: asset(2) })).status, 'invalid')
  assert.equal((await add(f, { offset: 0.5, asset: asset(2) })).status, 'invalid')
  assert.equal(snapshot(f).references.length, 1)
})

test('同unit两侧和独立结果共享固定编号，source对象不阻挡无对象target人工版本', async () => {
  const f = await fixture(), source = await add(f)
  assert.equal(f.objects.hasRevisionObjects(f.session.ownerId, f.session.topicId, f.session.id, 'unit', 'revision'), false)
  const target = await add(f, { side: 'revision', revisionId: 'revision', asset: asset(1, { assetId: `asset-${uuid(2)}`, name: 'independent-result.png' }) })
  assert.equal(target.reference.objectOrdinal, source.reference.objectOrdinal)
  assert.equal(f.objects.hasRevisionObjects(f.session.ownerId, f.session.topicId, f.session.id, 'unit', 'revision'), true)
  f.sessions.updateTranslationHistory(f.session.id, history => selectFinalRevision(appendManualRevision(history, 'unit', { id: 'manual', baseRevisionId: 'revision', text: 'MANUAL TARGET', at }), 'unit', 'manual', at))
  assert.equal(f.objects.getReferences(scope(f, { side: 'revision', revisionId: 'manual' })).length, 0)
  assert.equal(f.objects.hasRevisionObjects(f.session.ownerId, f.session.topicId, f.session.id, 'unit', 'manual'), false)
  assert.equal(f.objects.getReferences(scope(f, { side: 'revision', revisionId: 'revision' }))[0].refId, target.reference.refId)
  assert.equal(f.objects.getAvailability(target.reference), 'available'); assert.equal(snapshot(f).version, 2)
})

test('历史关闭关联仅内存，开启保存会话及sidecar，新窗口恢复ID/编号/位置', async () => {
  const f = await fixture(false), result = await add(f, { offset: 2 })
  assert.equal(result.status, 'updated'); assert.equal(f.storage.getItem(recordObjectsKey(f.session.id)), null)
  assert.equal(f.storage.getItem(historyKey(f.session.id)), null)
  assert.equal(f.objects.getStatus(f.session.ownerId, f.session.topicId, f.session.id), 'memory')
  await f.sessions.patchSettingsAsync({ rememberHistory: true }); await settle()
  assert.ok(f.storage.getItem(historyKey(f.session.id))); assert.ok(f.storage.getItem(recordObjectsKey(f.session.id)))
  const sessions = new SessionStore(f.storage, undefined, f.storage.locks), restored = new RecordObjectStore(sessions, f.storage, undefined, f.storage.locks)
  const ref = restored.getReferences(scope(f))[0]
  assert.deepEqual(ref, result.reference); assert.equal(restored.getAvailability(ref), 'available')
  assert.equal(restored.getSnapshot(f.session.ownerId, f.session.topicId, f.session.id).version, result.snapshot.version)
})

test('关闭历史不覆盖旧sidecar副本，新增引用重开时保存当前快照', async () => {
  const f = await fixture(); await add(f)
  const key = recordObjectsKey(f.session.id), saved = f.storage.getItem(key)
  await f.sessions.patchSettingsAsync({ rememberHistory: false }); await add(f, { offset: 2, asset: asset(2) })
  assert.equal(f.storage.getItem(key), saved); assert.equal(snapshot(f).references.length, 2)
  await f.sessions.patchSettingsAsync({ rememberHistory: true }); await settle()
  assert.equal(JSON.parse(f.storage.getItem(key)).references.length, 2)
  assert.ok(f.storage.locks.names.length > 0); assert.ok(f.storage.locks.names.every(name => name === TOPIC_LOCK_NAME))
})

test('保存失败明确保留当前引用，与Host登记非同一事务；同字段重试不重复编号/版本', async () => {
  const f = await fixture(), key = recordObjectsKey(f.session.id)
  f.storage.failSet = key
  const failed = await add(f)
  assert.equal(failed.status, 'save_failed'); assert.equal(failed.snapshot, snapshot(f)); assert.ok(failed.reference)
  assert.equal(f.objects.getStatus(f.session.ownerId, f.session.topicId, f.session.id), 'error'); assert.equal(f.storage.getItem(key), null)
  assert.match(f.objects.getNotice(), /资源可能已登记.*引用未保存/)
  f.storage.failSet = undefined
  const retried = await add(f, {}, failed.snapshot.version)
  assert.equal(retried.status, 'unchanged'); assert.equal(retried.reference.refId, failed.reference.refId)
  assert.equal(retried.reference.objectOrdinal, failed.reference.objectOrdinal); assert.equal(retried.snapshot.version, failed.snapshot.version)
  assert.deepEqual(JSON.parse(f.storage.getItem(key)), failed.snapshot); assert.equal(f.objects.getNotice(), undefined)
})

test('失败后关闭历史相同字段保存成为临时成功，不假定Host或sidecar事务回滚', async () => {
  const f = await fixture(), key = recordObjectsKey(f.session.id)
  f.storage.failSet = key
  const failed = await add(f)
  await f.sessions.patchSettingsAsync({ rememberHistory: false })
  const retried = await add(f, {}, failed.snapshot.version)
  assert.equal(retried.status, 'unchanged'); assert.equal(f.objects.getStatus(f.session.ownerId, f.session.topicId, f.session.id), 'memory')
  assert.equal(f.storage.getItem(key), null); assert.equal(retried.reference.refId, failed.reference.refId)
})

test('其他窗口变更自动读取clean副本，dirty冲突保留当前占位且拒绝覆盖', async () => {
  const changes = events(), f = await fixture(true, new Storage(), changes.listen); await add(f)
  const remote = new RecordObjectStore(f.sessions, f.storage, undefined, f.storage.locks)
  await remote.addReference(input(f, { offset: 2, asset: asset(2) }), 1); changes.send(recordObjectsKey(f.session.id))
  assert.equal(snapshot(f).references.length, 2); assert.equal(f.objects.getStatus(f.session.ownerId, f.session.topicId, f.session.id), 'saved')
  await f.sessions.patchSettingsAsync({ rememberHistory: false }); await add(f, { offset: 3, asset: asset(3) })
  const local = snapshot(f), key = recordObjectsKey(f.session.id), other = JSON.parse(f.storage.getItem(key))
  other.version++; other.updatedAt = '2026-10-07T01:00:00.000Z'
  f.storage.setItem(key, JSON.stringify(other)); changes.send(key)
  assert.equal(snapshot(f), local); assert.equal(f.objects.getStatus(f.session.ownerId, f.session.topicId, f.session.id), 'conflict')
  assert.equal(f.objects.getReferences(scope(f)).length, 3)
  assert.equal(f.objects.getAvailability(local.references[0]), 'storage_conflict')
  assert.equal((await add(f, { offset: 4, asset: asset(4) })).status, 'stale'); assert.equal(snapshot(f), local)
  assert.equal(f.objects.reload(f.session.ownerId, f.session.topicId, f.session.id), true)
  assert.equal(snapshot(f).references.length, 2); assert.equal((await add(f, { offset: 4, asset: asset(4) })).status, 'updated')
})

test('删除会话/历史保留sidecar且只标来源不可用，新同topic会话不继承位置', async () => {
  const f = await fixture(), result = await add(f), key = recordObjectsKey(f.session.id), raw = f.storage.getItem(key)
  const child = await f.sessions.createSessionAsync(f.session.ownerId, f.session.id)
  assert.equal(await f.sessions.deleteHistoryAsync([f.session.id], false, [], f.sessions.captureHistoryVersions([f.session.id])), true); await settle()
  assert.equal(f.storage.getItem(key), raw); assert.equal(snapshot(f), result.snapshot)
  assert.equal(f.objects.getAvailability(result.reference), 'record_unavailable')
  assert.equal(f.objects.getSnapshot(child.ownerId, child.topicId, child.id).references.length, 0)
  assert.equal((await add(f, { offset: 1, asset: asset(2) })).status, 'invalid')
  const sessions = new SessionStore(f.storage, undefined, f.storage.locks), restored = new RecordObjectStore(sessions, f.storage, undefined, f.storage.locks)
  assert.equal(restored.getSnapshot(f.session.ownerId, f.session.topicId, f.session.id).references[0].refId, result.reference.refId)
  assert.equal(restored.getAvailability(result.reference), 'record_unavailable'); assert.equal(f.storage.getItem(key), raw)
})

test('正文缩短只标位置不可用，不夹断或隐式迁移已有offset', async () => {
  const f = await fixture()
  f.sessions.updateTranslationHistory(f.session.id, history => appendTextRevision(history, 'unit',
    { id: 'failed', operationId: 'failed-operation', model: { provider: 'synthetic', model: 'translator' }, draftVersion: 2, createdAt: at, updatedAt: at, accepted: true, status: 'failed', text: 'FAILED PARTIAL TEXT', message: 'synthetic failure' }))
  const result = await add(f, { side: 'revision', revisionId: 'failed', offset: 8 }), raw = f.storage.getItem(recordObjectsKey(f.session.id))
  f.sessions.updateTranslationHistory(f.session.id, history => updateTextRevision(history, 'unit', 'failed', { text: '短', updatedAt: at }))
  assert.equal(f.objects.getAvailability(result.reference), 'position_unavailable'); assert.equal(snapshot(f).references[0].offset, 8)
  assert.equal(f.storage.getItem(recordObjectsKey(f.session.id)), raw)
})

test('相同object固定kind、asset metadata不可跨owner/topic复用，独立session不共享编号', async () => {
  const f = await fixture(); await add(f)
  const child = await f.sessions.createSessionAsync(f.session.ownerId, f.session.id)
  f.sessions.updateTranslationHistory(child.id, history => appendTextUnit(history,
    { id: 'unit', source: 'CHILD SOURCE', targetLanguage: '中文', instruction: '', createdAt: at },
    { id: 'child-revision', operationId: 'child-operation', model: { provider: 'synthetic', model: 'translator' }, draftVersion: 1, createdAt: at, updatedAt: at, accepted: true, status: 'completed', text: 'CHILD TARGET', message: null }))
  const childInput = { ...input(f), sessionId: child.id, asset: asset(1, { kind: 'table', assetId: `asset-${uuid(2)}`, name: 'synthetic.csv' }) }
  assert.equal((await f.objects.addReference(childInput, 0)).status, 'invalid')
  const sameObject = await f.objects.addReference({ ...childInput, asset: asset() }, 0)
  assert.equal(sameObject.status, 'updated'); assert.equal(sameObject.reference.objectOrdinal, 1)
  const other = await f.sessions.createSessionAsync('other-owner')
  f.sessions.updateTranslationHistory(other.id, history => appendTextUnit(history,
    { id: 'unit', source: 'OTHER SOURCE', targetLanguage: '中文', instruction: '', createdAt: at },
    { id: 'other-revision', operationId: 'other-operation', model: { provider: 'synthetic', model: 'translator' }, draftVersion: 1, createdAt: at, updatedAt: at, accepted: true, status: 'completed', text: 'OTHER TARGET', message: null }))
  assert.equal((await f.objects.addReference({ ...input(f), ownerId: other.ownerId, topicId: other.topicId, sessionId: other.id }, 0)).status, 'invalid')
})

test('订阅可注销且dispose移除SessionStore/storage监听', async () => {
  const changes = events(), f = await fixture(false, new Storage(), changes.listen); let count = 0
  const stop = f.objects.subscribe(() => count++)
  await add(f); assert.ok(count > 0)
  stop(); const frozen = count; await add(f, { offset: 1 }); assert.equal(count, frozen)
  f.objects.dispose(); changes.send(null)
  assert.equal(count, frozen)
})

test('只关联已结束的实际revision，运行中正文不冻结位置；source仍可关联', async () => {
  const f = await fixture()
  for (const status of ['running', 'submitting', 'unknown']) {
    f.sessions.updateTranslationHistory(f.session.id, history => appendTextRevision(history, 'unit',
      { id: status, operationId: `${status}-operation`, model: { provider: 'synthetic', model: 'translator' }, draftVersion: 2, createdAt: at, updatedAt: at, accepted: true, status, text: 'SYNTHETIC PARTIAL TEXT', message: null }))
    assert.equal((await add(f, { side: 'revision', revisionId: status })).status, 'invalid')
  }
  assert.equal((await add(f)).status, 'updated')
  for (const [i, status] of ['completed', 'failed', 'cancelled', 'interrupted'].entries()) {
    f.sessions.updateTranslationHistory(f.session.id, history => appendTextRevision(history, 'unit',
      { id: status, operationId: `${status}-operation`, model: { provider: 'synthetic', model: 'translator' }, draftVersion: 2, createdAt: at, updatedAt: at, accepted: true, status, text: 'SYNTHETIC ENDED TEXT', message: null }))
    assert.equal((await add(f, { side: 'revision', revisionId: status, asset: asset(i + 2) })).status, 'updated')
  }
})

test('公式只保存明确可靠source，不解析正文，history开关及恢复保留可选字段', async () => {
  const f = await fixture(false), formulaSource = String.raw`\\frac{a}{b} + x^2`
  const request = { asset: asset(1, { kind: 'formula', name: 'synthetic.tex' }), formulaSource }
  const saved = await add(f, request)
  assert.equal(saved.reference.formulaSource, formulaSource)
  assert.equal((await add(f, { ...request, formulaSource: 'other-source' })).status, 'invalid')
  assert.equal((await add(f, { asset: asset(2), formulaSource })).status, 'invalid')
  assert.equal((await add(f, { asset: asset(3, { kind: 'formula', name: 'no-source.tex' }), formulaSource: '' })).status, 'invalid')
  await f.sessions.patchSettingsAsync({ rememberHistory: true }); await settle()
  const sessions = new SessionStore(f.storage, undefined, f.storage.locks), restored = new RecordObjectStore(sessions, f.storage, undefined, f.storage.locks)
  assert.equal(restored.getReferences(scope(f))[0].formulaSource, formulaSource)
  assert.equal(restored.getReferences(scope(f))[0].refId, saved.reference.refId)
})

test('等待共享锁期间归档会话拒绝late绑定，旧引用保留可读且不改变副本', async () => {
  const f = await fixture(), saved = await add(f), key = recordObjectsKey(f.session.id), raw = f.storage.getItem(key)
  let release, started
  const gate = new Promise(resolve => { release = resolve }), entered = new Promise(resolve => { started = resolve })
  const blocker = f.storage.locks.request(TOPIC_LOCK_NAME, () => { started(); return gate })
  await entered
  const archive = f.sessions.setSessionArchivedAsync(f.session.ownerId, f.session.id, false, true)
  const lateBinding = add(f, { offset: 1, asset: asset(2) })
  assert.equal(f.sessions.getSession(f.session.id).archivedAt, null)
  release(); await blocker
  assert.equal((await archive).ok, true)
  assert.equal((await lateBinding).status, 'invalid')
  assert.equal(snapshot(f), saved.snapshot); assert.equal(f.storage.getItem(key), raw)
  assert.equal(f.objects.getReferences(scope(f))[0].refId, saved.reference.refId)
  assert.equal(f.objects.getAvailability(saved.reference), 'available')
  assert.equal((await add(f, { side: 'revision', revisionId: 'revision', asset: asset(3) })).status, 'invalid')
})
