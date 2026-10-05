import assert from 'node:assert/strict'
import test from 'node:test'
import { QuickTranslationClient } from '../dist/client/quick-translation.js'
import { adaptQuickRemote } from '../dist/client/quick-transport.js'
import { ModelCatalog } from '../dist/client/models.js'
import { SessionStore } from '../dist/client/session-store.js'
import { historyKey } from '../dist/client/sessions.js'

const ok = value => ({ ok: true, value })
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const catalog = { default: null, failures: [], groups: [{ id: 'mock', name: 'Mock', models: [{ id: 'plain', name: 'Plain' }, { id: 'reason', name: 'Reason', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }] }] }
function job(request, patch = {}) { return { sessionKey: request.sessionKey, operationId: request.operationId, draftVersion: request.draftVersion, accepted: true, status: 'running', text: '', ...patch } }
async function fixture(overrides = {}, storage) {
  const store = new SessionStore(storage)
  store.ensureWorkspace('owner-a')
  const first = store.getActiveSession('owner-a')
  store.updateSession(first.id, { input: '合成原文', instruction: '保留合成术语', model: { provider: 'mock', model: 'reason', reasoningEffort: 'high' } })
  const models = new ModelCatalog({ async modelCatalog() { return ok(catalog) } }); await models.load()
  const calls = { open: [], submit: [], status: [], cancel: [] }
  const latest = new Map()
  const port = {
    async capabilities() { return ok({ ready: true, storage: 'runtime_only', mode: 'quick' }) },
    async open(request) { calls.open.push(request); return ok({ sessionKey: 'host-' + calls.open.length, ...request }) },
    async submit(request) { calls.submit.push(request); latest.set(request.operationId, request); return ok(job(request)) },
    async status(request) { calls.status.push(request); return ok(job(latest.get(request.operationId), { status: 'completed', text: '合成译文' })) },
    async cancel(request) { calls.cancel.push(request); return ok(job(latest.get(request.operationId), { status: 'cancelled' })) },
    ...overrides,
  }
  const quick = new QuickTranslationClient(port, store, models, { pollMs: 100000, requestTimeoutMs: 30, makeId: (() => { let id = 0; return () => 'synthetic-op-' + ++id })() })
  await quick.load()
  return { store, models, quick, calls, port, id: first.id, close() { quick.dispose(); models.dispose(); store.dispose() } }
}

test('Client unwrap严格使用Gateway双封套，单封套/畸形/transport错误不取得ready', async () => {
  const method = async () => ok(ok({ ready: true, storage: 'runtime_only', mode: 'quick' }))
  const remote = Object.fromEntries(['capabilities', 'open', 'submit', 'status', 'cancel'].map(name => [name, method]))
  assert.equal((await adaptQuickRemote(remote).capabilities()).value.ready, true)
  for (const response of [ok({ ready: true }), { ok: false, error: { message: 'transport' } }, ok({ ok: true, value: null })]) {
    await assert.rejects(adaptQuickRemote({ ...remote, capabilities: async () => response }).capabilities())
  }
})

test('实际reload改变草稿不被旧受理清空；仅重建同值对象仍消费对应未变草稿', async () => {
  for (const changed of [true, false]) {
    const values = new Map()
    const storage = { get length() { return values.size }, key(index) { return [...values.keys()][index] ?? null }, getItem(key) { return values.get(key) ?? null }, setItem(key, value) { values.set(key, value) }, removeItem(key) { values.delete(key) } }
    const hold = deferred()
    const app = await fixture({ async submit(request) { app.calls.submit.push(request); return hold.promise } }, storage)
    const sending = app.quick.send(app.id); await tick()
    const snapshot = app.store.getSession(app.id)
    storage.setItem(historyKey(app.id), JSON.stringify({ schemaVersion: 3, token: 'synthetic-reload', session: { ...snapshot, input: changed ? '实际读取的新草稿' : snapshot.input } }))
    assert.equal(app.store.reloadSession(app.id), true)
    hold.resolve(ok(job(app.calls.submit[0], { status: 'completed', text: '合成译文' }))); await sending
    assert.equal(app.store.getSession(app.id).input, changed ? '实际读取的新草稿' : '')
    app.close()
  }
})

test('受理后失败恢复跨无关会话对象重建仍有效；受理后新编辑再清空不被旧失败恢复覆盖', async () => {
  for (const edited of [false, true]) {
    const app = await fixture({ async status() { return ok(job(app.calls.submit[0], { status: 'failed' })) } })
    await app.quick.send(app.id)
    assert.equal(app.store.getSession(app.id).input, '')
    app.store.ensureWorkspace('other-synthetic-owner')
    if (edited) { app.store.updateSession(app.id, { input: '后来编辑' }); app.store.updateSession(app.id, { input: '' }) }
    app.quick.getRecords(app.id)[0].status = 'unknown'; app.quick.query(app.quick.getRecords(app.id)[0]); await tick()
    assert.equal(app.store.getSession(app.id).input, edited ? '' : '合成原文')
    app.close()
  }
})

test('Gateway外层失败或畸形submit回执保留unknown与原身份，不能误当Host拒绝后重复计费', async () => {
  for (const response of [{ ok: false, error: { code: 'connection_lost', message: 'synthetic' } }, ok({ ok: true, value: { unexpected: 'shape' } }), ok({ ok: false, error: { code: 'internal_error', message: 'synthetic', unexpected: true } })]) {
    const app = await fixture()
    const domain = app.port
    const remote = Object.fromEntries(Object.keys(domain).map(name => [name, async (...args) => ok(await domain[name](...args))]))
    remote.submit = async request => { app.calls.submit.push(request); return response }
    app.quick.dispose()
    app.quick = new QuickTranslationClient(adaptQuickRemote(remote), app.store, app.models, { pollMs: 100000, requestTimeoutMs: 30, makeId: () => 'gateway-shape-op' })
    await app.quick.load(); await app.quick.send(app.id)
    assert.equal(app.quick.getRecords(app.id)[0].status, 'unknown'); assert.equal(app.quick.isBusy(app.id), true)
    await app.quick.send(app.id); assert.equal(app.calls.submit.length, 1)
    app.quick.dispose(); app.close()
  }
})

test('Host submit内部错误或未知领域错误不能证明未执行，保留unknown；明确校验拒绝才释放锁', async () => {
  for (const code of ['internal_error', 'idempotency_conflict', 'unexpected_code']) {
    const app = await fixture({ async submit(request) { app.calls.submit.push(request); return { ok: false, error: { code, message: 'Synthetic error' } } } })
    await app.quick.send(app.id); await app.quick.send(app.id)
    assert.equal(app.quick.getRecords(app.id)[0].status, 'unknown'); assert.equal(app.calls.submit.length, 1)
    assert.equal(app.store.getSession(app.id).input, '合成原文'); app.close()
  }
  const rejected = await fixture({ async submit() { return { ok: false, error: { code: 'invalid_input', message: 'Synthetic rejection' } } } })
  await rejected.quick.send(rejected.id)
  assert.equal(rejected.quick.getRecords(rejected.id)[0].status, 'failed'); assert.equal(rejected.quick.isBusy(rejected.id), false)
  rejected.close()
})

test('快译冻结正文/语言/要求/精确模型effort；重复点击只调用一次', async () => {
  const hold = deferred()
  const app = await fixture({ submit: async request => { app.calls.submit.push(request); return hold.promise } })
  const sending = app.quick.send(app.id)
  await tick()
  await app.quick.send(app.id)
  app.store.updateSession(app.id, { input: '后来输入', targetLanguage: 'English', instruction: '后来要求', model: { provider: 'mock', model: 'plain' } })
  assert.equal(app.calls.submit.length, 1)
  const request = app.calls.submit[0]
  assert.equal(request.sourceText, '合成原文'); assert.equal(request.targetLanguage, '中文'); assert.equal(request.instruction, '保留合成术语')
  assert.deepEqual(request.model, { providerId: 'mock', modelId: 'reason', configVersion: 0, reasoningEffort: 'high' })
  hold.resolve(ok(job(request, { status: 'completed', text: '合成译文' }))); await sending
  assert.equal(app.store.getSession(app.id).input, '后来输入')
  assert.equal(app.quick.getRecords(app.id)[0].text, '合成译文')
  app.close()
})

test('仅成功受理消费未变化草稿；input编辑再撤回也不被旧回执清空', async () => {
  const app = await fixture(); await app.quick.send(app.id)
  assert.equal(app.store.getSession(app.id).input, '')
  assert.equal(app.quick.getRecords(app.id)[0].accepted, true)
  app.close()
  const hold = deferred()
  const edited = await fixture({ submit: async request => { edited.calls.submit.push(request); return hold.promise } })
  const sending = edited.quick.send(edited.id); await tick()
  edited.store.updateSession(edited.id, { input: '修改' }); edited.store.updateSession(edited.id, { input: '合成原文' })
  hold.resolve(ok(job(edited.calls.submit[0]))); await sending
  assert.equal(edited.store.getSession(edited.id).input, '合成原文')
  edited.close()
})

test('Host准备中的running accepted:false不清稿且继续阻止新发送，受理后才消费草稿', async () => {
  const app = await fixture({ async submit(request) { app.calls.submit.push(request); return ok(job(request, { accepted: false })) } })
  await app.quick.send(app.id)
  assert.equal(app.quick.getRecords(app.id)[0].status, 'running')
  assert.equal(app.quick.getRecords(app.id)[0].accepted, false)
  assert.equal(app.store.getSession(app.id).input, '合成原文')
  await app.quick.send(app.id); assert.equal(app.calls.submit.length, 1)
  app.port.status = async () => ok(job(app.calls.submit[0], { status: 'completed', text: '合成译文' }))
  app.quick.reset(); app.quick.query(app.quick.getRecords(app.id)[0]); await tick()
  assert.equal(app.quick.getRecords(app.id)[0].status, 'completed')
  assert.equal(app.store.getSession(app.id).input, '')
  app.close()
})

test('取消回执丢失后查询0版本cancel tombstone仍可确认，未请求取消的0版本失败封闭', async () => {
  const app = await fixture({ async cancel() { throw new Error('synthetic transport loss') } })
  await app.quick.send(app.id); app.quick.cancel(app.id); await tick()
  app.port.status = async request => ok({ ...request, draftVersion: 0, accepted: false, status: 'cancelled', text: '' })
  app.quick.query(app.quick.getRecords(app.id)[0]); await tick()
  assert.equal(app.quick.getRecords(app.id)[0].status, 'cancelled'); assert.equal(app.quick.isBusy(app.id), false)
  app.close()
  const unmatched = await fixture({ async submit(request) { return ok(job(request, { draftVersion: 0, accepted: false, status: 'cancelled' })) } })
  await unmatched.quick.send(unmatched.id)
  assert.equal(unmatched.quick.getRecords(unmatched.id)[0].status, 'unknown'); assert.equal(unmatched.quick.isBusy(unmatched.id), true)
  unmatched.close()
})

test('空文本/超码点上限/无模型/失效effort/普通模式/未ready均不派发', async () => {
  const app = await fixture()
  for (const patch of [{ input: '' }, { input: '😀😀', maxInputChars: 1 }, { maxInputChars: 20000, input: '合成原文', model: null }, { model: { provider: 'mock', model: 'missing' } }, { model: { provider: 'mock', model: 'reason', reasoningEffort: 'invalid' } }, { model: { provider: 'mock', model: 'plain' }, mode: 'normal' }]) {
    app.store.updateSession(app.id, patch); assert.ok(app.quick.blockedReason(app.store.getSession(app.id))); await app.quick.send(app.id)
  }
  assert.equal(app.calls.submit.length, 0); app.close()
  const unavailable = await fixture({ async capabilities() { return ok({ ready: true, storage: 'persisted', mode: 'quick' }) } })
  await unavailable.quick.send(unavailable.id); assert.equal(unavailable.calls.submit.length, 0); unavailable.close()
})

test('回执sessionKey/opid/draftVersion/完成正文格式不匹配不消费草稿', async () => {
  for (const mismatch of [{ sessionKey: 'other' }, { operationId: 'other' }, { draftVersion: 999 }, { status: 'completed', text: '' }, { accepted: 'yes' }, { status: 'invented' }]) {
    const app = await fixture({ async submit(request) { return ok(job(request, mismatch)) } }); await app.quick.send(app.id)
    assert.equal(app.quick.getRecords(app.id)[0].status, 'unknown')
    assert.equal(app.store.getSession(app.id).input, '合成原文')
    assert.equal(app.quick.isBusy(app.id), true)
    app.close()
  }
})

test('成功结果仅到原会话；切换不会串结果且不写当前会话草稿', async () => {
  const app = await fixture(); const second = await app.store.createSessionAsync('owner-a')
  app.store.openSession('owner-a', app.id); await app.quick.send(app.id)
  app.store.openSession('owner-a', second.id); app.store.updateSession(second.id, { input: '第二会话' })
  app.quick.getRecords(app.id)[0].status = 'unknown'; app.quick.query(app.quick.getRecords(app.id)[0]); await tick()
  assert.equal(app.quick.getRecords(app.id)[0].status, 'completed')
  assert.equal(app.quick.getRecords(second.id).length, 0); assert.equal(app.store.getSession(second.id).input, '第二会话')
  app.close()
})

test('执行失败恢复被消费原文；失败的晚到结果不覆盖新编辑', async () => {
  const app = await fixture({ async status(request) { return ok(job(app.calls.submit[0], { status: 'failed', error: { code: 'incomplete_result', message: '合成流缺少终止' }, text: '部分输出' })) } })
  await app.quick.send(app.id)
  app.quick.getRecords(app.id)[0].status = 'unknown'; app.quick.query(app.quick.getRecords(app.id)[0]); await tick()
  assert.equal(app.store.getSession(app.id).input, '合成原文'); assert.equal(app.quick.getRecords(app.id)[0].status, 'failed'); app.close()
  const edited = await fixture({ async status() { return ok(job(edited.calls.submit[0], { status: 'failed' })) } })
  await edited.quick.send(edited.id); edited.store.updateSession(edited.id, { input: '后续草稿' })
  edited.quick.getRecords(edited.id)[0].status = 'unknown'; edited.quick.query(edited.quick.getRecords(edited.id)[0]); await tick()
  assert.equal(edited.store.getSession(edited.id).input, '后续草稿'); edited.close()
})

test('submit超时保持未知，不能再次发送；显式查询沿原身份读取且不重复submit', async () => {
  const hold = deferred()
  const app = await fixture({ async submit(request) { app.calls.submit.push(request); return hold.promise } })
  await app.quick.send(app.id)
  assert.equal(app.quick.getRecords(app.id)[0].status, 'unknown'); assert.equal(app.quick.isBusy(app.id), true)
  await app.quick.send(app.id); assert.equal(app.calls.submit.length, 1)
  app.port.status = async request => { app.calls.status.push(request); return ok(job(app.calls.submit[0], { status: 'completed', text: '查询获得译文' })) }
  app.quick.query(app.quick.getRecords(app.id)[0]); await tick()
  assert.deepEqual(app.calls.status[0], { sessionKey: app.calls.submit[0].sessionKey, operationId: app.calls.submit[0].operationId })
  assert.equal(app.quick.getRecords(app.id)[0].status, 'completed'); assert.equal(app.calls.submit.length, 1)
  hold.resolve(ok(job(app.calls.submit[0]))); app.close()
})

test('reset保持未结算身份且阻止再次发送；查询不open新Host会话', async () => {
  const app = await fixture(); await app.quick.send(app.id); app.quick.reset(); await app.quick.load()
  assert.equal(app.quick.isBusy(app.id), true); await app.quick.send(app.id)
  assert.equal(app.calls.submit.length, 1); assert.equal(app.calls.open.length, 1)
  app.quick.query(app.quick.getRecords(app.id)[0]); await tick()
  assert.equal(app.calls.open.length, 1); assert.equal(app.calls.submit.length, 1); assert.equal(app.quick.getRecords(app.id)[0].status, 'completed')
  app.close()
})

test('cancel未知仍锁住发送直到Host确认；取消期间新草稿保留', async () => {
  const app = await fixture({ async cancel(request) { app.calls.cancel.push(request); return ok(job(app.calls.submit[0], { status: 'unknown' })) } })
  await app.quick.send(app.id); app.quick.cancel(app.id); await tick()
  app.store.updateSession(app.id, { input: '取消期间新稿' }); await app.quick.send(app.id)
  assert.equal(app.calls.submit.length, 1); assert.equal(app.quick.getRecords(app.id)[0].status, 'unknown')
  app.port.status = async () => ok(job(app.calls.submit[0], { status: 'cancelled' }))
  app.quick.query(app.quick.getRecords(app.id)[0]); await tick()
  assert.equal(app.quick.isBusy(app.id), false); assert.equal(app.store.getSession(app.id).input, '取消期间新稿'); app.close()
})

test('取消先于open回执不发模型请求；取消先于submit回执不接受迟到译文', async () => {
  const hold = deferred()
  const app = await fixture({ async open(request) { app.calls.open.push(request); return hold.promise } })
  const sending = app.quick.send(app.id); app.quick.cancel(app.id)
  hold.resolve(ok({ sessionKey: 'host-one', ...app.calls.open[0] })); await sending
  assert.equal(app.calls.submit.length, 0); assert.equal(app.quick.getRecords(app.id)[0].status, 'cancelled'); app.close()
  const submitted = deferred()
  const late = await fixture({ async submit(request) { late.calls.submit.push(request); return submitted.promise }, async cancel(request) { late.calls.cancel.push(request); return ok({ ...request, draftVersion: 0, accepted: false, status: 'cancelled', text: '' }) } })
  const sendingLate = late.quick.send(late.id); await tick(); late.quick.cancel(late.id); await tick()
  submitted.resolve(ok(job(late.calls.submit[0], { status: 'completed', text: '迟到译文' }))); await sendingLate
  assert.equal(late.quick.getRecords(late.id)[0].status, 'cancelled'); assert.equal(late.quick.getRecords(late.id)[0].text, '')
  assert.equal(late.store.getSession(late.id).input, '合成原文'); late.close()
})

test('删除清运行期并请求取消；归档保留原文与结果身份，迟到结果不复活已删会话', async () => {
  const app = await fixture(); await app.quick.send(app.id)
  app.store.archiveSession('owner-a', app.id, true); await tick()
  assert.equal(app.quick.getRecords(app.id)[0].status, 'cancelled'); assert.equal(app.calls.cancel.length, 1)
  await app.store.deleteHistoryAsync([app.id], false, [], app.store.captureHistoryVersions([app.id]))
  assert.equal(app.quick.getRecords(app.id).length, 0); app.close()
  const hold = deferred()
  const late = await fixture({ async submit(request) { late.calls.submit.push(request); return hold.promise } })
  const sending = late.quick.send(late.id); await tick()
  await late.store.deleteHistoryAsync([late.id], false, [], late.store.captureHistoryVersions([late.id]))
  hold.resolve(ok(job(late.calls.submit[0], { status: 'completed', text: '迟到译文' }))); await sending
  assert.equal(late.quick.getRecords(late.id).length, 0); assert.equal(late.store.getSession(late.id), undefined)
  assert.equal(late.calls.cancel.length, 1)
  late.close()
})

test('归档unknown也请求取消，普通编辑通知不会重复取消；恢复归档仍等待Host终态', async () => {
  const app = await fixture({ async cancel(request) { app.calls.cancel.push(request); return ok(job(app.calls.submit[0], { status: 'unknown' })) } })
  await app.quick.send(app.id); app.quick.reset()
  app.store.archiveSession('owner-a', app.id, true); await tick()
  assert.equal(app.calls.cancel.length, 1); assert.equal(app.quick.isBusy(app.id), true)
  app.store.updateSession(app.id, { remark: 'Synthetic remark' }); await tick()
  assert.equal(app.calls.cancel.length, 1)
  app.store.archiveSession('owner-a', app.id, false); await app.quick.load()
  app.store.updateSession(app.id, { input: '恢复后新稿' }); await app.quick.send(app.id)
  assert.equal(app.calls.submit.length, 1)
  app.port.status = async () => ok(job(app.calls.submit[0], { status: 'cancelled' }))
  app.quick.query(app.quick.getRecords(app.id)[0]); await tick()
  assert.equal(app.quick.isBusy(app.id), false); assert.equal(app.store.getSession(app.id).input, '恢复后新稿')
  app.close()
})
