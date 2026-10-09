import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFile, chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTopicToolsNativeFixture, waitTopicReady } from '../tests/topic-tools-native-fixture.mjs'
import { SessionStore } from '../dist/client/session-store.js'
import { TopicMemoryStore } from '../dist/client/topic-memory-store.js'
import { TopicArchiveStore } from '../dist/client/topic-archive-store.js'

const runtimeRoot = process.env.DSH_RUNTIME_ROOT
if (!runtimeRoot) throw new Error('DSH_RUNTIME_ROOT is required for actual rc.2 Gateway/FileUploads/Attachment components')
const ownerId = 'synthetic-source-main', signal = () => new AbortController().signal
function transport(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.value }
function value(result) { const business = transport(result); assert.equal(business.ok, true, JSON.stringify(business)); return business.value }
async function fixture() {
  const f = await createTopicToolsNativeFixture({ runtimeRoot, managedObjects: true }), main = await f.createAgent(ownerId)
  const sessions = new SessionStore(), session = sessions.createSession(ownerId)
  sessions.updateSession(session.id, { mode: 'normal', input: 'Synthetic untouched next draft' })
  const terms = new TopicMemoryStore(sessions), archive = new TopicArchiveStore(sessions, (id, unit) => terms.readEvidence(id, unit))
  const bridge = f.bridge(sessions, terms, archive), release = bridge.retain(ownerId)
  await waitTopicReady(bridge, ownerId, f.carrierErrors)
  const previousDshHome = process.env.DSH_HOME; process.env.DSH_HOME = join(f.host.directory, 'home')
  const scope = { ownerId, mainSessionId: ownerId, topicId: session.topicId, translationSessionId: session.id }
  return { f, main, sessions, session, scope, remote: f.client.remote.translationSources,
    request(upload, idempotencyKey = upload.receiptId) { return { scope, receiptId: upload.receiptId, idempotencyKey } },
    read(source, range) { return { scope, sourceId: source.sourceId, version: source.version, range } },
    upload(data, name = 'synthetic.txt', agentId = ownerId) { return f.client.remote.fileUploads.upload(agentId, { data: data.toString('base64'), name }, signal()).then(transport) },
    async close() { if (previousDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousDshHome
      release(); await main.dispose(); await f.close(); archive.dispose(); terms.dispose(); sessions.dispose() },
  }
}

test('rc.2真实上传→生产Source Gateway导入→固定Unicode分页，幂等与Peer/scope隔离，不调用模型', async () => {
  const t = await fixture(); let foreign, outsider
  try {
    const capability = value(await t.remote.capabilities())
    assert.equal(capability.ready, true); assert.equal(capability.storage, 'runtime_only'); assert.equal(capability.maxBytes, 2 * 1024 * 1024)
    const text = '\uFEFF😀\r\n' + '中'.repeat(8001), bytes = Buffer.from(text), upload = await t.upload(bytes)
    const request = t.request(upload, 'native-import-a'), source = value(await t.remote.importReceipt(request, signal()))
    assert.equal(source.bom, true); assert.equal(source.totalCodePoints, [...text].length); assert.equal(source.bytes, bytes.length)
    assert.equal(source.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(source.version, 1)
    assert.equal(source.persistence, 'runtime_only'); assert.ok(!JSON.stringify(source).includes(upload.receiptId)); assert.ok(!JSON.stringify(source).includes('attachmentId'))
    assert.deepEqual(value(await t.remote.importReceipt(request, signal())), source)
    assert.deepEqual(value(await t.remote.importReceipt(t.request(upload, 'native-retry-key'), signal())), source)
    let joined = ''
    for (let start = 0; start < source.totalCodePoints; start += 4000) {
      const result = await t.remote.readRange(t.read(source, { start, end: Math.min(start + 4000, source.totalCodePoints) }))
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768); joined += value(result).text
    }
    assert.equal(joined, text); assert.equal(value(await t.remote.readRange(t.read(source, { start: 0, end: 4 }))).text, '\uFEFF😀\r\n')
    assert.equal(transport(await t.remote.readRange(t.read(source, { start: 0, end: 4001 }))).error.code, 'page_too_large')
    for (const field of ['topicId', 'translationSessionId']) {
      assert.equal(transport(await t.remote.readRange({ ...t.read(source, { start: 0, end: 1 }), scope: { ...t.scope, [field]: 'synthetic-other' } })).error.code, 'not_found')
    }
    assert.equal(transport(await t.remote.readRange({ ...t.read(source, { start: 0, end: 1 }), version: 2 })).error.code, 'stale_version')
    foreign = await t.f.createAgent('synthetic-source-foreign')
    const foreignUpload = await t.upload(bytes, 'foreign.txt', foreign.agent.id)
    assert.equal(transport(await t.remote.importReceipt(t.request(foreignUpload), signal())).error.code, 'receipt_not_found')
    assert.equal(transport(await t.remote.importReceipt(t.request(foreignUpload, 'native-import-a'), signal())).error.code, 'idempotency_conflict')
    const { OperatorPeer } = await t.f.host.native('@deepseek-ai/dsh-client-connection'); outsider = new OperatorPeer(t.f.host.ctx)
    const denied = await t.f.host.ctx.typertGateway.dispatchRpc('translationSources/readRange', { args: { request: t.read(source, { start: 0, end: 1 }) } }, signal(), outsider)
    assert.equal(transport(denied).error.code, 'scope_mismatch')
    assert.deepEqual(await readFile(t.f.host.ctx.attachments.fileHostPath(upload.file)), bytes)
    assert.equal(t.sessions.getTranslationHistory(t.session.id).units.length, 0)
    assert.equal(t.sessions.getSession(t.session.id).input, 'Synthetic untouched next draft'); assert.equal(t.f.host.provider.calls.length, 0)
  } finally { await outsider?.dispose(); await foreign?.dispose(); await t.close() }
})

test('rc.2正式收据的非法UTF8/非TXT/过大原件及真实附件hash失败不发布资产，原件独立保留', async () => {
  const t = await fixture()
  try {
    const cases = [
      { data: Buffer.from([0xf0, 0x28, 0x8c, 0x28]), name: 'invalid-utf8.txt', code: 'invalid_utf8' },
      { data: Buffer.from('Synthetic markdown'), name: 'synthetic.md', code: 'unsupported_file' },
      { data: Buffer.alloc(2 * 1024 * 1024 + 1, 0x61), name: 'too-large.txt', code: 'source_too_large' },
    ]
    for (const entry of cases) {
      const upload = await t.upload(entry.data, entry.name)
      const result = transport(await t.remote.importReceipt(t.request(upload), signal()))
      assert.equal(result.error.code, entry.code)
      assert.deepEqual(await readFile(t.f.host.ctx.attachments.fileHostPath(upload.file)), entry.data)
    }
    const upload = await t.upload(Buffer.from('Synthetic correct bytes'), 'integrity.txt')
    const privatePath = t.f.host.ctx.attachments.fileHostPath(upload.file)
    // Corrupt only this disposable fixture attachment alias; native stream verifies the final digest.
    await chmod(privatePath, 0o600); await writeFile(privatePath, 'Synthetic corrupt bytes')
    assert.equal(transport(await t.remote.importReceipt(t.request(upload), signal())).error.code, 'integrity_failed')
    assert.equal(t.f.host.ctx.translationSources.sources.size, 0); assert.equal(t.f.host.ctx.translationSources.receipts.size, 0)
    assert.equal(t.sessions.getTranslationHistory(t.session.id).units.length, 0); assert.equal(t.f.host.provider.calls.length, 0)
  } finally { await t.close() }
})
