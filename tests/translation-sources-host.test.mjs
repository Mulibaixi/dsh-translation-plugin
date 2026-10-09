import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { TranslationSourcesService, installTranslationSources } from '../dist/host/translation-sources.js'
import { MAX_TRANSLATION_SOURCE_BYTES, TRANSLATION_SOURCES_REMOTE, parseTranslationSourceRequest,
  parseTranslationSourceResult, translationSourceResultBytes } from '../dist/shared/translation-sources.js'

const scope = { ownerId: 'main-source', mainSessionId: 'main-source', topicId: 'topic-source', translationSessionId: 'translation-source' }
const signal = () => new AbortController().signal
function value(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.value }
function read(source, range, sourceScope = scope) { return { scope: sourceScope, sourceId: source.sourceId, version: source.version, range } }
function fixture(sourceScope = scope) {
  const receipts = new Map(), state = { connected: true, peerId: 'source-peer', reads: 0, chunkSize: 2, tail: undefined, chunk: undefined }
  const agent = { id: sourceScope.mainSessionId, session: { id: sourceScope.mainSessionId }, ctx: {} }; state.agent = agent
  state.resolve = async () => ({ agent })
  const services = {
    agents: { get: id => id === sourceScope.mainSessionId ? state.agent : undefined },
    sessionController: { resolveAgent: (...args) => state.resolve(...args) },
    translationTopics: { ownsConnection: (ownerId, peerId) => state.connected && ownerId === sourceScope.ownerId && peerId === 'source-peer' },
    fileUploads: { resolve(exactAgent, id) { assert.equal(exactAgent, agent); return receipts.get(id)?.file } },
    attachments: { async *readFileStream(file) {
      state.reads++
      const entry = [...receipts.values()].find(item => item.file === file)
      for (let start = 0; start < entry.data.length; start += state.chunkSize) { state.chunk?.(); yield entry.data.subarray(start, start + state.chunkSize) }
      await state.tail?.()
    } },
  }
  const ctx = { get invocation() { return state.peerId ? { peer: { id: state.peerId } } : undefined }, get: name => services[name] }
  const service = new TranslationSourcesService(ctx)
  return { service, ctx, services, state, agent, receipts,
    request(receiptId = 'receipt-a', idempotencyKey = receiptId) { return { scope: sourceScope, receiptId, idempotencyKey } },
    add(id, data, patch = {}) { receipts.set(id, { data: Buffer.from(data), file: { attachmentId: `native:${id}`, name: 'synthetic.txt', bytes: data.length, ...patch } }) },
  }
}

test('固定UTF8 TXT：分片BOM/非BMP/CRLF保留；并发与重复收据复用资产，结果codec保持两层预算', async () => {
  const f = fixture(), text = '\uFEFF😀A\r\nB\u0301\nLiteral source instructions', bytes = Buffer.from(text)
  f.add('receipt-a', bytes)
  try {
    assert.equal(value(await f.service.capabilities()).maxBytes, MAX_TRANSLATION_SOURCE_BYTES)
    const [a, b] = await Promise.all([f.service.importReceipt(f.request(), signal()), f.service.importReceipt(f.request(), signal())])
    const source = value(a); assert.deepEqual(value(b), source); assert.equal(f.state.reads, 1)
    assert.equal(source.bom, true); assert.equal(source.bytes, bytes.length); assert.equal(source.totalCodePoints, [...text].length)
    assert.equal(source.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(source.persistence, 'runtime_only')
    assert.deepEqual(value(await f.service.importReceipt(f.request('receipt-a', 'retry-other-key'), signal())), source)
    f.receipts.delete('receipt-a')
    assert.deepEqual(value(await f.service.importReceipt(f.request(), signal())), source)
    const pageResult = await f.service.readRange(read(source, { start: 0, end: source.totalCodePoints }))
    assert.equal(value(pageResult).text, text); assert.equal(value(await f.service.readRange(read(source, { start: 0, end: 2 }))).text, '\uFEFF😀')
    assert.deepEqual(parseTranslationSourceResult('readRange', pageResult), pageResult)
    assert.equal(translationSourceResultBytes(pageResult), Buffer.byteLength(JSON.stringify({ ok: true, value: pageResult })))
    assert.equal((await f.service.importReceipt(f.request('different-receipt', 'receipt-a'), signal())).error.code, 'idempotency_conflict')
    assert.equal((await f.service.importReceipt({ ...f.request(), scope: { ...scope, topicId: 'different-topic' } }, signal())).error.code, 'idempotency_conflict')
  } finally { f.service.dispose() }
})

test('固定source精确scope/asset版本，4000码点及完整JSON上限拒绝越界/空/超限而不截断', async () => {
  const f = fixture(); f.add('receipt-a', Buffer.from('😀'.repeat(4100)))
  try {
    const source = value(await f.service.importReceipt(f.request(), signal()))
    const first = value(await f.service.readRange(read(source, { start: 0, end: 4000 })))
    assert.equal([...first.text].length, 4000)
    assert.equal(first.text + value(await f.service.readRange(read(source, { start: 4000, end: 4100 }))).text, '😀'.repeat(4100))
    for (const [range, code] of [[{ start: 0, end: 4001 }, 'page_too_large'], [{ start: 4100, end: 4101 }, 'range_out_of_bounds'], [{ start: 2, end: 2 }, 'invalid_range']]) {
      assert.equal((await f.service.readRange(read(source, range))).error.code, code)
    }
    for (const key of ['topicId', 'translationSessionId']) assert.equal((await f.service.readRange(read(source, { start: 0, end: 1 }, { ...scope, [key]: 'other' }))).error.code, 'not_found')
    assert.equal((await f.service.readRange(read(source, { start: 0, end: 1 }, { ...scope, ownerId: 'other', mainSessionId: 'other' }))).error.code, 'scope_mismatch')
    assert.equal((await f.service.readRange({ ...read(source, { start: 0, end: 1 }), version: 2 })).error.code, 'stale_version')
    f.state.peerId = 'other-peer'; assert.equal((await f.service.readRange(read(source, { start: 0, end: 1 }))).error.code, 'scope_mismatch')
    f.state.peerId = 'source-peer'; f.state.agent = { ...f.agent }
    assert.equal((await f.service.readRange(read(source, { start: 0, end: 1 }))).error.code, 'scope_mismatch')
  } finally { f.service.dispose() }
  const largeScope = { ownerId: '"'.repeat(1000), mainSessionId: '"'.repeat(1000), topicId: '"'.repeat(3000), translationSessionId: '"'.repeat(2048) }
  const large = fixture(largeScope); large.add('receipt-a', Buffer.from('\u0000'.repeat(4000)))
  try {
    const source = value(await large.service.importReceipt(large.request(), signal()))
    assert.equal((await large.service.readRange(read(source, { start: 0, end: 4000 }, largeScope))).error.code, 'page_too_large')
    assert.equal(value(await large.service.readRange(read(source, { start: 0, end: 1 }, largeScope))).text, '\u0000')
  } finally { large.service.dispose() }
})

test('非TXT/无效UTF8/2MiB与附件完整性失败不发布资产或改写原件，失败后只显式重试', async () => {
  const cases = [
    { data: Buffer.from('text'), patch: { name: 'synthetic.md' }, code: 'unsupported_file' },
    { data: Buffer.from([0xf0, 0x28, 0x8c, 0x28]), code: 'invalid_utf8' },
    { data: Buffer.from([0xf0, 0x9f]), code: 'invalid_utf8' },
    { data: Buffer.from('text'), patch: { bytes: MAX_TRANSLATION_SOURCE_BYTES + 1 }, code: 'source_too_large' },
    { data: Buffer.from('text'), patch: { bytes: 5 }, code: 'integrity_failed' },
    { data: Buffer.from('text'), tail: () => { throw new Error('synthetic native digest mismatch') }, code: 'integrity_failed' },
  ]
  for (const entry of cases) {
    const f = fixture(), original = Buffer.from(entry.data); f.add('receipt-a', entry.data, entry.patch); f.state.tail = entry.tail
    try {
      assert.equal((await f.service.importReceipt(f.request(), signal())).error.code, entry.code)
      assert.deepEqual(f.receipts.get('receipt-a').data, original)
      assert.equal(f.service.sources.size, 0); assert.equal(f.service.receipts.size, 0)
      f.state.tail = undefined; f.add('receipt-a', Buffer.from('valid retry'))
      assert.equal(value(await f.service.importReceipt(f.request(), signal())).bom, false)
    } finally { f.service.dispose() }
  }
  const streamed = fixture(); streamed.add('receipt-a', Buffer.alloc(MAX_TRANSLATION_SOURCE_BYTES + 1, 0x61), { bytes: MAX_TRANSLATION_SOURCE_BYTES })
  streamed.state.chunkSize = MAX_TRANSLATION_SOURCE_BYTES + 1
  try { assert.equal((await streamed.service.importReceipt(streamed.request(), signal())).error.code, 'source_too_large'); assert.equal(streamed.service.sources.size, 0) }
  finally { streamed.service.dispose() }
})

test('await后保留实际Peer；连接/Agent变更、取消和dispose禁止半成品发布；真实Controller union处理', async () => {
  const f = fixture(); f.add('receipt-a', Buffer.from('stable'))
  try {
    f.state.resolve = async () => { f.state.peerId = undefined; return { agent: f.agent } }
    const source = value(await f.service.importReceipt(f.request(), signal()))
    f.state.peerId = 'source-peer'; assert.equal(value(await f.service.readRange(read(source, { start: 0, end: 6 }))).text, 'stable')
    f.state.resolve = async () => ({ error: new Error('synthetic unavailable') })
    assert.equal((await f.service.importReceipt(f.request('receipt-other'), signal())).error.code, 'unavailable')
  } finally { f.service.dispose() }
  for (const action of ['disconnect', 'replace', 'cancel', 'dispose']) {
    const pending = fixture(), controller = new AbortController(); pending.add('receipt-a', Buffer.from('body'))
    pending.state.tail = () => {
      if (action === 'disconnect') pending.state.connected = false
      if (action === 'replace') pending.state.agent = { ...pending.agent }
      if (action === 'cancel') controller.abort()
      if (action === 'dispose') pending.service.dispose()
    }
    try {
      const operation = pending.service.importReceipt(pending.request(), controller.signal)
      if (action === 'cancel') await assert.rejects(operation, { name: 'AbortError' })
      else assert.equal((await operation).error.code, 'scope_mismatch')
      assert.equal(pending.service.sources.size, 0); assert.equal(pending.service.receipts.size, 0)
    } finally { pending.service.dispose() }
  }
})

test('严格source Remote descriptors与Host卸载沿用同一DSH生命周期', () => {
  for (const descriptor of TRANSLATION_SOURCES_REMOTE.descriptors) {
    assert.equal(descriptor.namespace, 'translationSources'); assert.equal(descriptor.result.mode, 'strict')
    assert.equal(descriptor.cancellation?.parameter, descriptor.method === 'importReceipt' ? 'signal' : undefined)
  }
  assert.throws(() => parseTranslationSourceRequest('importReceipt', { scope, receiptId: 'r', idempotencyKey: 'k', path: '/arbitrary' }))
  const f = fixture(), provided = [], contributions = [], cleanups = []
  const service = installTranslationSources({ ...f.ctx, provide: (key, value) => provided.push([key, value]),
    typert: { register: contribution => contributions.push(contribution) }, effect: effect => cleanups.push(effect()) })
  assert.equal(provided[0][0], 'translationSources'); assert.equal(contributions.length, 1)
  cleanups.forEach(cleanup => cleanup()); assert.equal(service.disposed, true)
  f.service.dispose()
})

test('in-process源引用核验复用现存资产与索引；按捕获Peer和实际Agent读取，不需要Remote invocation', async () => {
  const f = fixture(), text = '\uFEFF😀\r\nSynthetic fixed source'; f.add('receipt-a', Buffer.from(text))
  try {
    const source = value(await f.service.importReceipt(f.request(), signal()))
    assert.deepEqual(value(f.service.validateReference(scope, Object.fromEntries(Object.entries(source).reverse()), 'source-peer')), source)
    f.state.peerId = undefined
    assert.deepEqual(value(f.service.readForAgent(scope, source, { start: 0, end: 4 }, 'source-peer', f.agent)), { totalCodePoints: [...text].length, text: '\uFEFF😀\r\n' })
    assert.equal(f.state.reads, 1, 'material preparation/read does not reopen or copy the original')
    assert.equal(f.service.validateReference({ ...scope, topicId: 'other-topic' }, source, 'source-peer').error.code, 'not_found')
    assert.equal(f.service.validateReference(scope, { ...source, sha256: '0'.repeat(64) }, 'source-peer').error.code, 'integrity_failed')
    assert.equal(f.service.readForAgent(scope, source, { start: 0, end: 4 }, 'source-peer', { ...f.agent }).error.code, 'scope_mismatch')
    assert.equal(f.service.readForAgent(scope, source, { start: 0, end: 4 }, 'other-peer', f.agent).error.code, 'scope_mismatch')
    f.state.agent = { ...f.agent }
    assert.equal(f.service.validateReference(scope, source, 'source-peer').error.code, 'scope_mismatch')
  } finally { f.service.dispose() }
})
