import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionStore } from '../dist/client/session-store.js'
import { MaterialSubmissionsClient } from '../dist/client/material-submissions.js'
import { NormalTranslationClient } from '../dist/client/normal-translation.js'
import { TopicBridgeClient } from '../dist/client/topic-bridge.js'
import { TopicMemoryStore } from '../dist/client/topic-memory-store.js'
import { TopicArchiveStore } from '../dist/client/topic-archive-store.js'
import { appendAdmittedTextUnit, decodeTranslationHistory, persistedTranslationHistory } from '../dist/client/translation-history.js'
import { buildFinalTextExport } from '../dist/client/translation-export.js'
import { DEFAULT_SESSION_SETTINGS, SETTINGS_KEY, historyKey } from '../dist/client/sessions.js'
import { mount } from './quick-client-fixture.mjs'
import { memoryAssetsAddress } from '../dist/client/memory-assets-window.js'

const owner = 'synthetic-normal-main', tick = () => new Promise(resolve => setImmediate(resolve))
const transport = value => ({ ok: true, value: { ok: true, value } })
class Channel {
  incoming = []; replies = []; closed = false; wake
  push(value) { this.incoming.push(value); this.wake?.(); this.wake = undefined }
  send(value) { this.replies.push(structuredClone(value)) }
  dispose() { this.closed = true; this.wake?.() }
  async *[Symbol.asyncIterator]() { while (!this.closed) { if (this.incoming.length) yield this.incoming.shift(); else await new Promise(resolve => { this.wake = resolve }) } }
}
async function fixture(rememberHistory = false) {
  const values = new Map([[SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory })]])
  const storage = { get length() { return values.size }, key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.get(key) ?? null }, setItem(key, raw) { values.set(key, raw) }, removeItem(key) { values.delete(key) } }
  const locks = { async request(_name, action) { return await action() } }
  const store = new SessionStore(storage, undefined, locks), session = rememberHistory ? await store.createSessionAsync(owner) : store.createSession(owner)
  store.updateSession(session.id, { mode: 'normal', input: 'Frozen A', targetLanguage: '中文', instruction: 'Keep symbols', model: { provider: 'synthetic', model: 'translator' } })
  const terms = new TopicMemoryStore(store, storage, undefined, locks), archive = new TopicArchiveStore(store, (sessionId, unitId) => terms.readEvidence(sessionId, unitId), storage, undefined, locks)
  const channel = new Channel(), channels = new Map([[owner, channel]]), topics = new TopicBridgeClient({ async capabilities() { return { ok: true, value: { ready: true } } },
    connect(identity) { const selected = channels.get(identity.ownerId) ?? new Channel(); channels.set(identity.ownerId, selected); selected.push({ kind: 'ready', ...identity }); return selected } }, store, terms, archive)
  let contribution, frozen
  const receipt = (envelope, stage) => { const { ownerId, mainSessionId, requestId, operationId, kind } = envelope; return { ownerId, mainSessionId, requestId, operationId, kind, stage } }
  const materials = new MaterialSubmissionsClient({ store, topics, owner: 'synthetic-root', registry: { register(_owner, value) { contribution = value; return () => {} } }, remote: {
    async capabilities() { return transport({ ready: true, directSubmit: true, storage: 'runtime_only' }) },
    async prepare(envelope) { frozen = structuredClone(envelope); return transport(receipt(envelope, 'prepared')) },
    async finish(request) { return transport(receipt(frozen, request.outcome === 'submitted' ? 'submitted' : 'released')) },
  } })
  const normal = new NormalTranslationClient(store, materials, terms, ownerId => topics.retain(ownerId)); topics.setNormalTranslation(normal)
  await materials.load(); await tick()
  let sequence = 0
  async function submit(target = session) {
    const lease = contribution.freeze({ sessionId: target.ownerId, requestId: `main-submission:${++sequence}`, mode: 'queue', timestamp: 0, draftRev: 1 })
    await lease.prepare(new AbortController().signal); lease.finish('accepted'); await tick(); return structuredClone(frozen)
  }
  async function request(command) {
    const before = channel.replies.length
    channel.push({ kind: 'request', requestId: `bridge-request:${++sequence}`, mainSessionId: owner, callId: `tool:${sequence}`, command })
    for (let i = 0; i < 40 && channel.replies.length === before; i++) await tick()
    assert.equal(channel.replies.length, before + 1); return channel.replies.at(-1)
  }
  const acceptance = envelope => ({ envelope, operationId: 'business-operation:1', organizedRequirements: 'Preserve punctuation', termReferences: [] })
  return { store, session, topics, terms, archive, materials, normal, storage, submit, request, acceptance,
    async close() { normal.dispose(); materials.dispose(); await topics.dispose(); archive.dispose(); terms.dispose(); store.dispose() } }
}

test('材料发送仅供讨论；业务短ACK建立零调用单元，消费A并自动授权原文读取', async t => {
  const f = await fixture(); t.after(() => f.close())
  const envelope = await f.submit()
  assert.equal(f.store.getTranslationHistory(f.session.id).units.length, 0); assert.equal(f.store.getSession(f.session.id).input, 'Frozen A')
  const accepted = await f.request({ kind: 'normal_accept', ...f.acceptance(envelope) })
  assert.equal(accepted.ok, true); assert.equal(accepted.value.operation.status, 'accepted'); assert.deepEqual(accepted.value.termSnapshot.entries, [])
  const unit = f.store.getTranslationHistory(f.session.id).units[0]
  assert.equal(unit.sourceVersion, 1); assert.equal(unit.source, 'Frozen A'); assert.deepEqual(unit.revisions, []); assert.equal(unit.final, null)
  assert.equal(f.store.getSession(f.session.id).input, '')
  const read = await f.request({ kind: 'read_unit', translationSessionId: f.session.id, unitId: unit.id })
  assert.equal(read.ok, true); assert.equal(read.value.unit.source, 'Frozen A')
  assert.equal(f.terms.readEvidence(f.session.id, unit.id).source, 'Frozen A')
  assert.equal(buildFinalTextExport(f.store.getSession(f.session.id), f.store.getTranslationHistory(f.session.id), new Date().toISOString()).complete, false)
})

test('业务重复operation复用ACK；不同内容冲突及同会话新操作不新增单元', async t => {
  const f = await fixture(); t.after(() => f.close())
  const envelope = await f.submit(), command = { kind: 'normal_accept', ...f.acceptance(envelope) }
  const first = await f.request(command), count = f.store.getTranslationHistory(f.session.id).events.length
  assert.deepEqual((await f.request(command)).value, first.value); assert.equal(f.store.getTranslationHistory(f.session.id).events.length, count)
  assert.equal((await f.request({ ...command, organizedRequirements: 'Changed' })).error.code, 'idempotency_conflict')
  assert.equal((await f.request({ ...command, operationId: 'another-operation' })).error.code, 'busy')
  assert.equal(f.store.getTranslationHistory(f.session.id).units.length, 1)
})

test('同operationId按所属主会话隔离，两个主会话各自受理和去重', async t => {
  const f = await fixture(); t.after(() => f.close())
  const first = f.acceptance(await f.submit())
  const other = f.store.createSession('synthetic-other-main')
  f.store.updateSession(other.id, { mode: 'normal', input: 'Other source', model: { provider: 'synthetic', model: 'translator' } }); await tick()
  const second = f.acceptance(await f.submit(other))
  assert.equal(first.operationId, second.operationId)
  const a = f.normal.accept(owner, first), b = f.normal.accept(other.ownerId, second)
  assert.equal(a.ok, true); assert.equal(b.ok, true); assert.notEqual(a.value.operation.unitId, b.value.operation.unitId)
  assert.equal(f.store.getTranslationHistory(f.session.id).units.length, 1); assert.equal(f.store.getTranslationHistory(other.id).units.length, 1)
  assert.deepEqual(f.normal.accept(owner, first), a); assert.deepEqual(f.normal.accept(other.ownerId, second), b)
  assert.equal(f.normal.accept(owner, { ...first, organizedRequirements: 'Changed same-owner request' }).error.code, 'idempotency_conflict')
})

for (const edit of ['B', 'undo']) test(`冻结A后${edit}与切换不会清当前草稿`, async t => {
  const f = await fixture(); t.after(() => f.close())
  const envelope = await f.submit()
  f.store.updateSession(f.session.id, { input: 'Edited B' })
  if (edit === 'undo') f.store.updateSession(f.session.id, { input: 'Frozen A' })
  const other = f.store.createSession(owner); f.store.updateSession(other.id, { mode: 'normal', input: 'Other draft' })
  assert.equal((await f.request({ kind: 'normal_accept', ...f.acceptance(envelope) })).ok, true)
  assert.equal(f.store.getSession(f.session.id).input, edit === 'undo' ? 'Frozen A' : 'Edited B'); assert.equal(f.store.getSession(other.id).input, 'Other draft')
  assert.equal(f.store.getTranslationHistory(other.id).units.length, 0)
})

test('归属、快照、模型及术语版本拒绝均不消费原文', async t => {
  const f = await fixture(); t.after(() => f.close())
  const envelope = await f.submit(), base = f.acceptance(envelope)
  assert.equal(f.normal.accept('other-main', base).error.code, 'out_of_scope')
  const altered = structuredClone(base); altered.envelope.material.sourceText = 'Host replacement'
  assert.equal(f.normal.accept(owner, altered).error.code, 'material_not_submitted')
  assert.equal(f.normal.accept(owner, { ...base, termReferences: [{ id: 'missing-term', entryVersion: 1 }] }).error.code, 'stale_terms')
  f.store.updateSession(f.session.id, { model: null })
  const noModel = await f.submit()
  assert.equal(f.normal.accept(owner, f.acceptance(noModel)).error.code, 'invalid_input')
  assert.equal(f.store.getTranslationHistory(f.session.id).units.length, 0); assert.equal(f.store.getSession(f.session.id).input, 'Frozen A')
})

test('history3仅持久保存版本原文，关闭历史不落正文；重载零revision不创建调用', async t => {
  const f = await fixture(true); t.after(() => f.close())
  const envelope = await f.submit(); assert.equal(f.normal.accept(owner, f.acceptance(envelope)).ok, true); await tick()
  const raw = f.storage.getItem(historyKey(f.session.id)), saved = JSON.parse(raw)
  assert.equal(saved.schemaVersion, 6); assert.equal(saved.translationHistory.schemaVersion, 3)
  assert.equal(saved.translationHistory.units[0].source, undefined); assert.equal(saved.translationHistory.units[0].sourceVersions[0].text, 'Frozen A')
  assert.equal(decodeTranslationHistory(saved.translationHistory).units[0].source, 'Frozen A')
  const restarted = new SessionStore(f.storage, undefined, { async request(_name, action) { return action() } }); t.after(() => restarted.dispose())
  assert.deepEqual(restarted.getTranslationHistory(f.session.id).units[0].revisions, []); assert.equal(f.storage.getItem(historyKey(f.session.id)), raw)
  const body = persistedTranslationHistory(f.store.getTranslationHistory(f.session.id)); body.units[0].source = 'Conflicting projection'
  assert.equal(decodeTranslationHistory(body), undefined)
  await f.store.patchSettingsAsync({ rememberHistory: false }); f.store.updateSession(f.session.id, { input: 'Runtime only B' }); await tick()
  assert.equal(f.storage.getItem(historyKey(f.session.id)), raw)
})

test('生产bundle零revision受理单元可读原文，连续记录与导出明确缺译文', async t => {
  const app = mount({ settings: { ...DEFAULT_SESSION_SETTINGS, defaultMode: 'normal' } }); t.after(() => app.dispose())
  const ui = app.renderer; ui.render(app.panel, { sessionId: owner }); await ui.flush()
  const session = app.store.getActiveSession(owner), envelope = { ownerId: owner, mainSessionId: owner, requestId: 'synthetic-ui-submission', operationId: 'submission-operation', kind: 'material', material: {
    materialId: 'synthetic-ui-material', sourceVersion: 1, topicId: session.topicId, translationSessionId: session.id, draftVersion: 1,
    sourceText: 'Synthetic admitted source', targetLanguage: '中文', instruction: '', model: { provider: 'synthetic', model: 'translator' }, maxInputChars: 20000 } }
  assert.equal(app.store.updateTranslationHistory(session.id, history => appendAdmittedTextUnit(history, envelope, 'business-operation', new Date().toISOString())), true)
  ui.render(); assert.match(ui.text(), /Synthetic admitted source/); assert.match(ui.text(), /材料已受理，等待翻译执行/)
  app.resourceHost.restoreResource(owner, memoryAssetsAddress(owner, session.topicId), { topicId: session.topicId, sessionId: session.id }); await ui.flush(); await ui.click('译文记录')
  assert.match(ui.text(), /Synthetic admitted source/); assert.match(ui.text(), /尚无最终译文/)
  await ui.click('导出 TXT'); assert.equal(ui.button('仅导出已定稿').props.disabled, true); assert.equal(app.downloads.length, 0)
})
