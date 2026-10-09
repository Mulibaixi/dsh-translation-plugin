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
import { reconstructNormalTranslationContext } from '../dist/shared/translation-call.js'
import { buildFullRecordExport } from '../dist/client/translation-export.js'

const owner = 'synthetic-normal-main', tick = () => new Promise(resolve => setImmediate(resolve))
const transport = value => ({ ok: true, value: { ok: true, value } })
class Channel {
  incoming = []; replies = []; closed = false; wake
  push(value) { this.incoming.push(value); this.wake?.(); this.wake = undefined }
  send(value) { this.replies.push(structuredClone(value)) }
  dispose() { this.closed = true; this.wake?.() }
  async *[Symbol.asyncIterator]() { while (!this.closed) { if (this.incoming.length) yield this.incoming.shift(); else await new Promise(resolve => { this.wake = resolve }) } }
}
async function fixture(rememberHistory = false, options = {}) {
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
  const normal = new NormalTranslationClient(store, materials, terms, ownerId => topics.retain(ownerId), options); topics.setNormalTranslation(normal)
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
  return { store, session, topics, terms, archive, materials, normal, storage, channel, submit, request, acceptance,
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

function metadata(request) { const route = request.envelope.material.model; return { promptVersion: 'normal-text-v1',
  model: { ...route, reasoningEffort: route.reasoningEffort ?? null }, configVersion: null, maxOutputTokens: 400,
  usage: { inputTokens: null, outputTokens: null }, context: { organizedRequirements: request.organizedRequirements, terms: [] } } }
function frame(operation, sequence, edits = {}) { return { mainSessionId: operation.mainSessionId, translationSessionId: operation.translationSessionId,
  unitId: operation.unitId, operationId: operation.operationId, sourceVersion: operation.sourceVersion, callId: 'ordinary-call:1', sequence,
  status: 'running', textDelta: '', metadata: null, error: null, ...edits } }
async function admitted(f) { const request = f.acceptance(await f.submit()), result = f.normal.accept(owner, request); assert.equal(result.ok, true); return { request, operation: result.value.operation } }

test('未指定effort保存SDK实际high默认；显式effort仍精确校验，已开始调用等级不可改写', async t => {
  const f = await fixture(); t.after(() => f.close()); const { request, operation } = await admitted(f)
  const actual = { ...metadata(request), model: { ...metadata(request).model, reasoningEffort: 'high' } }
  assert.equal(f.normal.update(owner, frame(operation, 1, { metadata: actual })).ok, true)
  assert.equal(f.store.getTranslationHistory(f.session.id).units[0].revisions[0].callRecord.model.reasoningEffort, 'high')
  assert.equal(f.normal.update(owner, frame(operation, 2, { metadata: { ...actual, model: { ...actual.model, reasoningEffort: 'low' } } })).error.code, 'invalid_metadata')
  const explicit = await fixture(); t.after(() => explicit.close())
  explicit.store.updateSession(explicit.session.id, { model: { provider: 'synthetic', model: 'translator', reasoningEffort: 'low' } })
  const admittedExplicit = await admitted(explicit)
  assert.equal(explicit.normal.update(owner, frame(admittedExplicit.operation, 1, { metadata: { ...metadata(admittedExplicit.request), model: actual.model } })).error.code, 'invalid_metadata')
})

test('普通prepare仅核对冻结包；真正受理后真实callId开始才追加修订', async t => {
  const f = await fixture(); t.after(() => f.close()); const request = f.acceptance(await f.submit())
  assert.equal((await f.request({ kind: 'normal_prepare', ...request })).value.kind, 'normal_prepared')
  assert.equal(f.store.getTranslationHistory(f.session.id).units.length, 0); assert.equal(f.store.getSession(f.session.id).input, 'Frozen A')
  const operation = f.normal.accept(owner, request).value.operation
  assert.equal(f.normal.update(owner, frame(operation, 1)).error.code, 'invalid_metadata')
  assert.equal(f.store.getTranslationHistory(f.session.id).units[0].revisions.length, 0)
  const started = frame(operation, 1, { metadata: metadata(request) })
  assert.equal((await f.request({ kind: 'normal_update', ...started })).ok, true)
  const revision = f.store.getTranslationHistory(f.session.id).units[0].revisions[0]
  assert.equal(revision.id, 'ordinary-call:1'); assert.equal(revision.operationId, request.operationId); assert.notEqual(revision.id, revision.operationId)
  assert.deepEqual(revision.callRecord.context, metadata(request).context); assert.equal(revision.status, 'running')
})

test('普通流式/completed始终落冻结A会话；B、切换和模型语言编辑不改变调用事实', async t => {
  const f = await fixture(true); t.after(() => f.close()); const { request, operation } = await admitted(f)
  assert.equal(f.normal.update(owner, frame(operation, 1, { metadata: metadata(request) })).ok, true)
  f.store.updateSession(f.session.id, { input: 'New draft B', targetLanguage: '日本語', model: { provider: 'later', model: 'another' } })
  const other = await f.store.createSessionAsync(owner); f.store.updateSession(other.id, { input: 'Other draft' })
  const part = frame(operation, 2, { textDelta: '合成' }); assert.equal(f.normal.update(owner, part).ok, true)
  const before = f.store.getTranslationHistory(f.session.id).events.length
  assert.equal(f.normal.update(owner, part).ok, true); assert.equal(f.store.getTranslationHistory(f.session.id).events.length, before)
  assert.equal(f.normal.update(owner, { ...part, textDelta: '改写' }).error.code, 'idempotency_conflict')
  const call = { ...metadata(request), usage: { inputTokens: 21, outputTokens: 5 } }
  assert.equal(f.normal.update(owner, frame(operation, 3, { status: 'completed', textDelta: '译文', metadata: call })).ok, true)
  const history = f.store.getTranslationHistory(f.session.id), unit = history.units[0], revision = unit.revisions[0]
  assert.equal(unit.source, 'Frozen A'); assert.equal(unit.targetLanguage, '中文'); assert.equal(revision.text, '合成译文'); assert.equal(revision.status, 'completed')
  assert.deepEqual(revision.callRecord, call); assert.equal(f.store.getSession(f.session.id).input, 'New draft B'); assert.equal(f.store.getSession(other.id).input, 'Other draft')
  assert.equal(f.store.getTranslationHistory(other.id).units.length, 0); assert.equal(f.normal.isBusy(f.session.id), false)
  assert.equal(f.normal.update(owner, frame(operation, 4, { textDelta: 'late' })).error.code, 'invalid_state')
  assert.equal(f.normal.update('another-owner', frame(operation, 4)).error.code, 'operation_not_found')
  const exported = JSON.parse(buildFullRecordExport(f.store.getSession(f.session.id), history, new Date().toISOString()).content)
  assert.equal(exported.promptDefinitions[0].promptVersion, 'normal-text-v1'); assert.equal(exported.history.units[0].source, undefined)
  assert.deepEqual(JSON.parse(reconstructNormalTranslationContext(unit, call.context).userMessage), { target_language: '中文', translation_requirements: 'Keep symbols',
    main_model_requirements: 'Preserve punctuation', terminology: [], source_text: 'Frozen A' })
  await tick(); const disk = JSON.parse(f.storage.getItem(historyKey(f.session.id)))
  assert.equal(disk.schemaVersion, 7); assert.equal(disk.translationHistory.events.at(-1).normalSequence, 3)
  assert.deepEqual(decodeTranslationHistory(disk.translationHistory).units[0].revisions[0].callRecord, call)
})

for (const status of ['failed', 'cancelled']) test(`普通${status}保留partial及真实调用，终态ACK先发送再释放最后桥租约`, async t => {
  const f = await fixture(); t.after(() => f.close()); const { request, operation } = await admitted(f)
  await f.request({ kind: 'normal_update', ...frame(operation, 1, { metadata: metadata(request) }) })
  await f.request({ kind: 'normal_update', ...frame(operation, 2, { textDelta: '未完成' }) })
  const result = await f.request({ kind: 'normal_update', ...frame(operation, 3, { status, error: { code: status, message: '合成结束原因', stage: 'stream' } }) })
  assert.equal(result.ok, true); assert.equal(result.value.operation.status, status)
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(f.channel.closed, true)
  const unit = f.store.getTranslationHistory(f.session.id).units[0]
  assert.equal(unit.revisions[0].status, status); assert.equal(unit.revisions[0].text, '未完成'); assert.equal(unit.final, null)
  assert.equal(f.normal.isBusy(f.session.id), false)
})

test('accepted尚无call取消只保存有序终态业务事件，重启无虚构revision', async t => {
  const f = await fixture(true); t.after(() => f.close()); const { operation } = await admitted(f)
  const ended = frame(operation, 1, { callId: null, status: 'cancelled' })
  assert.equal((await f.request({ kind: 'normal_update', ...ended })).ok, true); await tick()
  assert.deepEqual(f.store.getTranslationHistory(f.session.id).units[0].revisions, [])
  const restarted = new SessionStore(f.storage, undefined, { async request(_name, action) { return action() } }); t.after(() => restarted.dispose())
  const normal = new NormalTranslationClient(restarted, f.materials, f.terms, () => () => {}); t.after(() => normal.dispose())
  assert.equal(normal.getUnitStatus(f.session.id, operation.unitId).status, 'cancelled'); assert.equal(normal.isBusy(f.session.id), false)
  assert.equal(restarted.getTranslationHistory(f.session.id).events.at(-1).normalSequence, 1)
})

test('乱序标未知，查询分页补取缺口和重复事件；不重复调用provider且completed不可逆', async t => {
  const calls = [], pages = []; const f = await fixture(false, { remote: { async status(request) { calls.push(request); return transport(pages.shift()) } } }); t.after(() => f.close())
  const { request, operation } = await admitted(f), started = frame(operation, 1, { metadata: metadata(request) })
  const partial = frame(operation, 2, { textDelta: '流式' }), done = frame(operation, 3, { status: 'completed', textDelta: '完成' })
  f.normal.update(owner, started); assert.equal(f.normal.update(owner, done).error.code, 'sequence_gap')
  assert.equal(f.normal.getUnitStatus(f.session.id, operation.unitId).status, 'unknown')
  pages.push({ operation: { ...operation, status: 'completed' }, callId: started.callId, status: 'completed', updates: [started, partial], lastSequence: 3, more: true, error: null },
    { operation: { ...operation, status: 'completed' }, callId: started.callId, status: 'completed', updates: [partial, done], lastSequence: 3, more: false, error: null })
  await f.normal.query(f.session.id, operation.unitId)
  assert.deepEqual(calls.map(call => call.afterSequence), [1, 2]); assert.equal(f.normal.getUnitStatus(f.session.id, operation.unitId).status, 'completed')
  assert.equal(f.store.getTranslationHistory(f.session.id).units[0].revisions[0].text, '流式完成')
  assert.equal(f.normal.update(owner, started).ok, true); assert.equal(f.normal.update(owner, frame(operation, 4, { status: 'failed' })).error.code, 'invalid_state')
})

for (const started of [false, true]) test(`重载${started ? 'partial' : 'accepted零call'}只补事实；原call不另建、原草稿不重发`, async t => {
  const f = await fixture(true); t.after(() => f.close()); const { request, operation } = await admitted(f), first = frame(operation, 1, { metadata: metadata(request) })
  if (started) { f.normal.update(owner, first); f.normal.update(owner, frame(operation, 2, { textDelta: '已有' })) }
  await tick(); const raw = f.storage.getItem(historyKey(f.session.id)), calls = []
  const restarted = new SessionStore(f.storage, undefined, { async request(_name, action) { return action() } }); t.after(() => restarted.dispose())
  const updates = started ? [frame(operation, 3, { textDelta: '补取' }), frame(operation, 4, { status: 'completed' })] : [first, frame(operation, 2, { status: 'completed', textDelta: '首次结果' })]
  const normal = new NormalTranslationClient(restarted, f.materials, f.terms, () => () => {}, { remote: { async status(query) {
    calls.push(query); return transport({ operation: { ...operation, status: 'completed' }, callId: first.callId, status: 'completed', updates, lastSequence: updates.at(-1).sequence, more: false, error: null })
  } } }); t.after(() => normal.dispose())
  assert.equal(f.storage.getItem(historyKey(f.session.id)), raw); assert.equal(normal.isBusy(f.session.id), true)
  assert.equal(normal.getUnitStatus(f.session.id, operation.unitId).status, 'unknown')
  if (started) assert.equal(restarted.getTranslationHistory(f.session.id).units[0].revisions[0].status, 'interrupted')
  else assert.deepEqual(restarted.getTranslationHistory(f.session.id).units[0].revisions, [])
  await normal.query(f.session.id, operation.unitId)
  assert.deepEqual(calls.map(query => query.afterSequence), [started ? 2 : 0])
  const unit = restarted.getTranslationHistory(f.session.id).units[0]
  assert.equal(unit.revisions.length, 1); assert.equal(unit.revisions[0].id, first.callId); assert.equal(unit.revisions[0].status, 'completed')
  assert.equal(unit.revisions[0].text, started ? '已有补取' : '首次结果'); assert.equal(normal.isBusy(f.session.id), false)
})

test('取消状态RPC只查询原operation，null终态不执行模型；服务消失保持明确未知', async t => {
  const queries = []; let operation; const f = await fixture(false, { remote: { async cancel(query) {
    queries.push(query); return transport({ operation: { ...operation, status: 'cancelled' }, callId: null, status: 'cancelled', updates: [frame(operation, 1, { callId: null, status: 'cancelled' })], lastSequence: 1, more: false, error: null })
  } } }); t.after(() => f.close()); ({ operation } = await admitted(f))
  await f.normal.cancel(f.session.id, operation.unitId); assert.equal(queries.length, 1); assert.equal(queries[0].operationId, operation.operationId)
  assert.equal(f.normal.getUnitStatus(f.session.id, operation.unitId).status, 'cancelled'); assert.deepEqual(f.store.getTranslationHistory(f.session.id).units[0].revisions, [])
  const absent = await fixture(false, { remote: { async status() { return transport({ operation: null, callId: null, status: 'unknown', updates: [], lastSequence: 0, more: false, error: { code: 'not_found', message: '服务已重启', stage: 'status' } }) } } }); t.after(() => absent.close())
  const accepted = await admitted(absent); await absent.normal.query(absent.session.id, accepted.operation.unitId)
  assert.equal(absent.normal.getUnitStatus(absent.session.id, accepted.operation.unitId).status, 'unknown'); assert.match(absent.normal.getUnitStatus(absent.session.id, accepted.operation.unitId).message, /服务已重启/)
  assert.deepEqual(absent.store.getTranslationHistory(absent.session.id).units[0].revisions, [])
})

test('normal_observe只读受理事实；ACK丢失后查询零call失败结算，不重新受理/消费/provider', async t => {
  let operation; const f = await fixture(false, { remote: { async status() { return transport({ operation: { ...operation, status: 'failed' },
    callId: null, status: 'failed', updates: [frame(operation, 1, { callId: null, status: 'failed', error: { code: 'EXECUTION_NOT_STARTED', message: '调用尚未开始', stage: 'dispatch' } })], lastSequence: 1, more: false, error: null }) } } }); t.after(() => f.close())
  const envelope = await f.submit(), input = f.acceptance(envelope), read = { kind: 'normal_observe', translationSessionId: f.session.id, operationId: input.operationId }
  assert.deepEqual((await f.request(read)).value, { kind: 'normal_observed', operation: null })
  assert.equal(f.store.getSession(f.session.id).input, 'Frozen A'); assert.equal(f.store.getTranslationHistory(f.session.id).units.length, 0)
  operation = f.normal.accept(owner, input).value.operation // Host did not receive this ACK.
  f.store.updateSession(f.session.id, { input: 'Next draft B' })
  assert.deepEqual((await f.request(read)).value.operation, operation)
  await f.normal.query(f.session.id, operation.unitId)
  assert.equal(f.normal.isBusy(f.session.id), false); assert.equal(f.normal.getUnitStatus(f.session.id, operation.unitId).status, 'failed')
  assert.equal(f.store.getTranslationHistory(f.session.id).units.length, 1); assert.deepEqual(f.store.getTranslationHistory(f.session.id).units[0].revisions, [])
  assert.equal(f.store.getSession(f.session.id).input, 'Next draft B')
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

test('history4仅持久保存版本原文，关闭历史不落正文；重载零revision不创建调用', async t => {
  const f = await fixture(true); t.after(() => f.close())
  const envelope = await f.submit(); assert.equal(f.normal.accept(owner, f.acceptance(envelope)).ok, true); await tick()
  const raw = f.storage.getItem(historyKey(f.session.id)), saved = JSON.parse(raw)
  assert.equal(saved.schemaVersion, 7); assert.equal(saved.translationHistory.schemaVersion, 4)
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
  ui.render(); assert.match(ui.text(), /Synthetic admitted source/); assert.match(ui.text(), /上次普通执行已中断/)
  app.resourceHost.restoreResource(owner, memoryAssetsAddress(owner, session.topicId), { topicId: session.topicId, sessionId: session.id }); await ui.flush(); await ui.click('译文记录')
  assert.match(ui.text(), /Synthetic admitted source/); assert.match(ui.text(), /尚无最终译文/)
  await ui.click('导出 TXT'); assert.equal(ui.button('仅导出已定稿').props.disabled, true); assert.equal(app.downloads.length, 0)
})

test('生产bundle显示普通running/partial/未知查询与取消，重译保持门禁且快译无调用', async t => {
  const calls = [], app = mount({ settings: { ...DEFAULT_SESSION_SETTINGS, defaultMode: 'normal' }, quick: { submit() { throw new Error('ordinary execution must not call quick') } }, normal: {
    async status(request) { calls.push(['status', request]); return transport({ operation: null, callId: null, status: 'unknown', updates: [], lastSequence: 0, more: false, error: { code: 'not_found', message: '合成服务重启', stage: 'status' } }) },
    async cancel(request) { calls.push(['cancel', request]); return transport({ operation: { ...operation, status: 'cancelled' }, callId: 'ui-normal-call', status: 'cancelled', updates: [frame(operation, 3, { callId: 'ui-normal-call', status: 'cancelled' })], lastSequence: 3, more: false, error: null }) },
  } }); t.after(() => app.dispose())
  const ui = app.renderer; ui.render(app.panel, { sessionId: owner }); await ui.flush()
  const session = app.store.getActiveSession(owner), envelope = { ownerId: owner, mainSessionId: owner, requestId: 'ui-submit', operationId: 'ui-source', kind: 'material', material: {
    materialId: 'ui-material', sourceVersion: 1, topicId: session.topicId, translationSessionId: session.id, draftVersion: 1,
    sourceText: 'UI ordinary source', targetLanguage: '中文', instruction: '', model: { provider: 'synthetic', model: 'translator' }, maxInputChars: 20000 } }
  app.store.updateTranslationHistory(session.id, history => appendAdmittedTextUnit(history, envelope, 'ui-business', new Date().toISOString()))
  const operation = app.normal.observe(owner, { translationSessionId: session.id, operationId: 'ui-business' }).value.operation
  const request = { envelope, operationId: operation.operationId, organizedRequirements: '', termReferences: [] }
  app.normal.update(owner, frame(operation, 1, { callId: 'ui-normal-call', metadata: metadata(request) })); app.normal.update(owner, frame(operation, 2, { callId: 'ui-normal-call', textDelta: '界面流式结果' })); ui.render()
  assert.match(ui.text(), /界面流式结果/); assert.equal(ui.button('重译文本 1').props.disabled, true)
  assert.equal(ui.button('取消普通翻译').props.disabled, false)
  await ui.click('查询普通执行状态'); await ui.flush(); assert.match(ui.text(), /合成服务重启/)
  await ui.click('取消普通翻译'); await ui.flush(); assert.equal(calls[1][0], 'cancel'); assert.match(ui.text(), /已取消/)
  assert.ok(!ui.nodes().some(node => node.type === 'button' && ui.text(node) === '取消普通翻译'))
  assert.equal(app.store.getTranslationHistory(session.id).units[0].revisions.length, 1)
})
