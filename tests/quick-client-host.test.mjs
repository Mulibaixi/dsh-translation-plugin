import assert from 'node:assert/strict'
import test from 'node:test'
import { QuickTranslationClient } from '../dist/client/quick-translation.js'
import { adaptQuickRemote } from '../dist/client/quick-transport.js'
import { ModelCatalog } from '../dist/client/models.js'
import { SessionStore } from '../dist/client/session-store.js'
import { QuickTranslationService } from '../dist/host/quick-translation.js'

const ok = value => ({ ok: true, value })
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

// Real Client controller + Host service. The registered DSH Gateway has its own integration fixture.
async function fixture({ delaySubmit, delayPreparation } = {}) {
  const calls = { prepare: 0, stream: 0, submit: [], cancel: [] }
  const helpers = { createSystemMessage() {}, createUserMessage() {}, createAssistantMessage() {}, AssistantStreamAccumulator: class {}, BlockAssembler: class {} }
  const service = new QuickTranslationService({
    invocation: { peer: { id: 'synthetic-operator' } }, typertGateway: {}, provide() {},
    sessions: { prepare() { throw new Error('No stream is expected in a cancelled request') } },
    llm: {
      async listModels(provider) { return [{ provider, id: 'plain' }] },
      async resolveModelInfo(provider, id) { return { provider, id } },
      async prepareCall(config) {
        calls.prepare++; if (delayPreparation) await delayPreparation.promise
        return { config, adapterDefaults: {}, async *stream() { calls.stream++; throw new Error('No model dispatch expected') } }
      },
    },
  }, async () => helpers)
  const remote = Object.fromEntries(['capabilities', 'open', 'submit', 'status', 'cancel'].map(name => [name, async (...args) => {
    if (name === 'submit') { calls.submit.push(structuredClone(args[0])); if (delaySubmit) await delaySubmit.promise }
    if (name === 'cancel') calls.cancel.push(structuredClone(args[0]))
    return ok(await service[name](...args))
  }]))
  const store = new SessionStore(); store.ensureWorkspace('synthetic-owner')
  const id = store.getActiveSession('synthetic-owner').id
  store.updateSession(id, { input: 'Synthetic source', targetLanguage: 'English', model: { provider: 'synthetic', model: 'plain' } })
  const models = new ModelCatalog({ async modelCatalog() { return ok({ default: null, failures: [], groups: [{ id: 'synthetic', name: 'Synthetic', models: [{ id: 'plain', name: 'Plain' }] }] }) } })
  await models.load()
  const quick = new QuickTranslationClient(adaptQuickRemote(remote), store, models, { pollMs: 100000, requestTimeoutMs: 1000, makeId: () => 'synthetic-joint-operation' })
  await quick.load()
  return { quick, store, models, service, calls, id, close() { quick.dispose(); service.dispose(); models.dispose(); store.dispose() } }
}

test('Client与真实Host服务：cancel先于submit载体，0tombstone确认终态且迟到submit不调用模型/不复活', async () => {
  const gate = deferred(); const app = await fixture({ delaySubmit: gate })
  try {
    const sending = app.quick.send(app.id); await tick()
    assert.equal(app.calls.submit.length, 1)
    app.quick.cancel(app.id); await tick()
    assert.equal(app.quick.getRecords(app.id)[0].status, 'cancelled')
    assert.equal(app.quick.isBusy(app.id), false)
    assert.equal(app.store.getSession(app.id).input, 'Synthetic source')
    gate.resolve(); await sending
    assert.equal(app.calls.prepare, 0); assert.equal(app.calls.stream, 0)
    assert.equal(app.quick.getRecords(app.id)[0].status, 'cancelled')
    assert.equal(app.quick.getRecords(app.id)[0].text, '')
    const request = app.calls.submit[0]
    const status = await app.service.status({ sessionKey: request.sessionKey, operationId: request.operationId })
    assert.equal(status.ok, true); assert.equal(status.value.draftVersion, request.draftVersion)
    assert.equal(status.value.status, 'cancelled'); assert.equal(status.value.accepted, false)
    const changed = await app.service.submit({ ...request, sourceText: 'Changed source' })
    assert.equal(changed.ok, false); assert.equal(changed.error.code, 'idempotency_conflict')
  } finally { app.close() }
})

test('Client与真实Host服务：查询恰遇prepare中running/未受理保持草稿，取消后迟到准备不得派发', async () => {
  const gate = deferred(); const app = await fixture({ delayPreparation: gate })
  try {
    const sending = app.quick.send(app.id); await tick()
    assert.equal(app.calls.prepare, 1)
    app.quick.reset(); app.quick.query(app.quick.getRecords(app.id)[0]); await tick()
    assert.equal(app.quick.getRecords(app.id)[0].status, 'running')
    assert.equal(app.quick.getRecords(app.id)[0].accepted, false)
    assert.equal(app.store.getSession(app.id).input, 'Synthetic source')
    assert.equal(app.quick.isBusy(app.id), true)
    app.quick.cancel(app.id); await tick()
    assert.equal(app.quick.getRecords(app.id)[0].status, 'cancelled')
    gate.resolve(); await sending
    assert.equal(app.calls.stream, 0); assert.equal(app.quick.getRecords(app.id)[0].status, 'cancelled')
    assert.equal(app.store.getSession(app.id).input, 'Synthetic source')
  } finally { app.close() }
})
