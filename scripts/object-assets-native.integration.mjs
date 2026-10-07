import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, chmod, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { createTopicToolsNativeFixture, waitTopicReady } from '../tests/topic-tools-native-fixture.mjs'
import { SessionStore } from '../dist/client/session-store.js'
import { TopicMemoryStore } from '../dist/client/topic-memory-store.js'
import { TopicArchiveStore } from '../dist/client/topic-archive-store.js'
import { ObjectAssetsService } from '../dist/host/object-assets.js'

const runtimeRoot = process.env.DSH_RUNTIME_ROOT
if (!runtimeRoot) throw new Error('DSH_RUNTIME_ROOT is required with the installed rc.2 Attachment/FileUploads/LocalFs/SessionController components')
function unwrap(result) { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.value }
const ownerId = 'synthetic-object-main', signal = () => new AbortController().signal

test('rc.2真实FileUploads→strict Gateway登记→DSH逐字节附件→校验及Native Controller映射；不请求模型', async () => {
  const f = await createTopicToolsNativeFixture({ runtimeRoot, managedObjects: true }), sessions = new SessionStore(), session = sessions.createSession(ownerId)
  const terms = new TopicMemoryStore(sessions), archive = new TopicArchiveStore(sessions, (id, unit) => terms.readEvidence(id, unit))
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(f.host.directory, 'home')
  let main, foreign, release
  try {
    main = await f.createAgent(ownerId); foreign = await f.createAgent('synthetic-object-other-main')
    const bridge = f.bridge(sessions, terms, archive); release = bridge.retain(ownerId); await waitTopicReady(bridge, ownerId, f.carrierErrors)
    const remote = f.client.remote.translationObjects
    assert.deepEqual(unwrap(unwrap(await remote.capabilities())), { ready: true, nativeOpen: true })
    const sourceBytes = Buffer.from('Synthetic original object bytes'), resultBytes = Buffer.from('Synthetic independent result bytes')
    const upload = unwrap(await f.client.remote.fileUploads.upload(ownerId, { data: sourceBytes.toString('base64'), name: 'synthetic-original.png' }, signal()))
    const placement = { ownerId, topicId: session.topicId, translationSessionId: session.id, unitId: 'synthetic-unit', side: 'source', revisionId: null, offset: 0, kind: 'image', receiptId: upload.receiptId }
    const original = unwrap(unwrap(await remote.register(placement, signal())))
    assert.equal(original.persistence, 'saved'); assert.equal(original.name, 'synthetic-original.png'); assert.equal(original.bytes, sourceBytes.length)
    assert.ok(!JSON.stringify(original).includes('receipt')); assert.ok(!JSON.stringify(original).includes('sha256:'))
    const originalPath = f.host.ctx.attachments.fileHostPath(upload.file)
    assert.equal(extname(originalPath), '.png'); assert.deepEqual(await readFile(originalPath), sourceBytes)
    assert.ok(originalPath.startsWith(join(f.host.directory, 'home', 'attachments')))
    const openRequest = asset => ({ ownerId, topicId: session.topicId, objectId: asset.objectId, assetId: asset.assetId, version: 1 })
    assert.deepEqual(unwrap(unwrap(await remote.open(openRequest(original), signal()))), { opened: true })
    assert.deepEqual(f.managedOpened, [originalPath])
    const outputUpload = unwrap(await f.client.remote.fileUploads.upload(ownerId, { data: resultBytes.toString('base64'), name: 'synthetic-result.png' }, signal()))
    const result = unwrap(unwrap(await remote.register({ ...placement, receiptId: outputUpload.receiptId, side: 'revision', revisionId: 'synthetic-revision', existingObjectId: original.objectId }, signal())))
    assert.equal(result.objectId, original.objectId); assert.notEqual(result.assetId, original.assetId)
    unwrap(unwrap(await remote.open(openRequest(result), signal())))
    assert.equal(f.managedOpened[1], f.host.ctx.attachments.fileHostPath(outputUpload.file))
    assert.equal(unwrap(await remote.open({ ...openRequest(original), version: 2 }, signal())).error.code, 'not_found')
    assert.equal(unwrap(await remote.open({ ...openRequest(original), topicId: 'other-topic' }, signal())).error.code, 'not_found')
    const foreignUpload = unwrap(await f.client.remote.fileUploads.upload(foreign.agent.id, { data: sourceBytes.toString('base64'), name: 'foreign.png' }, signal()))
    assert.equal(unwrap(await remote.register({ ...placement, receiptId: foreignUpload.receiptId }, signal())).error.code, 'receipt_not_found')
    const mappingPath = join(f.host.directory, 'home/translation-plugin/objects/v1', `${original.assetId}.json`)
    const mapping = JSON.parse(await readFile(mappingPath, 'utf8'))
    assert.equal(mapping.file.attachmentId, upload.file.attachmentId); assert.equal(mapping.unitId, undefined); assert.equal(mapping.offset, undefined)
    // Restart the file-only service against the same synthetic data root; metadata remains durable.
    const restarted = new ObjectAssetsService({ baseUrl: f.host.ctx.baseUrl, provide() {}, invocation: f.host.ctx.invocation,
      get: name => name === 'translationTopics' ? { ownsConnection: () => true } : f.host.ctx.get(name),
    })
    // The direct restart seam has a synthetic admitted peer; actual Gateway peer checks were exercised above.
    Object.defineProperty(restarted.ctx, 'invocation', { value: { peer: { id: 'synthetic-restart-peer' } } })
    assert.equal((await restarted.open(openRequest(original), signal())).ok, true)
    assert.equal(f.managedOpened.at(-1), originalPath)
    // Corrupt one private fixture alias after making the readonly object writable; never touch a user attachment.
    await chmod(originalPath, 0o600); await writeFile(originalPath, 'corrupt synthetic bytes')
    const before = f.managedOpened.length
    assert.equal(unwrap(await remote.open(openRequest(original), signal())).error.code, 'integrity_failed')
    assert.equal(f.managedOpened.length, before)
    release(); release = undefined
    assert.equal(unwrap(await remote.open(openRequest(result), signal())).error.code, 'scope_mismatch')
    assert.equal(f.host.provider.calls.length, 0)
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousDshHome
    release?.(); await main?.dispose(); await foreign?.dispose(); await f.close(); archive.dispose(); terms.dispose(); sessions.dispose()
  }
})
