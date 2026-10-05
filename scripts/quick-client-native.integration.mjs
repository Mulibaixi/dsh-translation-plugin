import assert from 'node:assert/strict'
import test from 'node:test'
import { createQuickHostFixture } from '../tests/quick-host-fixture.mjs'
import { QuickTranslationClient } from '../dist/client/quick-translation.js'
import { adaptQuickRemote } from '../dist/client/quick-transport.js'
import { ModelCatalog } from '../dist/client/models.js'
import { SessionStore } from '../dist/client/session-store.js'

// Run after building the workspace plugin:
// node --expose-internals --test scripts/quick-client-native.integration.mjs
// Uses extracted DSH 0.2.0-rc.2 packages and an entirely synthetic profile/provider.
const runtimeRoot = process.env.DSH_RUNTIME_ROOT
if (!runtimeRoot) throw new Error('DSH_RUNTIME_ROOT is required; it must contain a complete external dsh/node_modules tree from DSH 0.2.0-rc.2')
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function wait(predicate, label) {
  for (let count = 0; count < 200; count++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error(`Timed out: ${label}`)
}
async function fixture({ submitGate, prepareGate } = {}) {
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
  const store = new SessionStore(); store.ensureWorkspace('synthetic-main')
  const id = store.getActiveSession('synthetic-main').id
  store.updateSession(id, { input: 'Synthetic source', targetLanguage: 'English', instruction: 'Keep synthetic terms', model: { provider: 'synthetic', model: 'model-a', reasoningEffort: 'high' } })
  const models = new ModelCatalog({ async modelCatalog() { return { ok: true, value: { default: null, failures: [], groups: [{ id: 'synthetic', name: 'Synthetic', models: [{ id: 'model-a', name: 'A', reasoning: { defaultEffort: 'high', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }] }] } } } })
  await models.load()
  let sequence = 0
  const quick = new QuickTranslationClient(adaptQuickRemote(remote), store, models, { pollMs: 5, requestTimeoutMs: 2000, makeId: () => `synthetic-native-op:${++sequence}` })
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
