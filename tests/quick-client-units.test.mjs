import assert from 'node:assert/strict'
import test from 'node:test'
import { QuickTranslationClient } from '../dist/client/quick-translation.js'
import { ModelCatalog } from '../dist/client/models.js'
import { SessionStore } from '../dist/client/session-store.js'
import { DEFAULT_SESSION_SETTINGS, SETTINGS_KEY, historyKey } from '../dist/client/sessions.js'
import { sessionModelKey } from '../dist/client/model-preferences.js'
import { buildFinalTextExport, buildFullRecordExport } from '../dist/client/translation-export.js'

const ok = value => ({ ok: true, value })
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
class Storage {
  values = new Map()
  tail = Promise.resolve()
  locks = { request: (_name, action) => { const operation = this.tail.then(action); this.tail = operation.catch(() => {}); return operation } }
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}
const catalog = { default: null, failures: [], groups: [{ id: 'synthetic', name: 'Synthetic', models: [
  { id: 'plain', name: 'Plain' }, { id: 'reason', name: 'Reason', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
] }] }
function job(request, patch = {}) { return { sessionKey: request.sessionKey, operationId: request.operationId, draftVersion: request.draftVersion,
  accepted: true, status: 'completed', text: 'Synthetic translation', ...patch } }
const metadata = { promptVersion: 'text-runtime-v1', model: { provider: 'synthetic', model: 'plain', reasoningEffort: null }, configVersion: null,
  maxOutputTokens: null, usage: { inputTokens: 7, outputTokens: 4 } }
let fixtures = 0
async function fixture({ overrides = {}, storage = new Storage(), remember = false, restoredId } = {}) {
  if (!storage.getItem(SETTINGS_KEY)) storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: remember }))
  const store = new SessionStore(storage, undefined, storage.locks); store.ensureWorkspace('synthetic-owner')
  const id = restoredId ?? store.getActiveSession('synthetic-owner').id
  if (!restoredId) store.updateSession(id, { input: 'Synthetic frozen source', targetLanguage: 'English', instruction: 'Keep synthetic terms', model: { provider: 'synthetic', model: 'plain' } })
  const models = new ModelCatalog({ async modelCatalog() { return ok(catalog) } }); await models.load()
  const calls = { open: [], submit: [], status: [], cancel: [] }, latest = new Map()
  const port = {
    async capabilities() { return ok({ ready: true, storage: 'runtime_only', mode: 'quick' }) },
    async open(request) { calls.open.push(request); return ok({ sessionKey: `synthetic-host:${fixtures}`, ...request }) },
    async submit(request) { calls.submit.push(request); latest.set(request.operationId, request); return ok(job(request)) },
    async status(request) { calls.status.push(request); return ok(job(latest.get(request.operationId))) },
    async cancel(request) { calls.cancel.push(request); return ok(job(latest.get(request.operationId), { status: 'cancelled', text: '' })) },
    ...overrides,
  }
  let sequence = 0; const run = ++fixtures
  const quick = new QuickTranslationClient(port, store, models, { pollMs: 100000, requestTimeoutMs: 100, makeId: () => `synthetic-unit-op:${run}:${++sequence}` })
  await quick.load(); await tick()
  return { quick, store, models, port, storage, calls, id, close() { quick.dispose(); models.dispose(); store.dispose() } }
}

test('安全metadata随回执保存，单独usage变化更新指定版，相同轮询不追加事件或写盘', async () => {
  const app = await fixture({ remember: true })
  try {
    const startMetadata = { ...metadata, usage: { inputTokens: null, outputTokens: null } }
    app.port.submit = async request => { app.calls.submit.push(request); return ok(job(request, { status: 'running', text: 'Synthetic stream', metadata: startMetadata })) }
    await app.quick.send(app.id); await tick()
    const record = app.quick.getRecords(app.id)[0], count = app.store.getTranslationHistory(app.id).events.length
    app.port.status = async () => ok(job(app.calls.submit[0], { status: 'running', text: 'Synthetic stream', metadata }))
    record.status = 'unknown'; app.quick.query(record); await tick()
    assert.equal(app.store.getTranslationHistory(app.id).events.length, count + 1)
    assert.deepEqual(app.quick.getUnits(app.id)[0].revisions[0].callRecord, metadata)
    const saved = app.storage.getItem(historyKey(app.id))
    record.status = 'unknown'; app.quick.query(record); await tick()
    assert.equal(app.store.getTranslationHistory(app.id).events.length, count + 1); assert.equal(app.storage.getItem(historyKey(app.id)), saved)
    app.port.status = async () => ok(job(app.calls.submit[0], { metadata: { ...metadata, usage: { inputTokens: 0, outputTokens: 0 } } }))
    record.status = 'unknown'; app.quick.query(record); await tick()
    assert.deepEqual(app.quick.getUnits(app.id)[0].revisions[0].callRecord.usage, { inputTokens: 0, outputTokens: 0 })
    const snapshot = JSON.parse(app.storage.getItem(historyKey(app.id)))
    assert.equal(snapshot.schemaVersion, 7); assert.equal(snapshot.translationHistory.schemaVersion, 4)
    assert.ok(!JSON.stringify(snapshot).includes('sessionKey'))
  } finally { app.close() }
})

test('旧base在新machine执行期间可人工保存，迟到结果不覆盖manual或固定最终，也不新增模型调用', async () => {
  const app = await fixture({ remember: true })
  try {
    await app.quick.send(app.id); const unit = app.quick.getUnits(app.id)[0], base = unit.revisions[0]
    assert.equal(base.callRecord, null)
    assert.equal(app.quick.saveManualRevision(app.id, unit.id, base.id, 'Synthetic fixed manual'), true)
    const fixed = app.quick.getUnits(app.id)[0].revisions.at(-1)
    assert.equal(app.quick.selectFinal(app.id, unit.id, fixed.id), true)
    app.port.submit = async request => { app.calls.submit.push(request); return ok(job(request, { status: 'running', text: 'Synthetic new stream', metadata })) }
    await app.quick.retranslate(app.id, unit.id)
    assert.equal(app.quick.isBusy(app.id), true)
    const calls = app.calls.submit.length, running = app.quick.getRecords(app.id).at(-1)
    assert.equal(app.quick.saveManualRevision(app.id, unit.id, base.id, 'Synthetic old-base new manual'), true)
    const manual = app.quick.getUnits(app.id)[0].revisions.at(-1)
    assert.equal(manual.baseRevisionId, base.id); assert.equal(manual.model, null); assert.equal(manual.callRecord, null)
    app.port.status = async () => ok(job(app.calls.submit.at(-1), { metadata }))
    running.status = 'unknown'; app.quick.query(running); await tick()
    const updated = app.quick.getUnits(app.id)[0]
    assert.equal(updated.revisions.at(-1).id, manual.id); assert.equal(updated.revisions[2].status, 'completed')
    assert.equal(updated.final.revisionId, fixed.id)
    assert.equal(app.quick.finalizeForExport(app.id), true)
    const txt = buildFinalTextExport(app.store.getSession(app.id), app.store.getTranslationHistory(app.id), new Date().toISOString())
    assert.equal(txt.content, 'Synthetic fixed manual'); assert.equal(app.calls.submit.length, calls)
  } finally { app.close() }
})

test('人工保存无需当前模型/Host，quick升normal后保留修订和最终导出，normal发送仍阻止', async () => {
  const app = await fixture()
  try {
    await app.quick.send(app.id); const unit = app.quick.getUnits(app.id)[0]
    assert.equal(app.store.updateSession(app.id, { mode: 'normal', model: null }), true)
    app.quick.reset(); const calls = app.calls.submit.length
    assert.equal(app.quick.saveManualRevision(app.id, unit.id, unit.revisions[0].id, 'Synthetic normal local edit'), true)
    assert.equal(app.quick.finalizeForExport(app.id), true)
    const result = buildFinalTextExport(app.store.getSession(app.id), app.store.getTranslationHistory(app.id), new Date().toISOString())
    assert.equal(result.content, 'Synthetic normal local edit')
    await app.quick.send(app.id); assert.equal(app.calls.submit.length, calls); assert.match(app.quick.blockedReason(app.store.getSession(app.id)), /普通模式/)
  } finally { app.close() }
})

test('人工保存失败保留原记录与固定值；有效会话无可收尾版本仍允许导出检查缺项', async () => {
  const app = await fixture()
  try {
    assert.equal(app.quick.finalizeForExport(app.id), true)
    await app.quick.send(app.id); const unit = app.quick.getUnits(app.id)[0], before = JSON.stringify(app.store.getTranslationHistory(app.id))
    assert.equal(app.quick.saveManualRevision(app.id, unit.id, 'missing', 'Synthetic edit'), false)
    assert.equal(app.quick.saveManualRevision(app.id, unit.id, unit.revisions[0].id, ' \n '), false)
    assert.equal(JSON.stringify(app.store.getTranslationHistory(app.id)), before)
    app.port.submit = async request => { app.calls.submit.push(request); return ok(job(request, { status: 'failed', text: 'Synthetic partial' })) }
    await app.quick.retranslate(app.id, unit.id)
    assert.equal(app.quick.finalizeForExport(app.id), true)
    const result = buildFinalTextExport(app.store.getSession(app.id), app.store.getTranslationHistory(app.id), new Date().toISOString())
    assert.equal(result.content, null); assert.equal(result.missingUnits[0].latestStatus, 'failed')
    assert.equal(app.quick.finalizeForExport('missing'), false)
  } finally { app.close() }
})

test('关闭历史后manual/final和显式JSON导出只留运行期，旧磁盘副本保持，开启后纳入', async () => {
  const app = await fixture({ remember: true })
  try {
    await app.quick.send(app.id); await tick(); const unit = app.quick.getUnits(app.id)[0]
    await app.store.patchSettingsAsync({ rememberHistory: false }); await tick()
    const saved = app.storage.getItem(historyKey(app.id)), calls = app.calls.submit.length
    assert.equal(app.quick.saveManualRevision(app.id, unit.id, unit.revisions[0].id, 'Synthetic private edit'), true)
    assert.equal(app.quick.finalizeForExport(app.id), true); await tick()
    const json = JSON.parse(buildFullRecordExport(app.store.getSession(app.id), app.store.getTranslationHistory(app.id), new Date().toISOString()).content)
    assert.equal(json.history.units[0].revisions.length, 2); assert.equal(json.history.units[0].revisions[1].kind, 'manual')
    assert.equal(json.history.units[0].final.revisionId, json.history.units[0].revisions[1].id)
    assert.equal(app.storage.getItem(historyKey(app.id)), saved); assert.equal(app.calls.submit.length, calls)
    await app.store.patchSettingsAsync({ rememberHistory: true }); await tick()
    assert.equal(JSON.parse(app.storage.getItem(historyKey(app.id))).translationHistory.units[0].revisions.length, 2)
  } finally { app.close() }
})

test('新稿只在valid accepted时建单元，未受理prepare失败和晚到受理不提前定稿', async () => {
  const app = await fixture()
  try {
    await app.quick.send(app.id); const first = app.quick.getUnits(app.id)[0]
    assert.equal(first.final, null)
    app.store.updateSession(app.id, { input: 'Synthetic rejected draft' })
    app.port.submit = async request => { app.calls.submit.push(request); return ok(job(request, { accepted: false, status: 'failed', text: '', error: { code: 'EXECUTION_FAILED', message: 'Synthetic prepare failure' } })) }
    await app.quick.send(app.id)
    assert.equal(app.quick.getUnits(app.id).length, 1); assert.equal(app.quick.getUnits(app.id)[0].final, null)
    assert.equal(app.store.getSession(app.id).input, 'Synthetic rejected draft')
    const gate = deferred()
    app.port.submit = async request => { app.calls.submit.push(request); return gate.promise }
    const sending = app.quick.send(app.id); await tick()
    assert.equal(app.quick.getUnits(app.id).length, 1); assert.equal(app.quick.getUnits(app.id)[0].final, null)
    gate.resolve(ok(job(app.calls.submit.at(-1)))); await sending
    assert.equal(app.quick.getUnits(app.id).length, 2)
    assert.deepEqual(app.quick.getUnits(app.id)[0].final, { revisionId: first.revisions[0].id, selection: 'automatic', selectedAt: app.quick.getUnits(app.id)[0].final.selectedAt })
  } finally { app.close() }
})

test('同单元重译冻结材料、使用当前模型与effort、保留新草稿和原版本模型', async () => {
  const app = await fixture()
  try {
    await app.quick.send(app.id); const first = app.quick.getUnits(app.id)[0]
    app.store.updateSession(app.id, { input: 'Synthetic next draft', targetLanguage: '日本語', instruction: 'New draft requirements', model: { provider: 'synthetic', model: 'reason', reasoningEffort: 'high' } })
    await app.quick.retranslate(app.id, first.id)
    const units = app.quick.getUnits(app.id), request = app.calls.submit[1]
    assert.equal(units.length, 1); assert.equal(units[0].revisions.length, 2)
    assert.equal(request.unitId, app.calls.submit[0].unitId)
    assert.notEqual(request.operationId, app.calls.submit[0].operationId)
    assert.equal(request.sourceText, first.source); assert.equal(request.targetLanguage, 'English'); assert.equal(request.instruction, 'Keep synthetic terms')
    assert.deepEqual(request.model, { providerId: 'synthetic', modelId: 'reason', configVersion: 0, reasoningEffort: 'high' })
    assert.equal(app.store.getSession(app.id).input, 'Synthetic next draft')
    assert.deepEqual(units[0].revisions.map(revision => revision.model.model), ['plain', 'reason'])
    assert.equal(units[0].revisions[1].model.reasoningEffort, 'high'); assert.equal(units[0].final, null)
  } finally { app.close() }
})

test('受理回执无法附着用户历史时保留新稿，不以模型已受理代替本地采用成功', async () => {
  const app = await fixture()
  try {
    app.store.updateTranslationHistory = () => false
    await app.quick.send(app.id)
    assert.equal(app.quick.getRecords(app.id)[0].accepted, true)
    assert.equal(app.quick.getUnits(app.id).length, 0)
    assert.equal(app.store.getSession(app.id).input, 'Synthetic frozen source')
  } finally { app.close() }
})

test('最新重译失败或不完整阻止旧成功自动定稿，显式固定旧版不触发模型且后续试译保留', async () => {
  for (const { fixed, accepted } of [{ fixed: false, accepted: false }, { fixed: false, accepted: true }, { fixed: true, accepted: false }, { fixed: true, accepted: true }]) {
    const app = await fixture()
    try {
      await app.quick.send(app.id); const first = app.quick.getUnits(app.id)[0], firstRevision = first.revisions[0]
      if (fixed) { const count = app.calls.submit.length; assert.equal(app.quick.selectFinal(app.id, first.id, firstRevision.id), true); assert.equal(app.calls.submit.length, count) }
      app.port.submit = async request => { app.calls.submit.push(request); return ok(job(request, { accepted, status: 'failed', text: accepted ? 'Synthetic incomplete output' : '' })) }
      app.store.updateSession(app.id, { input: 'Synthetic next draft' }); await app.quick.retranslate(app.id, first.id)
      assert.equal(app.store.getSession(app.id).input, 'Synthetic next draft')
      assert.equal(app.quick.getUnits(app.id)[0].revisions[1].status, 'failed')
      assert.equal(app.quick.selectFinal(app.id, first.id, app.quick.getUnits(app.id)[0].revisions[1].id), false)
      app.port.submit = async request => { app.calls.submit.push(request); return ok(job(request)) }
      await app.quick.send(app.id)
      const unit = app.quick.getUnits(app.id)[0]
      assert.equal(unit.final?.revisionId ?? null, fixed ? firstRevision.id : null)
      if (fixed) assert.equal(unit.final.selection, 'user_fixed')
    } finally { app.close() }
  }
})

test('受理后的同单元失败不恢复或消费输入，即使输入为空；重复running回执不追加event', async () => {
  const app = await fixture()
  try {
    await app.quick.send(app.id); const unit = app.quick.getUnits(app.id)[0]
    app.port.submit = async request => { app.calls.submit.push(request); return ok(job(request, { status: 'running', text: '' })) }
    await app.quick.retranslate(app.id, unit.id)
    const record = app.quick.getRecords(app.id).at(-1)
    const count = app.store.getTranslationHistory(app.id).events.length
    app.port.status = async () => ok(job(app.calls.submit.at(-1), { status: 'running', text: '' }))
    record.status = 'unknown'; app.quick.query(record); await tick()
    assert.equal(app.store.getTranslationHistory(app.id).events.length, count)
    app.port.status = async () => ok(job(app.calls.submit.at(-1), { status: 'failed', text: 'Synthetic partial output' }))
    record.status = 'unknown'; app.quick.query(record); await tick()
    assert.equal(app.store.getSession(app.id).input, '')
    assert.equal(app.quick.getUnits(app.id)[0].revisions[1].text, 'Synthetic partial output')
    assert.equal(app.quick.getUnits(app.id)[0].revisions[1].status, 'failed')
  } finally { app.close() }
})

test('已自动定稿的历史单元继续试译只增加候选，失败也保留既有最终事实', async () => {
  const app = await fixture()
  try {
    await app.quick.send(app.id); const first = app.quick.getUnits(app.id)[0]
    app.store.updateSession(app.id, { input: 'Synthetic second unit' }); await app.quick.send(app.id)
    assert.equal(app.quick.getUnits(app.id)[0].final.selection, 'automatic')
    app.port.submit = async request => { app.calls.submit.push(request); return ok(job(request, { status: 'failed', text: 'Synthetic incomplete revision' })) }
    await app.quick.retranslate(app.id, first.id)
    const retried = app.quick.getUnits(app.id)[0]
    assert.equal(retried.revisions.at(-1).status, 'failed')
    assert.equal(retried.final.revisionId, first.revisions[0].id); assert.equal(retried.final.selection, 'automatic')
  } finally { app.close() }
})

test('保存完整记录与固定最终，重启不恢复Host句柄/不自动调用；显式重译保留同用户unit', async () => {
  const storage = new Storage(), app = await fixture({ storage, remember: true })
  await app.quick.send(app.id); const first = app.quick.getUnits(app.id)[0]
  await app.quick.retranslate(app.id, first.id); app.quick.selectFinal(app.id, first.id, first.revisions[0].id); await tick()
  const id = app.id; app.close(); await tick()
  const restored = await fixture({ storage, restoredId: id })
  try {
    assert.equal(restored.quick.getRecords(id).length, 0); assert.equal(restored.calls.open.length, 0); assert.equal(restored.calls.submit.length, 0)
    assert.equal(restored.quick.getUnits(id)[0].final.selection, 'user_fixed')
    assert.equal(restored.quick.getUnits(id)[0].revisions.length, 2)
    await restored.quick.retranslate(id, first.id); await tick()
    assert.equal(restored.calls.open.length, 1); assert.equal(restored.calls.submit.length, 1)
    assert.equal(restored.quick.getUnits(id).length, 1); assert.equal(restored.quick.getUnits(id)[0].revisions.length, 3)
    assert.equal(restored.quick.getUnits(id)[0].id, first.id); assert.equal(restored.quick.getUnits(id)[0].final.revisionId, first.revisions[0].id)
    assert.ok(!storage.getItem(historyKey(id)).includes('sessionKey'))
  } finally { restored.close() }
})

test('执行中关闭保存保留旧副本，迟到结果留内存；模型偏好独立保存，再开启纳入完整状态', async () => {
  const app = await fixture({ remember: true })
  try {
    app.port.submit = async request => { app.calls.submit.push(request); return ok(job(request, { status: 'running', text: '' })) }
    await app.quick.send(app.id); await tick()
    await app.store.patchSettingsAsync({ rememberHistory: false }); await tick()
    const saved = app.storage.getItem(historyKey(app.id)), record = app.quick.getRecords(app.id)[0]
    app.store.updateSession(app.id, { input: 'Synthetic private next draft', model: { provider: 'synthetic', model: 'reason', reasoningEffort: 'high' } })
    app.port.status = async () => ok(job(app.calls.submit[0])); record.status = 'unknown'; app.quick.query(record); await tick()
    assert.equal(app.quick.getUnits(app.id)[0].revisions[0].status, 'completed')
    assert.equal(app.storage.getItem(historyKey(app.id)), saved)
    assert.equal(JSON.parse(app.storage.getItem(sessionModelKey(app.id))).model.reasoningEffort, 'high')
    await app.store.patchSettingsAsync({ rememberHistory: true }); await tick()
    const persisted = JSON.parse(app.storage.getItem(historyKey(app.id)))
    assert.equal(persisted.translationHistory.units[0].revisions[0].status, 'completed')
    assert.equal(persisted.session.input, 'Synthetic private next draft')
  } finally { app.close() }
})

test('重启前未确认版显示interrupted，无query或永久busy；显式重译才产生新操作', async () => {
  const storage = new Storage(), app = await fixture({ storage, remember: true })
  await app.quick.send(app.id); const unit = app.quick.getUnits(app.id)[0]
  app.port.submit = async request => { app.calls.submit.push(request); return ok(job(request, { status: 'running', text: '' })) }
  app.port.cancel = async () => { throw new Error('Synthetic transport loss') }
  await app.quick.retranslate(app.id, unit.id); await tick(); const id = app.id; app.close(); await tick()
  const restored = await fixture({ storage, restoredId: id })
  try {
    assert.equal(restored.quick.getUnits(id)[0].revisions[1].status, 'interrupted')
    assert.equal(restored.quick.isBusy(id), false); assert.equal(restored.calls.status.length, 0); assert.equal(restored.calls.submit.length, 0)
    await restored.quick.retranslate(id, unit.id)
    assert.equal(restored.calls.submit.length, 1); assert.equal(restored.quick.getUnits(id)[0].revisions.length, 3)
  } finally { restored.close() }
})

test('重译期间删除会话，迟到受理与译文不能重建用户单元或磁盘历史', async () => {
  const app = await fixture({ remember: true }), gate = deferred()
  try {
    await app.quick.send(app.id); const unit = app.quick.getUnits(app.id)[0]
    app.port.submit = async request => { app.calls.submit.push(request); return gate.promise }
    const retry = app.quick.retranslate(app.id, unit.id); await tick()
    await app.store.deleteHistoryAsync([app.id], false, [], app.store.captureHistoryVersions([app.id]))
    gate.resolve(ok(job(app.calls.submit.at(-1)))); await retry; await tick()
    assert.equal(app.store.getSession(app.id), undefined); assert.equal(app.quick.getRecords(app.id).length, 0); assert.equal(app.quick.getUnits(app.id).length, 0)
    assert.equal(app.storage.getItem(historyKey(app.id)), null); assert.equal(app.calls.cancel.length, 1)
  } finally { gate.resolve(); app.close() }
})
