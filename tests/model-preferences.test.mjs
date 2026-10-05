import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionStore } from '../dist/client/session-store.js'
import { DEFAULT_SESSION_SETTINGS, SETTINGS_KEY, historyKey } from '../dist/client/sessions.js'
import { SESSION_MODEL_PREFIX, OWNER_MODEL_PREFIX, sessionModelKey, ownerModelKey, decodeModelPreference } from '../dist/client/model-preferences.js'

class Storage {
  values = new Map()
  failSet = false
  tail = Promise.resolve()
  locks = { request: (_name, action) => {
    const operation = this.tail.then(action); this.tail = operation.catch(() => {}); return operation
  } }
  get length() { return this.values.size }
  key(i) { return [...this.values.keys()][i] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { if (this.failSet) throw new Error('synthetic quota'); this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}
const storeFor = (storage, listen) => new SessionStore(storage, listen, storage.locks)
const settle = () => new Promise(resolve => setImmediate(resolve))
async function update(store, ...args) { const result = store.updateSession(...args); await settle(); return result }
async function patch(store, ...args) { const result = await store.patchSettingsAsync(...args); await settle(); return result }
function enabled() { const storage = new Storage(); storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: true })); return storage }

test('历史关闭的临时会话只保存owner最后模型，下次新首会话沿用且不保存正文名称', async () => {
  const storage = new Storage(); const store = storeFor(storage)
  const a = await store.createSessionAsync('main-a'), b = await store.createSessionAsync('main-b')
  const routeA = { provider: 'synthetic-a', model: 'reasoner-a', reasoningEffort: 'high' }
  const routeB = { provider: 'synthetic-b', model: 'reasoner-b' }
  await store.renameSessionAsync(a.id, '不应落盘的主题名称')
  await update(store, a.id, { model: routeA, input: '不应落盘的原文', remark: '不应落盘的备注' })
  await update(store, b.id, { model: routeB })
  assert.equal(storage.getItem(sessionModelKey(a.id)), null)
  assert.equal(storage.getItem(historyKey(a.id)), null)
  assert.equal(store.getSettings().rememberHistory, false)
  for (const [key, raw] of storage.values) {
    assert.ok(key.startsWith(OWNER_MODEL_PREFIX))
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['model', 'schemaVersion'])
    assert.ok(!raw.includes('不应落盘'))
  }
  store.dispose()
  const restarted = storeFor(storage)
  assert.equal(restarted.getSession(a.id), undefined)
  assert.deepEqual((await restarted.createSessionAsync('main-a')).model, routeA)
  assert.deepEqual((await restarted.createSessionAsync('main-b')).model, routeB)
  assert.equal((await restarted.createSessionAsync('main-c')).model, null)
  restarted.dispose()
})

test('同owner会话专属模型分别恢复，父选择与显式null优先于owner最后选择', async () => {
  const storage = enabled(); const store = storeFor(storage)
  const a = await store.createSessionAsync('main-a'), b = await store.createSessionAsync('main-a')
  const routeA = { provider: 'synthetic', model: 'model-a', reasoningEffort: 'high' }
  const routeB = { provider: 'synthetic', model: 'model-b', reasoningEffort: 'low' }
  await patch(store, { rememberHistory: false })
  await update(store, a.id, { model: routeA }); await update(store, b.id, { model: routeB })
  assert.deepEqual((await store.createSessionAsync('main-a', a.id)).model, routeA)
  await update(store, a.id, { model: null }); await update(store, b.id, { model: routeB })
  assert.equal((await store.createSessionAsync('main-a', a.id)).model, null)
  assert.deepEqual((await store.createSessionAsync('main-a')).model, routeB)
  store.dispose()
  const restarted = storeFor(storage)
  assert.equal(restarted.getSession(a.id).model, null)
  assert.deepEqual(restarted.getSession(b.id).model, routeB)
  assert.equal(restarted.reloadSession(a.id), true)
  assert.equal(restarted.getSession(a.id).model, null)
  restarted.dispose()
})

test('删除会话清专属模型偏好，历史清理保留owner最后选择供新首会话', async () => {
  const storage = enabled(); const store = storeFor(storage)
  const a = await store.createSessionAsync('main-a')
  const model = { provider: 'synthetic', model: 'reasoner', reasoningEffort: 'high' }
  await update(store, a.id, { model })
  assert.ok(storage.getItem(sessionModelKey(a.id)))
  assert.equal(await store.deleteHistoryAsync([a.id]), true)
  assert.equal(storage.getItem(sessionModelKey(a.id)), null)
  assert.deepEqual(decodeModelPreference(storage.getItem(ownerModelKey('main-a'))), model)
  assert.deepEqual((await store.createSessionAsync('main-a')).model, model)
  store.dispose()
})

test('模型偏好写入失败保持runtime选择并提示，新会话不退回旧owner偏好', async () => {
  const storage = new Storage(); const store = storeFor(storage)
  const a = await store.createSessionAsync('main-a')
  const before = { provider: 'synthetic', model: 'before' }, after = { provider: 'synthetic', model: 'after', reasoningEffort: 'high' }
  await update(store, a.id, { model: before }); storage.failSet = true
  assert.equal(await update(store, a.id, { model: after }), true)
  assert.deepEqual(store.getSession(a.id).model, after)
  assert.match(store.getNotice(), /模型与推理等级偏好未完整保存/)
  assert.deepEqual((await store.createSessionAsync('main-a')).model, after)
  assert.deepEqual(decodeModelPreference(storage.getItem(ownerModelKey('main-a'))), before)
  store.dispose()
})

test('模型storage事件只更新对应会话route，不替换草稿或其他会话', async () => {
  const storage = enabled(); const source = storeFor(storage)
  const a = await source.createSessionAsync('main-a'), b = await source.createSessionAsync('main-a')
  let onChange
  const receiving = storeFor(storage, listener => { onChange = listener; return () => {} })
  await patch(source, { rememberHistory: false })
  await update(receiving, a.id, { input: '当前窗口未保存草稿' })
  const model = { provider: 'synthetic', model: 'new-route', reasoningEffort: 'high' }
  await update(source, a.id, { model }); onChange(sessionModelKey(a.id))
  assert.deepEqual(receiving.getSession(a.id).model, model)
  assert.equal(receiving.getSession(a.id).input, '当前窗口未保存草稿')
  assert.equal(receiving.getSession(b.id).model, null)
  source.dispose(); receiving.dispose()
})

test('无独立偏好时兼容旧历史模型，损坏或额外字段的偏好保留旧选择并提示', async () => {
  const storage = enabled(); const store = storeFor(storage)
  const a = await store.createSessionAsync('main-a')
  const model = { provider: 'synthetic', model: 'legacy', reasoningEffort: 'high' }
  await update(store, a.id, { model }); storage.removeItem(sessionModelKey(a.id)); store.dispose()
  let restarted = storeFor(storage)
  assert.deepEqual(restarted.getSession(a.id).model, model); restarted.dispose()
  storage.setItem(sessionModelKey(a.id), JSON.stringify({ schemaVersion: 1, model, source: 'forbidden' }))
  restarted = storeFor(storage)
  assert.deepEqual(restarted.getSession(a.id).model, model)
  assert.match(restarted.getNotice(), /模型偏好读取失败/)
  assert.equal(decodeModelPreference(JSON.stringify({ schemaVersion: 1, model: { ...model, credential: 'forbidden' } })), undefined)
  assert.ok(sessionModelKey(a.id).startsWith(SESSION_MODEL_PREFIX))
  restarted.dispose()
})
