import assert from 'node:assert/strict'
import test from 'node:test'
import { TopicArchiveStore, topicArchiveKey } from '../dist/client/topic-archive-store.js'
import { TopicMemoryStore } from '../dist/client/topic-memory-store.js'
import { SessionStore } from '../dist/client/session-store.js'
import { DEFAULT_SESSION_SETTINGS, SETTINGS_KEY, historyKey } from '../dist/client/sessions.js'
import { TOPIC_LOCK_NAME } from '../dist/client/topics.js'
import { appendTextUnit, appendSourceCorrection, appendManualRevision, selectFinalRevision } from '../dist/client/translation-history.js'

const at = '2026-10-07T00:00:00.000Z'
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)) }
class Locks {
  tail = Promise.resolve()
  names = []
  request(name, action) { assert.equal(name, TOPIC_LOCK_NAME); this.names.push(name); const next = this.tail.then(action); this.tail = next.catch(() => {}); return next }
}
class Storage {
  values = new Map()
  locks = new Locks()
  failSet
  failRemove
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, raw) { if (key === this.failSet) throw new Error('synthetic quota'); this.values.set(key, raw) }
  removeItem(key) { if (key === this.failRemove) throw new Error('synthetic remove'); this.values.delete(key) }
}
function events() { let listener; return { listen(fn) { listener = fn; return () => { listener = undefined } }, send(key) { listener?.(key) } } }
async function fixture(enabled = true, storage = new Storage(), listen) {
  if (!storage.getItem(SETTINGS_KEY)) storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: enabled }))
  const sessions = new SessionStore(storage, undefined, storage.locks), session = await sessions.createSessionAsync('synthetic-owner')
  sessions.updateTranslationHistory(session.id, history => appendTextUnit(history,
    { id: 'unit', source: 'SYNTHETIC SOURCE BODY 😀', targetLanguage: '中文', instruction: '', createdAt: at },
    { id: 'revision', operationId: 'operation', model: { provider: 'synthetic', model: 'translator' }, draftVersion: 1, createdAt: at, updatedAt: at, accepted: true, status: 'completed', text: 'SYNTHETIC FINAL BODY', message: null }))
  await settle()
  const terms = new TopicMemoryStore(sessions, storage, undefined, storage.locks)
  const archives = new TopicArchiveStore(sessions, (sessionId, unitId) => terms.readEvidence(sessionId, unitId), storage, listen, storage.locks)
  return { storage, sessions, session, terms, archives }
}
const snapshot = f => f.archives.getSnapshot(f.session.ownerId, f.session.topicId)
const query = f => f.archives.query(f.session.ownerId, f.session.topicId, { mode: 'normal', kinds: ['entity', 'fact', 'relation'], forms: ['Alice'] })
const input = (f, edits = {}) => ({ kind: 'entity', id: 'alice', expectedEntryVersion: null, name: 'Alice', aliases: [], description: 'Synthetic entity', evidence: [{ kind: 'source', sessionId: f.session.id, unitId: 'unit', revisionId: null, selectionEventId: null, range: null, role: 'basis' }], origin: 'source_checked', status: 'active', ...edits })
const put = (f, edits = {}) => f.archives.apply(f.session.ownerId, f.session.topicId, snapshot(f).version, { kind: 'put', input: input(f, edits) })
const user = (f, semantic) => f.archives.saveUserEntry(f.session.ownerId, f.session.topicId, snapshot(f).version, semantic)

test('同topic共享唯一档案，owner范围受限且证据只复用SessionStore术语resolver', async () => {
  const f = await fixture(); await put(f)
  const child = await f.sessions.createSessionAsync(f.session.ownerId, f.session.id)
  assert.equal(f.archives.getSnapshot(child.ownerId, child.topicId), snapshot(f))
  assert.throws(() => f.archives.getSnapshot('other', f.session.topicId))
  assert.throws(() => f.archives.getSnapshot(f.session.ownerId, 'unknown-topic'))
  assert.equal(f.archives.query(child.ownerId, child.topicId, { mode: 'quick', kinds: ['entity'], forms: ['Alice'] }).entries.length, 0)
  const raw = f.storage.getItem(topicArchiveKey(f.session.topicId))
  assert.equal(raw.includes('SYNTHETIC SOURCE BODY'), false); assert.equal(raw.includes('SYNTHETIC FINAL BODY'), false)
  assert.equal([...f.storage.values.keys()].filter(key => key.includes(':topic-archive:')).length, 1)
})

test('历史关闭保留旧副本，重开保存当前档案，新窗口恢复同ID/版本', async () => {
  const f = await fixture(); await put(f)
  const key = topicArchiveKey(f.session.topicId), saved = f.storage.getItem(key)
  await f.sessions.patchSettingsAsync({ rememberHistory: false })
  await put(f, { expectedEntryVersion: 1, description: 'Temporary edit' })
  assert.equal(f.storage.getItem(key), saved); assert.equal(f.archives.getStatus(f.session.ownerId, f.session.topicId), 'memory')
  await f.sessions.patchSettingsAsync({ rememberHistory: true }); await settle()
  assert.equal(JSON.parse(f.storage.getItem(key)).entries[0].description, 'Temporary edit')
  const sessions = new SessionStore(f.storage, undefined, f.storage.locks), terms = new TopicMemoryStore(sessions, f.storage, undefined, f.storage.locks)
  const archives = new TopicArchiveStore(sessions, (s, u) => terms.readEvidence(s, u), f.storage, undefined, f.storage.locks)
  assert.equal(archives.getSnapshot(f.session.ownerId, f.session.topicId).entries[0].id, 'alice')
  assert.equal(archives.getSnapshot(f.session.ownerId, f.session.topicId).entries[0].version, 2)
})

test('临时主题先仅内存，开启历史后按已有共享锁保存', async () => {
  const f = await fixture(false); await put(f)
  assert.equal(f.storage.getItem(topicArchiveKey(f.session.topicId)), null)
  await f.sessions.patchSettingsAsync({ rememberHistory: true }); await settle()
  assert.ok(f.storage.getItem(topicArchiveKey(f.session.topicId))); assert.ok(f.storage.getItem(historyKey(f.session.id)))
  assert.equal(f.archives.getStatus(f.session.ownerId, f.session.topicId), 'saved')
})

test('最终选择变化自动复核，不改档案正文；用户采用解除复核且示例失效保持生效', async () => {
  const f = await fixture()
  f.sessions.updateTranslationHistory(f.session.id, history => selectFinalRevision(history, 'unit', 'revision', at)); await settle()
  const selectionEventId = f.terms.readEvidence(f.session.id, 'unit').final.selectionEventId
  await put(f, { evidence: [...input(f).evidence, { ...input(f).evidence[0], kind: 'final', revisionId: 'revision', selectionEventId }] })
  f.sessions.updateTranslationHistory(f.session.id, history => selectFinalRevision(appendManualRevision(history, 'unit', { id: 'manual', baseRevisionId: 'revision', text: 'New synthetic final', at }), 'unit', 'manual', at))
  assert.equal(snapshot(f).entries[0].status, 'review_required'); assert.equal(snapshot(f).entries[0].description, 'Synthetic entity'); assert.equal(query(f).entries.length, 0)
  await f.archives.apply(f.session.ownerId, f.session.topicId, snapshot(f).version, { kind: 'adopt', id: 'alice', expectedEntryVersion: snapshot(f).entries[0].version })
  assert.equal(snapshot(f).entries[0].origin, 'user_explicit'); assert.match(snapshot(f).entries[0].confirmation.eventId, /^archive-adoption:/)
  assert.equal(await f.sessions.deleteHistoryAsync([f.session.id], false, [], f.sessions.captureHistoryVersions([f.session.id])), true)
  assert.equal(snapshot(f).entries[0].status, 'active'); assert.equal(query(f).entries.length, 1)
})

test('删除历史默认保留档案，失效source依据复核且历史开启时保存复核状态', async () => {
  const f = await fixture(); await put(f)
  const key = topicArchiveKey(f.session.topicId)
  assert.equal(await f.sessions.deleteHistoryAsync([f.session.id], false, [], f.sessions.captureHistoryVersions([f.session.id])), true); await settle()
  assert.ok(f.storage.getItem(key)); assert.equal(snapshot(f).entries[0].status, 'review_required')
  assert.equal(JSON.parse(f.storage.getItem(key)).entries[0].status, 'review_required')
})

test('source更正后ArchiveStore沿用同一版本resolver，旧basis失效且source2可重建', async () => {
  const f = await fixture(); assert.equal((await put(f)).status, 'updated')
  const source = input(f).evidence[0]
  f.sessions.updateTranslationHistory(f.session.id, history => appendSourceCorrection(history, 'unit', {
    operationId: 'archive-source-correction:1', expectedVersion: 1, text: 'SYNTHETIC SOURCE BODY 😀 corrected', reason: 'synthetic correction', at,
  }))
  assert.equal(snapshot(f).entries[0].status, 'review_required')
  assert.equal(query(f).entries.length, 0)

  const rebuilt = await put(f, { id: 'alice-source2', evidence: [{ ...source, sourceVersion: 2 }] })
  assert.equal(rebuilt.status, 'updated')
  assert.equal(rebuilt.entry.evidence[0].sourceVersion, 2)
  assert.deepEqual(query(f).entries.map(entry => entry.id), ['alice-source2'])
})

test('source更正不撤销独立采用的用户档案', async () => {
  const f = await fixture(); assert.equal((await put(f)).status, 'updated')
  await f.archives.apply(f.session.ownerId, f.session.topicId, snapshot(f).version, { kind: 'adopt', id: 'alice', expectedEntryVersion: 1 })
  const version = snapshot(f).version
  f.sessions.updateTranslationHistory(f.session.id, history => appendSourceCorrection(history, 'unit', {
    operationId: 'archive-user-source-correction:1', expectedVersion: 1, text: 'SYNTHETIC SOURCE BODY 😀 corrected', reason: 'synthetic correction', at,
  }))
  assert.equal(snapshot(f).version, version, 'independent adoption is not invalidated by evidence version changes')
  assert.equal(snapshot(f).entries[0].origin, 'user_explicit')
  assert.equal(query(f).entries.length, 1)
})

test('加载时恢复复核只留在内存；历史开启时明确采用才保存', async () => {
  for (const enabled of [true, false]) {
    const f = await fixture(); await put(f)
    const key = topicArchiveKey(f.session.topicId), saved = f.storage.getItem(key)
    f.storage.removeItem(historyKey(f.session.id))
    f.storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: enabled }))
    const sessions = new SessionStore(f.storage, undefined, f.storage.locks), terms = new TopicMemoryStore(sessions, f.storage, undefined, f.storage.locks)
    const archives = new TopicArchiveStore(sessions, (s, u) => terms.readEvidence(s, u), f.storage, undefined, f.storage.locks)
    assert.equal(archives.getSnapshot(f.session.ownerId, f.session.topicId).entries[0].status, 'review_required')
    assert.equal(archives.getStatus(f.session.ownerId, f.session.topicId), 'memory')
    assert.equal(f.storage.getItem(key), saved)
    await settle()
    assert.equal(f.storage.getItem(key), saved, 'reading/reconciling an old snapshot does not write it back')
    if (enabled) {
      const loaded = archives.getSnapshot(f.session.ownerId, f.session.topicId)
      assert.equal((await archives.apply(f.session.ownerId, f.session.topicId, loaded.version,
        { kind: 'adopt', id: 'alice', expectedEntryVersion: loaded.entries[0].version })).status, 'updated')
      const raw = f.storage.getItem(key), reviewed = JSON.parse(raw)
      assert.equal(reviewed.entries[0].origin, 'user_explicit'); assert.equal(archives.getStatus(f.session.ownerId, f.session.topicId), 'saved')
      const restarted = new TopicArchiveStore(sessions, (s, u) => terms.readEvidence(s, u), f.storage, undefined, f.storage.locks)
      await settle(); assert.equal(restarted.getSnapshot(f.session.ownerId, f.session.topicId).version, reviewed.version); assert.equal(f.storage.getItem(key), raw)
    }
  }
})

test('冷加载source更正后的旧basis仅内存复核且不迁移写回；明确采用后才保存', async () => {
  const f = await fixture()
  const range = { start: 0, end: 4 }, evidence = { ...input(f).evidence[0], range }
  assert.equal((await put(f, { evidence: [evidence] })).status, 'updated')
  const key = topicArchiveKey(f.session.topicId), saved = f.storage.getItem(key)
  assert.equal(JSON.parse(saved).entries[0].evidence[0].sourceVersion, undefined, 'legacy source ref stays version 1 without rewrite')

  f.archives.dispose()
  f.sessions.updateTranslationHistory(f.session.id, history => appendSourceCorrection(history, 'unit', {
    operationId: 'archive-cold-source-correction:1', expectedVersion: 1, text: 'SYNTHETIC SOURCE BODY 😀 corrected', reason: 'synthetic correction', at,
  }))
  await settle()

  const sessions = new SessionStore(f.storage, undefined, f.storage.locks)
  const terms = new TopicMemoryStore(sessions, f.storage, undefined, f.storage.locks)
  const archives = new TopicArchiveStore(sessions, (sessionId, unitId) => terms.readEvidence(sessionId, unitId), f.storage, undefined, f.storage.locks)
  const loaded = archives.getSnapshot(f.session.ownerId, f.session.topicId)
  assert.equal(loaded.entries[0].status, 'review_required', 'same range text remains present in source version 2')
  assert.equal(archives.getStatus(f.session.ownerId, f.session.topicId), 'memory')
  await settle()
  assert.equal(f.storage.getItem(key), saved, 'startup reconciliation neither rewrites status nor migrates legacy evidence')

  const adopted = await archives.apply(f.session.ownerId, f.session.topicId, loaded.version,
    { kind: 'adopt', id: 'alice', expectedEntryVersion: loaded.entries[0].version })
  assert.equal(adopted.status, 'updated')
  assert.equal(archives.getStatus(f.session.ownerId, f.session.topicId), 'saved')
  assert.equal(JSON.parse(f.storage.getItem(key)).entries[0].origin, 'user_explicit')
})

test('用户save生成稳定ID和采用事件，陈旧保存/删除保留已有内容', async () => {
  const f = await fixture(false)
  const saved = await user(f, { kind: 'entity', id: null, expectedEntryVersion: null, name: 'Alice', aliases: ['A'], description: '' })
  assert.equal(saved.entry.status, 'active'); assert.equal(saved.entry.origin, 'user_explicit'); assert.equal(saved.entry.version, 2)
  assert.match(saved.entry.id, /^archive:/); assert.match(saved.entry.confirmation.eventId, /^archive-user-save:/)
  const before = snapshot(f)
  assert.equal((await f.archives.saveUserEntry(f.session.ownerId, f.session.topicId, before.version - 1, { kind: 'entity', id: saved.entry.id, expectedEntryVersion: 2, name: 'Stale', aliases: [], description: '' })).status, 'stale')
  assert.equal(await f.archives.deleteEntryAsync(f.session.ownerId, f.session.topicId, saved.entry.id, before.version, 1), false)
  assert.equal(snapshot(f), before)
})

test('多窗口变化拒绝陈旧写入；dirty本地内容保留，reload后能继续编辑', async () => {
  const changes = events(), f = await fixture(true, new Storage(), changes.listen); await put(f)
  await f.sessions.patchSettingsAsync({ rememberHistory: false }); await put(f, { expectedEntryVersion: 1, description: 'Local temporary' })
  const key = topicArchiveKey(f.session.topicId), remote = JSON.parse(f.storage.getItem(key))
  remote.version++; remote.entries[0].version++; remote.entries[0].description = 'Remote edit'
  f.storage.setItem(key, JSON.stringify(remote)); changes.send(key)
  assert.equal(snapshot(f).entries[0].description, 'Local temporary'); assert.equal(f.archives.getStatus(f.session.ownerId, f.session.topicId), 'conflict')
  assert.equal(query(f).entries.length, 0); assert.equal((await put(f, { expectedEntryVersion: 2, description: 'Would overwrite' })).status, 'stale')
  assert.equal(f.archives.reload(f.session.ownerId, f.session.topicId), true); assert.equal(snapshot(f).entries[0].description, 'Remote edit')
  assert.equal((await put(f, { expectedEntryVersion: 2, description: 'After reload' })).status, 'updated')
})

test('明确删除实体保存关联复核，历史关闭时不顺便保存其他临时编辑', async () => {
  const f = await fixture(); await put(f)
  await user(f, { kind: 'entity', id: 'bob', expectedEntryVersion: null, name: 'Bob', aliases: [], description: 'Saved Bob' })
  await user(f, { kind: 'relation', id: 'relation', expectedEntryVersion: null, sourceEntityId: 'alice', relation: 'knows', targetEntityId: 'bob', description: 'Saved relation' })
  await f.sessions.patchSettingsAsync({ rememberHistory: false })
  await user(f, { kind: 'entity', id: 'bob', expectedEntryVersion: 2, name: 'Bob', aliases: [], description: 'Temporary Bob' })
  assert.equal(await f.archives.deleteEntryAsync(f.session.ownerId, f.session.topicId, 'alice', snapshot(f).version, 1), true)
  const saved = JSON.parse(f.storage.getItem(topicArchiveKey(f.session.topicId)))
  assert.equal(saved.entries.find(entry => entry.id === 'bob').description, 'Saved Bob')
  assert.equal(snapshot(f).entries.find(entry => entry.id === 'bob').description, 'Temporary Bob')
  assert.equal(saved.entries.find(entry => entry.id === 'relation').status, 'review_required')
  assert.equal(snapshot(f).entries.find(entry => entry.id === 'relation').status, 'review_required')
  assert.equal(saved.entries.some(entry => entry.id === 'alice'), false)
})

test('保存失败保留内存并报告error；删除失败保留当前条目', async () => {
  const f = await fixture(), key = topicArchiveKey(f.session.topicId)
  f.storage.failSet = key; assert.equal((await put(f)).status, 'save_failed')
  assert.equal(f.archives.getStatus(f.session.ownerId, f.session.topicId), 'error'); assert.equal(snapshot(f).entries.length, 1)
  f.storage.failSet = undefined; await put(f, { expectedEntryVersion: 1, description: 'Saved edit' })
  const before = snapshot(f); f.storage.failRemove = key
  assert.equal(await f.archives.deleteEntryAsync(f.session.ownerId, f.session.topicId, 'alice', before.version, 2), false)
  assert.equal(snapshot(f), before); assert.match(f.archives.getNotice(), /删除失败/)
})

test('保存失败回执保留当前版本，相同内容明确重试可落盘且不增加语义版本', async () => {
  const f = await fixture(), key = topicArchiveKey(f.session.topicId)
  f.storage.failSet = key
  const failed = await user(f, { kind: 'entity', id: null, expectedEntryVersion: null, name: 'Alice', aliases: [], description: 'Synthetic user entity' })
  assert.equal(failed.status, 'save_failed'); assert.equal(failed.snapshot, snapshot(f)); assert.equal(failed.entry.version, 2)
  assert.equal(f.storage.getItem(key), null)
  const version = failed.snapshot.version, entryVersion = failed.entry.version
  f.storage.failSet = undefined
  const retried = await f.archives.saveUserEntry(f.session.ownerId, f.session.topicId, version, { kind: 'entity', id: failed.entry.id, expectedEntryVersion: entryVersion, name: failed.entry.name, aliases: failed.entry.aliases, description: failed.entry.description })
  assert.equal(retried.status, 'unchanged'); assert.equal(retried.snapshot.version, version); assert.equal(retried.entry.version, entryVersion)
  assert.deepEqual(JSON.parse(f.storage.getItem(key)), failed.snapshot)
  assert.equal(f.archives.getStatus(f.session.ownerId, f.session.topicId), 'saved'); assert.equal(f.archives.getNotice(), undefined)
})

test('保存失败后关历史并明确保存相同内容，保留临时成功且不假定已落盘', async () => {
  const f = await fixture(), key = topicArchiveKey(f.session.topicId)
  f.storage.failSet = key
  const failed = await put(f); assert.equal(failed.status, 'save_failed')
  await f.sessions.patchSettingsAsync({ rememberHistory: false })
  const retried = await put(f, { expectedEntryVersion: failed.entry.version })
  assert.equal(retried.status, 'unchanged'); assert.equal(f.archives.getStatus(f.session.ownerId, f.session.topicId), 'memory')
  assert.equal(f.storage.getItem(key), null); assert.equal(f.archives.getNotice(), undefined)
})

test('新档案订阅与dispose按共享生命周期注销', async () => {
  const f = await fixture(false); let count = 0
  const stop = f.archives.subscribe(() => count++)
  await put(f); assert.ok(count > 0); const frozen = count
  stop(); await put(f, { expectedEntryVersion: 1, description: 'Second' }); assert.equal(count, frozen)
  f.archives.dispose(); assert.equal((await put(f, { expectedEntryVersion: 2, description: 'Disposed' })).status, 'invalid')
})
