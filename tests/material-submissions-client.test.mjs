import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionStore } from '../dist/client/session-store.js'
import { MaterialSubmissionsClient } from '../dist/client/material-submissions.js'
import { adaptTranslationSourcesRemote } from '../dist/client/sources-client.js'
const tick = () => new Promise(resolve => setImmediate(resolve))
const ok = value => ({ ok: true, value: { ok: true, value } })
const bad = (code, message) => ({ ok: true, value: { ok: false, error: { code, message, stage: 'prepare' } } })
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function receipt(request, stage = 'prepared') {
  const { ownerId, mainSessionId, requestId, operationId, kind } = request
  return { ownerId, mainSessionId, requestId, operationId, kind, stage }
}
const sourceCapability = { ready: true, storage: 'runtime_only', encoding: 'utf-8', maxBytes: 2 * 1024 * 1024, maxPageCodePoints: 4000, maxPageBytes: 32768 }
function sourceAsset(file) { return { sourceId: 'source-11111111-1111-1111-1111-111111111111', version: 1, name: file.name, bytes: file.size,
  totalCodePoints: file.size, encoding: 'utf-8', bom: false, sha256: 'a'.repeat(64), persistence: 'runtime_only' } }
async function fixture(overrides = {}) {
  const store = new SessionStore(), session = store.createSession('synthetic-main')
  store.updateSession(session.id, { mode: 'normal', input: 'A', instruction: 'Discuss material', model: null })
  const references = new Map(), calls = { prepare: [], finish: [], submit: [], query: [], upload: [], import: [] }, captured = []
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
  const upload = { async upload(ownerId, file, name, signal) { calls.upload.push({ ownerId, file, name, signal }); return { ok: true, value: { receiptId: 'native-receipt' } } }, ...overrides.upload }
  const sources = { async capabilities() { return ok(sourceCapability) }, async importReceipt(request, signal) {
    calls.import.push({ ...structuredClone(request), signal }); return ok(sourceAsset(calls.upload.at(-1).file))
  }, ...overrides.sources }
  const client = new MaterialSubmissionsClient({ store, topics, remote: domain, owner: 'synthetic-root', registry, upload,
    sources: adaptTranslationSourcesRemote(sources) })
  await client.load()
  const freeze = (requestId = 'synthetic-request', ownerId = session.ownerId) => captured[0].freeze({ sessionId: ownerId, requestId, mode: 'queue', timestamp: 0, draftRev: 1, source: 'click' })
  return { store, session, client, calls, references, topics, domain, sources, upload, freeze, close() { client.dispose(); store.dispose() } }
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
    await tick(); assert.equal(f.calls.prepare.length, 1)
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

test('File与原文同时非空拒绝native与direct；omit不上传并保留二者', async () => {
  const f = await fixture()
  try {
    const file = new File(['Source'], 'synthetic.txt')
    f.client.setFileSelected(f.session.id, file)
    assert.match(f.client.getStatus(f.session.id).blocked, /原文与 TXT 请选择一种/)
    await assert.rejects(f.freeze('file').prepare(new AbortController().signal), /原文与 TXT 请选择一种/)
    await f.client.send(f.session.id); assert.equal(f.calls.submit.length, 0)
    f.client.setOmit(f.session.ownerId, true)
    const omit = f.freeze('file-omit'); await omit.prepare(new AbortController().signal); omit.finish('accepted'); await tick()
    assert.equal(f.calls.prepare[0].kind, 'omit'); assert.equal(f.store.getSession(f.session.id).input, 'A')
    assert.equal(f.calls.upload.length, 0); assert.equal(f.calls.import.length, 0); assert.equal(f.client.getSelectedFile(f.session.id), file)
    f.client.setFileSelected(f.session.id, undefined)
    await f.client.send(f.session.id); assert.equal(f.calls.submit.length, 1)
  } finally { f.close() }
})

test('TXT同步freeze固定File A、全部配置与归属；同request只上传导入准备一次，新稿B不消费', async () => {
  const f = await fixture()
  try {
    const fileA = new File(['A'.repeat(30000)], 'frozen-a.txt'), fileB = new File(['B'], 'new-b.txt')
    for (const method of ['text', 'arrayBuffer', 'stream']) fileA[method] = () => assert.fail('Client must only pass File to native upload')
    f.store.updateSession(f.session.id, { input: '', targetLanguage: 'English', maxInputChars: 100, model: { provider: 'p', model: 'm' } })
    f.client.setFileSelected(f.session.id, fileA)
    const first = f.freeze('fixed-file'), duplicate = f.freeze('fixed-file')
    f.client.setFileSelected(f.session.id, fileB)
    f.store.updateSession(f.session.id, { input: 'new draft B', targetLanguage: '日本語', instruction: 'new requirement', maxInputChars: 200 })
    const other = f.store.createSession(f.session.ownerId); f.store.updateSession(other.id, { mode: 'normal', input: 'OTHER' })
    await Promise.all([first.prepare(new AbortController().signal), duplicate.prepare(new AbortController().signal)])
    assert.equal(f.calls.upload.length, 1); assert.equal(f.calls.upload[0].file, fileA); assert.equal(f.calls.upload[0].name, fileA.name)
    assert.equal(f.calls.import.length, 1); assert.equal(f.calls.prepare.length, 1)
    const envelope = f.calls.prepare[0], material = envelope.material
    assert.equal(material.translationSessionId, f.session.id); assert.equal(material.topicId, f.session.topicId)
    assert.equal(material.sourceText, undefined); assert.equal(Object.hasOwn(material, 'sourceText'), false)
    assert.deepEqual(material.sourceRef, sourceAsset(fileA)); assert.equal(material.targetLanguage, 'English'); assert.equal(material.instruction, 'Discuss material')
    assert.deepEqual(material.model, { provider: 'p', model: 'm' }); assert.equal(material.maxInputChars, 100)
    assert.equal(f.calls.import[0].idempotencyKey, material.materialId)
    assert.deepEqual(f.calls.import[0].scope, { ownerId: f.session.ownerId, mainSessionId: f.session.ownerId, topicId: f.session.topicId, translationSessionId: f.session.id })
    first.finish('accepted'); duplicate.finish('accepted'); await tick()
    assert.equal(f.calls.finish.length, 1)
    f.client.consumeSubmittedMaterial(envelope)
    assert.equal(f.client.getSelectedFile(f.session.id), fileB); assert.equal(f.store.getSession(f.session.id).input, 'new draft B')
    assert.equal(f.store.getTranslationHistory(f.session.id)?.units.length ?? 0, 0)
  } finally { f.close() }
})

test('文件选择A→B→A仍是新草稿；关闭面板清选择不丢已冻结File', async () => {
  const f = await fixture()
  try {
    f.store.updateSession(f.session.id, { input: '' })
    const fileA = new File(['A'], 'a.txt'), fileB = new File(['B'], 'b.txt')
    f.client.setFileSelected(f.session.id, fileA); const first = f.freeze('aba-old')
    f.client.setFileSelected(f.session.id, fileB); f.client.setFileSelected(f.session.id, fileA)
    await first.prepare(new AbortController().signal); first.finish('accepted'); await tick()
    assert.match(f.client.getStatus(f.session.id).message, /已提交的是草稿版本.*当前草稿/)
    const later = f.freeze('panel-close'); f.client.clearSelectedFiles(f.session.ownerId)
    assert.equal(f.client.getSelectedFile(f.session.id), undefined)
    await later.prepare(new AbortController().signal); later.finish('accepted'); await tick()
    assert.equal(f.calls.upload[1].file, fileA); assert.ok(f.references.get(f.session.ownerId) > 0)
    assert.ok(f.calls.prepare[1].material.draftVersion > f.calls.prepare[0].material.draftVersion)
  } finally { f.close() }
})

test('TXT direct固定F沿upload/import/submit一次；丢回执只查原请求，不重传', async () => {
  const gate = deferred(), f = await fixture()
  try {
    f.store.updateSession(f.session.id, { input: '' }); const file = new File(['F'], 'direct.txt')
    f.client.setFileSelected(f.session.id, file)
    f.upload.upload = async (ownerId, frozen, name, signal) => { f.calls.upload.push({ ownerId, file: frozen, name, signal }); await gate.promise; return { ok: true, value: { receiptId: 'direct-native' } } }
    const pending = f.client.send(f.session.id); await f.client.send(f.session.id)
    f.client.setFileSelected(f.session.id, new File(['B'], 'b.txt')); gate.resolve(); await pending
    assert.equal(f.calls.upload.length, 1); assert.equal(f.calls.upload[0].file, file); assert.equal(f.calls.import.length, 1)
    assert.equal(f.calls.submit.length, 1); assert.deepEqual(f.calls.submit[0].material.sourceRef, sourceAsset(file)); assert.equal(f.calls.prepare.length, 0)
    f.domain.submit = async request => { f.calls.submit.push(request); throw new Error('lost material ACK') }
    await f.client.send(f.session.id); const original = f.calls.submit[1]
    assert.equal(f.client.getStatus(f.session.id).unknown, true)
    await f.client.send(f.session.id); await f.client.query(f.session.id)
    assert.equal(f.calls.upload.length, 2); assert.equal(f.calls.import.length, 2); assert.equal(f.calls.submit.length, 2)
    assert.equal(f.calls.query[0].requestId, original.requestId); assert.equal(f.calls.query[0].operationId, original.operationId)
  } finally { gate.resolve(); f.close() }
})

test('TXT导入明确失败保留File与后来正文，prepare失败不会先发材料', async () => {
  const f = await fixture({ sources: { async importReceipt() { return { ok: true, value: { ok: false, error: { code: 'invalid_utf8', message: 'TXT 不是有效 UTF-8', stage: 'decode' } } } } } })
  try {
    f.store.updateSession(f.session.id, { input: '' }); const file = new File(['F'], 'bad.txt'); f.client.setFileSelected(f.session.id, file)
    const contribution = f.freeze('bad-file'); f.store.updateSession(f.session.id, { input: 'B' })
    await assert.rejects(contribution.prepare(new AbortController().signal), /不是有效 UTF-8/)
    contribution.finish('failed'); await tick()
    assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.submit.length, 0)
    assert.equal(f.client.getSelectedFile(f.session.id), file); assert.equal(f.store.getSession(f.session.id).input, 'B')
  } finally { f.close() }
})

test('TXT upload/import传输失败尚未派发材料可用新请求重试，同request不重复上传', async () => {
  const f = await fixture()
  try {
    f.store.updateSession(f.session.id, { input: '' }); const file = new File(['F'], 'retry.txt'); f.client.setFileSelected(f.session.id, file)
    const importReceipt = f.sources.importReceipt
    f.sources.importReceipt = async () => { throw new Error('source connection interrupted') }
    const contribution = f.freeze('import-failure'), duplicate = f.freeze('import-failure')
    await assert.rejects(contribution.prepare(new AbortController().signal), /source connection interrupted/)
    await assert.rejects(duplicate.prepare(new AbortController().signal), /source connection interrupted/)
    contribution.finish('failed'); await tick()
    assert.equal(f.calls.upload.length, 1); assert.equal(f.calls.prepare.length, 0); assert.equal(f.client.getStatus(f.session.id).unknown, false)
    assert.equal(f.client.getStatus(f.session.id).blocked, undefined); assert.equal(f.client.getSelectedFile(f.session.id), file)
    f.sources.importReceipt = importReceipt
    await f.client.send(f.session.id)
    assert.equal(f.calls.upload.length, 2); assert.equal(f.calls.import.length, 1); assert.equal(f.calls.submit.length, 1)
    assert.equal(f.calls.query.length, 0)
  } finally { f.close() }
})

test('TXT material submit已派发后reset且ACK丢失保持unknown，只查询同请求', async () => {
  const gate = deferred(), f = await fixture()
  try {
    f.store.updateSession(f.session.id, { input: '' }); const file = new File(['F'], 'dispatched.txt'); f.client.setFileSelected(f.session.id, file)
    f.domain.submit = async request => { f.calls.submit.push(request); await gate.promise; throw new Error('material ACK lost') }
    const pending = f.client.send(f.session.id); await tick()
    assert.equal(f.calls.submit.length, 1); const original = f.calls.submit[0]
    f.client.reset(); gate.resolve(); await pending
    assert.equal(f.client.getStatus(f.session.id).unknown, true)
    await f.client.send(f.session.id); await f.client.query(f.session.id)
    assert.equal(f.calls.upload.length, 1); assert.equal(f.calls.import.length, 1); assert.equal(f.calls.submit.length, 1)
    assert.equal(f.calls.query[0].requestId, original.requestId); assert.equal(f.client.getSelectedFile(f.session.id), file)
  } finally { gate.resolve(); f.close() }
})

test('TXT material prepare已派发后取消且prepare/cleanup ACK丢失保持unknown', async () => {
  const gate = deferred(), f = await fixture()
  try {
    f.store.updateSession(f.session.id, { input: '' }); f.client.setFileSelected(f.session.id, new File(['F'], 'dispatched.txt'))
    f.domain.prepare = async request => { f.calls.prepare.push(request); await gate.promise; throw new Error('prepare ACK lost') }
    f.domain.finish = async request => { f.calls.finish.push(request); throw new Error('cleanup ACK lost') }
    const contribution = f.freeze('dispatched-cancel'), controller = new AbortController(), pending = contribution.prepare(controller.signal).catch(error => error)
    await tick(); assert.equal(f.calls.prepare.length, 1); controller.abort(); contribution.finish('cancelled')
    gate.resolve(); await pending; await tick()
    assert.equal(f.client.getStatus(f.session.id).unknown, true); await f.client.query(f.session.id)
    assert.equal(f.calls.upload.length, 1); assert.equal(f.calls.import.length, 1); assert.equal(f.calls.prepare.length, 1)
    assert.equal(f.calls.query[0].requestId, 'dispatched-cancel')
  } finally { gate.resolve(); f.close() }
})

for (const action of ['cancel', 'reset', 'dispose']) test(`TXT上传等待期间${action}不会在晚到回执后导入或发送`, async () => {
  const gate = deferred(), f = await fixture()
  try {
    f.store.updateSession(f.session.id, { input: '' }); const file = new File(['F'], 'cancel.txt'); f.client.setFileSelected(f.session.id, file)
    f.upload.upload = async () => { await gate.promise; return { ok: true, value: { receiptId: 'late' } } }
    const contribution = f.freeze('late-file'), controller = new AbortController()
    const pending = contribution.prepare(controller.signal).catch(error => error)
    if (action === 'cancel') { controller.abort(); contribution.finish('cancelled') }
    else f.client[action]()
    gate.resolve(); assert.match((await pending).message, /取消/); await tick()
    assert.equal(f.calls.import.length, 0); assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.submit.length, 0)
    if (action !== 'dispose') assert.equal(f.client.getSelectedFile(f.session.id), file)
  } finally { gate.resolve(); f.close() }
})

test('TXT输入限制独立于单次模型上限，扩展名/2MiB会在上传前明确阻止', async () => {
  const f = await fixture()
  try {
    f.store.updateSession(f.session.id, { input: '', maxInputChars: 1 })
    f.client.setFileSelected(f.session.id, new File(['Valid source'], 'ok.TXT')); assert.equal(f.client.getStatus(f.session.id).blocked, undefined)
    f.client.setFileSelected(f.session.id, new File(['F'], 'not.pdf')); assert.match(f.client.getStatus(f.session.id).blocked, /\.txt 文件/)
    f.client.setFileSelected(f.session.id, new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.txt')); assert.match(f.client.getStatus(f.session.id).blocked, /2 MiB/)
    await assert.rejects(f.freeze('oversize-file').prepare(new AbortController().signal), /2 MiB/)
    assert.equal(f.calls.upload.length, 0)
  } finally { f.close() }
})

test('direct冻结后readiness变化明确failed，不停在frozen busy', async () => {
  const f = await fixture()
  try {
    let checks = 0
    f.topics.getStatus = () => ++checks === 1 ? { ready: true } : { ready: false, reason: 'connection interrupted before dispatch' }
    await f.client.send(f.session.id)
    assert.equal(f.client.getStatus(f.session.id).busy, false); assert.equal(f.client.getStatus(f.session.id).unknown, false)
    assert.match(f.client.getStatus(f.session.id).message, /before dispatch/); assert.equal(f.calls.submit.length, 0)
    f.topics.getStatus = () => ({ ready: true }); await f.client.send(f.session.id); assert.equal(f.calls.submit.length, 1)
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
