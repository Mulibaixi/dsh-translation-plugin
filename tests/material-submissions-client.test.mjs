import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionStore } from '../dist/client/session-store.js'
import { MaterialSubmissionsClient } from '../dist/client/material-submissions.js'
const tick = () => new Promise(resolve => setImmediate(resolve))
const ok = value => ({ ok: true, value: { ok: true, value } })
const bad = (code, message) => ({ ok: true, value: { ok: false, error: { code, message, stage: 'prepare' } } })
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function receipt(request, stage = 'prepared') {
  const { ownerId, mainSessionId, requestId, operationId, kind } = request
  return { ownerId, mainSessionId, requestId, operationId, kind, stage }
}
async function fixture(overrides = {}) {
  const store = new SessionStore(), session = store.createSession('synthetic-main')
  store.updateSession(session.id, { mode: 'normal', input: 'A', instruction: 'Discuss material', model: null })
  const references = new Map(), calls = { prepare: [], finish: [], submit: [], query: [] }, captured = []
  const topics = { getStatus() { return overrides.topicStatus ?? { ready: true } }, subscribe() { return () => {} }, retain(owner) {
    references.set(owner, (references.get(owner) ?? 0) + 1)
    return () => references.set(owner, references.get(owner) - 1)
  } }
  const domain = {
    async capabilities() { return ok({ ready: true, directSubmit: true, storage: 'runtime_only' }) },
    async prepare(request) { calls.prepare.push(structuredClone(request)); return ok(receipt(request)) },
    async finish(request) { calls.finish.push(structuredClone(request)); assert.ok(references.get(request.ownerId) > 0); return ok(receipt({ ...request, kind: calls.prepare.find(item => item.requestId === request.requestId && item.ownerId === request.ownerId)?.kind ?? 'material' }, request.outcome === 'submitted' ? 'submitted' : request.outcome === 'unknown' ? 'unknown' : 'released')) },
    async submit(request) { calls.submit.push(structuredClone(request)); return ok(receipt(request, 'submitted')) },
    async query(request) { calls.query.push(structuredClone(request)); return ok(null) },
    ...overrides.remote,
  }
  const registry = overrides.noRegistry ? undefined : { register(owner, contribution) { assert.equal(owner, 'synthetic-root'); captured.push(contribution); return () => {} } }
  const client = new MaterialSubmissionsClient({ store, topics, remote: domain, owner: 'synthetic-root', registry })
  await client.load()
  const freeze = (requestId = 'synthetic-request', ownerId = session.ownerId) => captured[0].freeze({ sessionId: ownerId, requestId, mode: 'queue', timestamp: 0, draftRev: 1, source: 'click' })
  return { store, session, client, calls, references, domain, freeze, close() { client.dispose(); store.dispose() } }
}

test('root同步freeze绑定A及旧topic/session，编辑B和切换不会串稿；同scope重复prepare仅一次', async () => {
  const f = await fixture()
  try {
    const contribution = f.freeze(), duplicate = f.freeze()
    f.store.updateSession(f.session.id, { input: 'B', instruction: 'new instruction' })
    const other = f.store.createSession(f.session.ownerId)
    f.store.updateSession(other.id, { mode: 'normal', input: 'OTHER' })
    await Promise.all([contribution.prepare(new AbortController().signal), duplicate.prepare(new AbortController().signal)])
    assert.equal(f.calls.prepare.length, 1)
    const frozen = f.calls.prepare[0]
    assert.equal(frozen.material.sourceText, 'A'); assert.equal(frozen.material.instruction, 'Discuss material')
    assert.equal(frozen.material.translationSessionId, f.session.id); assert.equal(frozen.material.topicId, f.session.topicId)
    assert.equal(frozen.material.model, null)
    contribution.finish('accepted'); duplicate.finish('accepted'); await tick()
    assert.equal(f.calls.finish.length, 1); assert.equal(f.store.getSession(f.session.id).input, 'B')
    assert.match(f.client.getStatus(f.session.id).message, /已提交的是草稿版本.*当前草稿/)
  } finally { f.close() }
})

test('桥lease不依赖面板和rememberHistory；prepare ACK及finish RPC完成前不释放', async () => {
  const prepareGate = deferred(), finishGate = deferred()
  const f = await fixture()
  try {
    assert.equal(f.store.getSettings().rememberHistory, false); assert.equal(f.references.get(f.session.ownerId), 1)
    f.domain.prepare = async request => { f.calls.prepare.push(request); await prepareGate.promise; return ok(receipt(request)) }
    f.domain.finish = async request => { f.calls.finish.push(request); assert.equal(f.references.get(request.ownerId), 1); await finishGate.promise; return ok(receipt({ ...request, kind: 'material' }, 'released')) }
    const contribution = f.freeze(), controller = new AbortController()
    const preparing = contribution.prepare(controller.signal).catch(error => error)
    f.store.updateSession(f.session.id, { input: '' }); controller.abort(); contribution.finish('cancelled')
    await tick(); assert.equal(f.calls.finish.length, 0); assert.equal(f.references.get(f.session.ownerId), 1)
    prepareGate.resolve(); await preparing; await tick()
    assert.equal(f.calls.finish.length, 1); assert.equal(f.references.get(f.session.ownerId), 1)
    finishGate.resolve(); await tick(); assert.equal(f.references.get(f.session.ownerId), 0)
  } finally { prepareGate.resolve(); finishGate.resolve(); f.close() }
})

for (const outcome of ['accepted', 'failed']) test(`无面板${outcome}结算保留lease直到Host回执`, async () => {
  const gate = deferred(), f = await fixture()
  try {
    f.domain.finish = async request => { f.calls.finish.push(request); assert.equal(f.references.get(request.ownerId), 1); await gate.promise; return ok(receipt({ ...request, kind: 'material' }, outcome === 'accepted' ? 'submitted' : 'released')) }
    const contribution = f.freeze(); await contribution.prepare(new AbortController().signal)
    f.store.updateSession(f.session.id, { input: '' }); contribution.finish(outcome); await tick()
    assert.equal(f.references.get(f.session.ownerId), 1)
    gate.resolve(); await tick(); assert.equal(f.references.get(f.session.ownerId), outcome === 'accepted' ? 1 : 0)
    if (outcome === 'accepted') {
      const envelope = f.calls.prepare[0]
      assert.ok(f.client.resolveSubmittedMaterial(envelope), 'submitted material remains available to business admission')
      f.client.consumeSubmittedMaterial(envelope); assert.equal(f.references.get(f.session.ownerId), 0)
    }
  } finally { gate.resolve(); f.close() }
})

test('一次omit只消费本次发送；老gesture失败不会覆盖其后的显式恢复附带', async () => {
  const f = await fixture()
  try {
    f.client.setOmit(f.session.ownerId, true)
    const first = f.freeze('omit-first'); await first.prepare(new AbortController().signal)
    assert.equal(f.calls.prepare[0].kind, 'omit'); assert.equal(f.client.getAttachment(f.session.ownerId).omitted, false)
    f.client.setOmit(f.session.ownerId, false); first.finish('failed'); await tick()
    assert.equal(f.client.getAttachment(f.session.ownerId).omitted, false)
    f.client.setOmit(f.session.ownerId, true)
    const retry = f.freeze('omit-second'); retry.finish('handled')
    assert.equal(f.client.getAttachment(f.session.ownerId).omitted, true)
  } finally { f.close() }
})

test('File根标记拒绝native与direct；omit允许无关主发送并保留文本', async () => {
  const f = await fixture()
  try {
    f.client.setFileSelected(f.session.id, true)
    assert.match(f.client.getStatus(f.session.id).blocked, /文件材料尚未接入/)
    await assert.rejects(f.freeze('file').prepare(new AbortController().signal), /文件材料尚未接入/)
    await f.client.send(f.session.id); assert.equal(f.calls.submit.length, 0)
    f.client.setOmit(f.session.ownerId, true)
    const omit = f.freeze('file-omit'); await omit.prepare(new AbortController().signal); omit.finish('accepted'); await tick()
    assert.equal(f.calls.prepare[0].kind, 'omit'); assert.equal(f.store.getSession(f.session.id).input, 'A')
    f.client.setFileSelected(f.session.id, false)
    await f.client.send(f.session.id); assert.equal(f.calls.submit.length, 1)
  } finally { f.close() }
})

test('材料UTF8预检不会截断大中文正文；omit仍可prepare，快译与未关联owner不附带', async () => {
  const f = await fixture()
  try {
    f.store.updateSession(f.session.id, { maxInputChars: 200000, input: '源'.repeat(70000) })
    assert.match(f.client.getStatus(f.session.id).blocked, /196608 字节/)
    await assert.rejects(f.freeze('huge').prepare(new AbortController().signal), /传输上限/)
    await f.client.send(f.session.id); assert.equal(f.calls.submit.length, 0)
    assert.equal(f.store.getSession(f.session.id).input.length, 70000)
    f.client.setOmit(f.session.ownerId, true); const omit = f.freeze('huge-omit'); await omit.prepare(new AbortController().signal); omit.finish('accepted'); await tick()
    assert.equal(f.calls.prepare[0].kind, 'omit')
    const quick = f.store.createSession(f.session.ownerId); const none = f.freeze('quick-none'); await none.prepare(new AbortController().signal); none.finish('accepted'); await tick()
    assert.equal(f.calls.prepare[1].kind, 'none'); assert.equal(f.freeze('other-owner', 'unassociated'), undefined)
  } finally { f.close() }
})

test('相同requestId在不同owner独立冻结；官方缺seam精准不可用且不调用submit', async () => {
  const f = await fixture(), old = await fixture({ noRegistry: true })
  try {
    const other = f.store.createSession('synthetic-other'); f.store.updateSession(other.id, { mode: 'normal', input: 'OTHER' })
    const a = f.freeze('same-id'), b = f.freeze('same-id', other.ownerId)
    await a.prepare(new AbortController().signal); await b.prepare(new AbortController().signal)
    assert.equal(f.calls.prepare.length, 2); assert.equal(f.calls.prepare[1].material.sourceText, 'OTHER')
    a.finish('accepted'); b.finish('accepted'); await tick()
    assert.match(old.client.getStatus(old.session.id).blocked, /当前 DSH 缺少同步发送材料接口/)
    await old.client.send(old.session.id); assert.equal(old.calls.submit.length, 0)
  } finally { f.close(); old.close() }
})

test('direct无模型合法提交A一次，编辑B保留；丢回执保持unknown且按原scope查询', async () => {
  const gate = deferred(), f = await fixture()
  try {
    f.domain.submit = async request => { f.calls.submit.push(structuredClone(request)); await gate.promise; return ok(receipt(request, 'submitted')) }
    const sending = f.client.send(f.session.id)
    f.store.updateSession(f.session.id, { input: 'B' }); await f.client.send(f.session.id)
    gate.resolve(); await sending
    assert.equal(f.calls.submit.length, 1); assert.equal(f.calls.submit[0].material.sourceText, 'A'); assert.equal(f.calls.submit[0].material.model, null)
    assert.equal(f.store.getSession(f.session.id).input, 'B'); assert.match(f.client.getStatus(f.session.id).message, /当前草稿/)
    f.domain.submit = async request => { f.calls.submit.push(request); throw new Error('transport lost') }
    await f.client.send(f.session.id); assert.equal(f.client.getStatus(f.session.id).unknown, true)
    await f.client.send(f.session.id); assert.equal(f.calls.submit.length, 2)
    const original = f.calls.submit[1]
    f.domain.query = async request => { f.calls.query.push(request); return ok({ receipt: receipt(original, 'prepared'), snapshot: original }) }
    await f.client.query(f.session.id); assert.equal(f.client.getStatus(f.session.id).unknown, true)
    f.domain.query = async request => { f.calls.query.push(request); return ok({ receipt: receipt(original, 'attached'), snapshot: original }) }
    await f.client.query(f.session.id); assert.equal(f.client.getStatus(f.session.id).unknown, false)
    assert.equal(f.calls.query[1].requestId, original.requestId); assert.equal(f.calls.query[1].operationId, original.operationId)
  } finally { gate.resolve(); f.close() }
})

test('typed prepare拒绝不放行prompt；failed cleanup not_found不误写提交成功', async () => {
  const f = await fixture({ remote: { async prepare() { return bad('scope_mismatch', 'owner connection occupied') }, async finish() { return bad('not_found', 'no material prepared') } } })
  try {
    const contribution = f.freeze(); await assert.rejects(contribution.prepare(new AbortController().signal), /owner connection occupied/)
    contribution.finish('failed'); await tick()
    assert.equal(f.client.getStatus(f.session.id).unknown, false); assert.match(f.client.getStatus(f.session.id).message, /owner connection occupied/)
    assert.equal(f.store.getSession(f.session.id).input, 'A')
  } finally { f.close() }
})
