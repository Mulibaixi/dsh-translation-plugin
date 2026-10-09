import assert from 'node:assert/strict'
import test from 'node:test'
import { createQuickHostFixture } from '../tests/quick-host-fixture.mjs'
import { QuickTranslationClient } from '../dist/client/quick-translation.js'
import { adaptQuickRemote } from '../dist/client/quick-transport.js'
import { ModelCatalog } from '../dist/client/models.js'
import { SessionStore } from '../dist/client/session-store.js'
import { DEFAULT_SESSION_SETTINGS, SETTINGS_KEY, historyKey } from '../dist/client/sessions.js'
import { buildFinalTextExport, buildFullRecordExport } from '../dist/client/translation-export.js'
import { decodeTranslationHistory, persistedTranslationHistory } from '../dist/client/translation-history.js'
import { TRANSLATION_PROMPT_VERSION, reconstructTranslationContext } from '../dist/shared/translation-call.js'

// Run after building the workspace plugin:
// node --expose-internals --test scripts/quick-client-native.integration.mjs
// Uses extracted DSH 0.2.0-rc.2 packages and an entirely synthetic profile/provider.
const runtimeRoot = process.env.DSH_RUNTIME_ROOT
if (!runtimeRoot) throw new Error('DSH_RUNTIME_ROOT is required; it must contain a complete external dsh/node_modules tree from DSH 0.2.0-rc.2')
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
class NativeStorage {
  values = new Map()
  tail = Promise.resolve()
  locks = { request: (_name, action) => { const operation = this.tail.then(action); this.tail = operation.catch(() => {}); return operation } }
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}
let fixtureSequence = 0
async function wait(predicate, label) {
  for (let count = 0; count < 200; count++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error(`Timed out: ${label}`)
}
async function fixture({ submitGate, prepareGate, storage, restoredId } = {}) {
  const host = await createQuickHostFixture({ runtimeRoot })
  if (prepareGate) host.provider.prepareGate = prepareGate.promise
  const calls = { open: [], submit: [], status: [], cancel: [], submitResults: [] }
  const remote = Object.fromEntries(['capabilities', 'open', 'submit', 'status', 'cancel'].map(method => [method, async request => {
    calls[method]?.push(structuredClone(request))
    if (method === 'submit' && submitGate) await submitGate.promise
    const response = await host.call(method, request)
    if (method === 'submit') calls.submitResults.push(response)
    return response
  }]))
  const store = new SessionStore(storage, undefined, storage?.locks); store.ensureWorkspace('synthetic-main')
  const id = restoredId ?? store.getActiveSession('synthetic-main').id
  if (!restoredId) store.updateSession(id, { input: 'Synthetic source', targetLanguage: 'English', instruction: 'Keep synthetic terms', model: { provider: 'synthetic', model: 'model-a', reasoningEffort: 'high' } })
  const models = new ModelCatalog({ async modelCatalog() { return { ok: true, value: { default: null, failures: [], groups: [{ id: 'synthetic', name: 'Synthetic', models: [{ id: 'model-a', name: 'A', reasoning: { defaultEffort: 'high', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }] }] } } } })
  await models.load()
  let sequence = 0; const run = ++fixtureSequence
  const quick = new QuickTranslationClient(adaptQuickRemote(remote), store, models, { pollMs: 5, requestTimeoutMs: 2000, makeId: () => `synthetic-native-op:${run}:${++sequence}` })
  await quick.load(); assert.equal(quick.getReadiness().status, 'ready')
  return { host, quick, store, models, calls, id, async close() { quick.dispose(); models.dispose(); store.dispose(); await host.dispose() } }
}

test('真实DSH Gateway/LLM/Session + Client：快译成功，冻结参数且未改草稿受理后清空', async () => {
  const app = await fixture()
  try {
    await app.quick.send(app.id)
    await wait(() => app.quick.getRecords(app.id)[0]?.status === 'completed', 'completed')
    const record = app.quick.getRecords(app.id)[0]
    assert.equal(record.text, '合成译文'); assert.equal(record.targetLanguage, 'English')
    assert.equal(record.instruction, 'Keep synthetic terms'); assert.equal(record.model.reasoningEffort, 'high')
    assert.equal(app.store.getSession(app.id).input, '')
    assert.equal(app.host.provider.calls.length, 1); assert.equal(app.calls.submit.length, 1)
    assert.equal(app.host.provider.calls[0].provider, 'synthetic'); assert.equal(app.host.provider.calls[0].model, 'model-a')
    assert.equal(app.host.provider.calls[0].reasoningEffort, 'high')
    assert.equal(app.host.nativeEvents, 0)
  } finally { await app.close() }
})

test('真实DSH Gateway/LLM/Session + Client：同一会话连续两轮成功，第二轮模型只收到当前原文', async () => {
  const app = await fixture()
  try {
    const firstSource = 'Synthetic first round source'; const secondSource = 'Synthetic second round source'
    app.store.updateSession(app.id, { input: firstSource })
    await app.quick.send(app.id)
    await wait(() => app.quick.getRecords(app.id)[0]?.status === 'completed', 'first round completed')
    assert.equal(app.store.getSession(app.id).input, '')
    app.store.updateSession(app.id, { input: secondSource, targetLanguage: '日本語', instruction: 'Second synthetic requirements' })
    await app.quick.send(app.id)
    await wait(() => app.quick.getRecords(app.id)[1]?.status === 'completed', 'second round completed')
    assert.equal(app.store.getSession(app.id).input, '')
    assert.equal(app.host.provider.calls.length, 2); assert.equal(app.calls.submit.length, 2); assert.equal(app.calls.open.length, 1)
    assert.notEqual(app.calls.submit[0].operationId, app.calls.submit[1].operationId)
    assert.equal(app.calls.submit[0].sessionKey, app.calls.submit[1].sessionKey)
    const records = app.quick.getRecords(app.id)
    assert.deepEqual(records.map(record => [record.id, record.source, record.targetLanguage, record.text]), [
      [app.calls.submit[0].operationId, firstSource, 'English', '合成译文'],
      [app.calls.submit[1].operationId, secondSource, '日本語', '合成译文'],
    ])
    const sent = app.host.provider.calls[1]
    assert.deepEqual(sent.messages.map(message => message.role), ['system', 'user'])
    assert.deepEqual(JSON.parse(sent.messages[1].content[0].text), {
      target_language: '日本語', translation_requirements: 'Second synthetic requirements', source_text: secondSource,
    })
    assert.ok(!JSON.stringify(sent.messages).includes(firstSource)); assert.ok(!JSON.stringify(sent.messages).includes('合成译文'))
  } finally { await app.close() }
})

test('真实DSH Gateway + Client：cancel先于submit，0tombstone确认后迟到submit不计费/不复活', async () => {
  const gate = deferred(); const app = await fixture({ submitGate: gate })
  try {
    const sending = app.quick.send(app.id)
    await wait(() => app.calls.submit.length === 1, 'submit carrier held')
    app.quick.cancel(app.id)
    await wait(() => app.quick.getRecords(app.id)[0]?.status === 'cancelled', 'cancel tombstone confirmed')
    assert.equal(app.quick.isBusy(app.id), false); assert.equal(app.store.getSession(app.id).input, 'Synthetic source')
    gate.resolve(); await sending
    assert.equal(app.host.provider.preparations, 0); assert.equal(app.host.provider.calls.length, 0)
    assert.equal(app.quick.getRecords(app.id)[0].status, 'cancelled'); assert.equal(app.quick.getRecords(app.id)[0].text, '')
    assert.equal(app.calls.submitResults[0].ok, true)
    assert.equal(app.calls.submitResults[0].value.value.draftVersion, app.calls.submit[0].draftVersion)
    assert.equal(app.calls.submitResults[0].value.value.status, 'cancelled')
  } finally { gate.resolve(); await app.close() }
})

test('真实DSH Gateway + Client：准备中查询running/未受理，取消确认后迟到prepare不得dispatch', async () => {
  const gate = deferred(); const app = await fixture({ prepareGate: gate })
  try {
    const sending = app.quick.send(app.id)
    await wait(() => app.host.provider.preparations === 1, 'preparing')
    app.quick.reset(); app.quick.query(app.quick.getRecords(app.id)[0])
    await wait(() => app.quick.getRecords(app.id)[0]?.status === 'running', 'preparation receipt')
    assert.equal(app.quick.getRecords(app.id)[0].accepted, false)
    assert.equal(app.store.getSession(app.id).input, 'Synthetic source'); assert.equal(app.quick.isBusy(app.id), true)
    app.quick.cancel(app.id)
    await wait(() => app.quick.getRecords(app.id)[0]?.status === 'cancelled', 'prepare cancellation confirmed')
    gate.resolve(); await sending
    assert.equal(app.host.provider.calls.length, 0); assert.equal(app.quick.getRecords(app.id)[0].status, 'cancelled')
  } finally { gate.resolve(); await app.close() }
})

test('真实DSH Gateway + Client：connection reset继续沿原sessionKey/opId查询，不能重新open/submit', async () => {
  const app = await fixture(); const streamGate = deferred(); app.host.provider.gate = streamGate.promise
  try {
    await app.quick.send(app.id)
    await wait(() => app.host.provider.calls.length === 1, 'provider dispatched')
    app.quick.reset(); await app.quick.load(); await app.quick.send(app.id)
    assert.equal(app.quick.getRecords(app.id)[0].status, 'unknown'); assert.equal(app.calls.open.length, 1); assert.equal(app.calls.submit.length, 1)
    app.store.updateSession(app.id, { input: 'New synthetic draft' })
    app.quick.query(app.quick.getRecords(app.id)[0]); await tick()
    streamGate.resolve()
    await wait(() => app.quick.getRecords(app.id)[0]?.status === 'completed', 'reset queried completion')
    assert.equal(app.store.getSession(app.id).input, 'New synthetic draft')
    assert.equal(app.calls.open.length, 1); assert.equal(app.calls.submit.length, 1); assert.equal(app.host.provider.calls.length, 1)
    assert.ok(app.calls.status.every(request => request.sessionKey === app.calls.submit[0].sessionKey && request.operationId === app.calls.submit[0].operationId))
  } finally { streamGate.resolve(); await app.close() }
})
test('真实DSH同单元targeted revision与重启新调用：保留用户unit/final，仅向模型发送冻结本单元材料', async () => {
  const storage = new NativeStorage()
  storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: true }))
  const first = await fixture({ storage })
  const admitted = [], received = []
  const receive = first.host.service.runtime.receive.bind(first.host.service.runtime), accept = first.host.service.runtime.accept.bind(first.host.service.runtime)
  first.host.service.runtime.receive = request => { received.push(structuredClone(request)); return receive(request) }
  first.host.service.runtime.accept = request => { const result = accept(request); if (result.ok) admitted.push(result.value); return result }
  let userUnit, localSessionId, oldFinal
  try {
    await first.quick.send(first.id)
    await wait(() => first.quick.getRecords(first.id)[0]?.status === 'completed', 'initial unit completed')
    userUnit = first.quick.getUnits(first.id)[0]; localSessionId = first.id
    first.store.updateSession(first.id, { input: 'Synthetic untouched next draft', targetLanguage: '日本語', instruction: 'Unsubmitted new requirements', model: { provider: 'synthetic', model: 'model-a', reasoningEffort: 'low' } })
    await first.quick.retranslate(first.id, userUnit.id)
    await wait(() => first.quick.getRecords(first.id)[1]?.status === 'completed', 'targeted revision completed')
    assert.equal(received[1].trigger, 'explicit_revision'); assert.equal(received[1].target.unit_id, admitted[0].unit_id)
    assert.equal(admitted[1].unit_id, admitted[0].unit_id); assert.equal(admitted[1].candidate_order, 2)
    assert.equal(first.quick.getUnits(first.id).length, 1); assert.equal(first.quick.getUnits(first.id)[0].revisions.length, 2)
    assert.equal(first.store.getSession(first.id).input, 'Synthetic untouched next draft')
    assert.equal(first.host.provider.calls[1].reasoningEffort, 'low')
    assert.equal(first.quick.selectFinal(first.id, userUnit.id, userUnit.revisions[0].id), true)
    oldFinal = first.quick.getUnits(first.id)[0].final
    assert.equal(first.host.provider.calls.length, 2)
    assert.deepEqual(first.host.provider.calls[1].messages.map(message => message.role), ['system', 'user'])
    assert.deepEqual(JSON.parse(first.host.provider.calls[1].messages[1].content[0].text), { target_language: userUnit.targetLanguage, translation_requirements: userUnit.instruction, source_text: userUnit.source })
    assert.ok(!JSON.stringify(first.host.provider.calls[1].messages).includes('合成译文'))
    const snapshot = first.host.service.runtime.getSnapshot({ translation_session_id: received[0].translation_session_id })
    assert.equal(snapshot.value.units[0].final_pointer, null, 'Host execution has no second user final authority')
    await tick()
  } finally { await first.close() }
  const restarted = await fixture({ storage, restoredId: localSessionId })
  const resumedMaterial = [], resumedReceipts = []
  const secondReceive = restarted.host.service.runtime.receive.bind(restarted.host.service.runtime), secondAccept = restarted.host.service.runtime.accept.bind(restarted.host.service.runtime)
  restarted.host.service.runtime.receive = request => { resumedMaterial.push(structuredClone(request)); return secondReceive(request) }
  restarted.host.service.runtime.accept = request => { const result = secondAccept(request); if (result.ok) resumedReceipts.push(result.value); return result }
  try {
    assert.equal(restarted.quick.getRecords(localSessionId).length, 0); assert.equal(restarted.host.provider.calls.length, 0)
    assert.equal(restarted.calls.open.length, 0); assert.equal(restarted.calls.submit.length, 0)
    assert.equal(restarted.quick.getUnits(localSessionId)[0].id, userUnit.id)
    assert.deepEqual(restarted.quick.getUnits(localSessionId)[0].final, oldFinal)
    await restarted.quick.retranslate(localSessionId, userUnit.id)
    await wait(() => restarted.quick.getRecords(localSessionId)[0]?.status === 'completed', 'fresh Host revision completed')
    assert.equal(resumedMaterial[0].trigger, 'quick_send'); assert.equal(resumedMaterial[0].target, undefined)
    assert.notEqual(resumedReceipts[0].unit_id, admitted[0].unit_id)
    assert.equal(restarted.quick.getUnits(localSessionId).length, 1); assert.equal(restarted.quick.getUnits(localSessionId)[0].revisions.length, 3)
    assert.deepEqual(restarted.quick.getUnits(localSessionId)[0].final, oldFinal)
    assert.equal(restarted.host.provider.calls.length, 1); assert.equal(restarted.calls.submit.length, 1)
    assert.equal(restarted.calls.submit[0].unitId, userUnit.id); assert.notEqual(restarted.calls.submit[0].operationId, first.calls.submit[0].operationId)
    const packet = restarted.host.provider.calls[0]
    assert.deepEqual(packet.messages.map(message => message.role), ['system', 'user'])
    assert.deepEqual(JSON.parse(packet.messages[1].content[0].text), { target_language: userUnit.targetLanguage, translation_requirements: userUnit.instruction, source_text: userUnit.source })
    assert.ok(!JSON.stringify(packet.messages).includes('合成译文')); assert.ok(!JSON.stringify(packet.messages).includes('untouched next draft'))
    assert.equal(restarted.store.getSession(localSessionId).input, 'Synthetic untouched next draft')
    assert.equal(restarted.host.nativeEvents, 0)
    await tick(); assert.ok(!storage.getItem(historyKey(localSessionId)).includes('sessionKey'))
  } finally { await restarted.close() }
})

test('真实Gateway/LLM/Session + Client：调用证据落盘，旧base人工修订及固定最终/TXT/JSON导出不增加模型调用，重启完整恢复', async () => {
  const storage = new NativeStorage()
  storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: true }))
  const app = await fixture({ storage }), gate = deferred()
  let id, unitId, firstRevisionId, fixedRevisionId, latestManualId
  try {
    await app.quick.send(app.id)
    await wait(() => app.quick.getRecords(app.id)[0]?.status === 'completed', 'first recorded call completed')
    id = app.id
    const initial = app.quick.getUnits(id)[0], original = initial.revisions[0]
    unitId = initial.id; firstRevisionId = original.id
    const sent = app.host.provider.calls[0], config = app.host.sessions[0].log.find(event => event.type === 'request/header').data.header.config
    assert.equal(original.kind, 'machine'); assert.equal(original.baseRevisionId, null)
    assert.deepEqual(original.callRecord, { promptVersion: TRANSLATION_PROMPT_VERSION,
      model: { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort },
      configVersion: null, maxOutputTokens: config.maxTokens, usage: { inputTokens: 7, outputTokens: 4 } })
    const context = reconstructTranslationContext(initial)
    assert.equal(context.systemPrompt, sent.messages[0].content[0].text); assert.equal(context.userMessage, sent.messages[1].content[0].text)
    app.store.updateSession(id, { input: 'Synthetic independent draft' })
    assert.equal(app.quick.saveManualRevision(id, unitId, original.id, 'Synthetic first manual final'), true)
    const manual = app.quick.getUnits(id)[0].revisions.at(-1)
    fixedRevisionId = manual.id
    assert.equal(manual.kind, 'manual'); assert.equal(manual.model, null); assert.equal(manual.callRecord, null)
    assert.equal(manual.baseRevisionId, original.id); assert.equal(app.quick.getUnits(id)[0].final, null)
    assert.equal(app.quick.selectFinal(id, unitId, manual.id), true)
    assert.equal(app.host.provider.calls.length, 1)
    app.host.provider.mode = 'zero-usage'; app.host.provider.gate = gate.promise
    app.store.updateSession(id, { model: { provider: 'synthetic', model: 'model-a', reasoningEffort: 'low' } })
    await app.quick.retranslate(id, unitId)
    await wait(() => app.host.provider.calls.length === 2, 'second actual stream entered')
    // Saving the selected old base remains legal while a later model version is arriving.
    assert.equal(app.quick.saveManualRevision(id, unitId, original.id, 'Synthetic second manual candidate'), true)
    latestManualId = app.quick.getUnits(id)[0].revisions.at(-1).id
    gate.resolve()
    await wait(() => app.quick.getRecords(id)[1]?.status === 'completed', 'later model version settled')
    const updated = app.quick.getUnits(id)[0], laterCall = updated.revisions.find(revision => revision.operationId === app.calls.submit[1].operationId)
    assert.deepEqual(laterCall.callRecord.usage, { inputTokens: 0, outputTokens: 0 })
    assert.equal(laterCall.callRecord.model.reasoningEffort, 'low')
    assert.equal(updated.revisions.at(-1).baseRevisionId, original.id)
    assert.equal(updated.revisions.at(-1).id, latestManualId)
    assert.equal(updated.revisions[0].text, '合成译文'); assert.equal(updated.final.revisionId, fixedRevisionId); assert.equal(updated.final.selection, 'user_fixed')
    assert.equal(app.store.getSession(id).input, 'Synthetic independent draft')
    const beforeExportCalls = app.host.provider.calls.length
    assert.equal(app.quick.finalizeForExport(id), true)
    const at = '2026-10-06T12:00:00.000Z', history = app.store.getTranslationHistory(id), session = app.store.getSession(id)
    const finalText = buildFinalTextExport(session, history, at)
    assert.equal(finalText.complete, true); assert.equal(finalText.content.trim(), 'Synthetic first manual final')
    const full = buildFullRecordExport(session, history, at), json = JSON.parse(full.content)
    assert.deepEqual(json.history, persistedTranslationHistory(history))
    assert.equal(json.history.units[0].source, undefined)
    assert.equal(json.history.units[0].sourceVersions[0].text, history.units[0].source)
    assert.equal(full.content.split(JSON.stringify(history.units[0].source)).length - 1, 1)
    const decoded = decodeTranslationHistory(json.history)
    assert.deepEqual(decoded, history)
    assert.deepEqual(json.history.units[0].revisions[0].callRecord, original.callRecord)
    assert.equal(json.history.units[0].revisions.at(-1).baseRevisionId, firstRevisionId)
    assert.equal(json.promptDefinitions.length, 1)
    assert.equal(json.promptDefinitions[0].promptVersion, TRANSLATION_PROMPT_VERSION)
    assert.equal(json.promptDefinitions[0].systemPrompt, sent.messages[0].content[0].text)
    assert.deepEqual(json.promptDefinitions[0].userMessageFields, {
      target_language: 'unit.targetLanguage', translation_requirements: 'unit.instruction', source_text: 'unit.source',
    })
    assert.equal(reconstructTranslationContext(decoded.units[0]).userMessage, sent.messages[1].content[0].text)
    assert.ok(!full.content.includes('sessionKey')); assert.ok(!full.content.includes('apiKey')); assert.ok(!full.content.includes('arbitraryProfile'))
    assert.equal(app.host.provider.calls.length, beforeExportCalls)
    await tick()
    const disk = JSON.parse(storage.getItem(historyKey(id)))
    assert.equal(disk.schemaVersion, 7); assert.equal(disk.translationHistory.schemaVersion, 4)
    assert.equal(disk.translationHistory.units[0].source, undefined)
    assert.equal(disk.translationHistory.units[0].sourceVersions[0].text, history.units[0].source)
    assert.equal(disk.translationHistory.units[0].revisions.at(-1).kind, 'manual')
    assert.deepEqual(disk.translationHistory.units[0].revisions.find(revision => revision.id === laterCall.id).callRecord.usage, { inputTokens: 0, outputTokens: 0 })
  } finally { gate.resolve(); await app.close() }
  const restored = await fixture({ storage, restoredId: id })
  try {
    const history = restored.store.getTranslationHistory(id), unit = restored.quick.getUnits(id)[0]
    assert.equal(unit.id, unitId); assert.equal(unit.final.revisionId, fixedRevisionId); assert.equal(unit.revisions.at(-1).id, latestManualId)
    assert.deepEqual(unit.revisions[0].callRecord.usage, { inputTokens: 7, outputTokens: 4 })
    assert.equal(unit.revisions.at(-1).baseRevisionId, firstRevisionId); assert.equal(unit.revisions.at(-1).callRecord, null)
    assert.equal(restored.host.provider.calls.length, 0); assert.equal(restored.calls.submit.length, 0); assert.equal(restored.calls.status.length, 0)
    assert.equal(buildFinalTextExport(restored.store.getSession(id), history, '2026-10-06T12:00:01.000Z').content.trim(), 'Synthetic first manual final')
    assert.equal(restored.host.provider.calls.length, 0)
  } finally { await restored.close() }
})

test('真实Gateway调用缺失用量保持null，执行中关历史与导出不改旧副本；重启中断不回放或伪造零用量', async () => {
  const storage = new NativeStorage()
  storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: true }))
  const app = await fixture({ storage }), gate = deferred()
  let id, unitId, saved
  try {
    id = app.id; app.host.provider.mode = 'no-usage'
    await app.quick.send(id); await wait(() => app.quick.getRecords(id)[0]?.status === 'completed', 'call without usage completed')
    const unit = app.quick.getUnits(id)[0]; unitId = unit.id
    assert.deepEqual(unit.revisions[0].callRecord.usage, { inputTokens: null, outputTokens: null })
    app.host.provider.mode = 'zero-usage'; app.host.provider.gate = gate.promise
    await app.quick.retranslate(id, unitId); await wait(() => app.host.provider.calls.length === 2, 'second call started')
    await tick(); assert.equal(await app.store.patchSettingsAsync({ rememberHistory: false }), true); await tick()
    saved = storage.getItem(historyKey(id))
    gate.resolve(); await wait(() => app.quick.getRecords(id)[1]?.status === 'completed', 'private zero-token call completed')
    assert.deepEqual(app.quick.getUnits(id)[0].revisions[1].callRecord.usage, { inputTokens: 0, outputTokens: 0 })
    assert.equal(app.quick.finalizeForExport(id), true)
    const exported = buildFinalTextExport(app.store.getSession(id), app.store.getTranslationHistory(id), '2026-10-06T12:00:00.000Z')
    assert.equal(exported.complete, true); assert.equal(exported.content.trim(), '合成译文')
    assert.equal(app.store.getSettings().rememberHistory, false); assert.equal(storage.getItem(historyKey(id)), saved)
    assert.equal(app.host.provider.calls.length, 2)
  } finally { gate.resolve(); await app.close() }
  const restored = await fixture({ storage, restoredId: id })
  try {
    const unit = restored.quick.getUnits(id)[0]
    assert.equal(unit.id, unitId); assert.equal(unit.revisions[1].status, 'interrupted')
    assert.deepEqual(unit.revisions[0].callRecord.usage, { inputTokens: null, outputTokens: null })
    assert.equal(unit.revisions[1].callRecord?.usage.inputTokens ?? null, null)
    assert.equal(unit.revisions[1].callRecord?.usage.outputTokens ?? null, null)
    assert.equal(unit.final, null)
    assert.equal(restored.host.provider.calls.length, 0); assert.equal(restored.calls.submit.length, 0); assert.equal(restored.quick.isBusy(id), false)
    assert.equal(restored.quick.finalizeForExport(id), true)
    const incomplete = buildFinalTextExport(restored.store.getSession(id), restored.store.getTranslationHistory(id), '2026-10-06T12:00:01.000Z')
    assert.equal(incomplete.content, null); assert.equal(incomplete.missingUnits[0].unitId, unitId)
    assert.equal(storage.getItem(historyKey(id)), saved)
    assert.equal(await restored.store.patchSettingsAsync({ rememberHistory: true }), true); await tick()
    assert.equal(JSON.parse(storage.getItem(historyKey(id))).translationHistory.units[0].revisions[1].status, 'interrupted')
    assert.equal(restored.host.provider.calls.length, 0)
  } finally { await restored.close() }
})
