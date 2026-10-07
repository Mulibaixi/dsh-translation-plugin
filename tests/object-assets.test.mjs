import assert from 'node:assert/strict'
import test from 'node:test'
import { ObjectAssetsService, loadObjectAssetStorage } from '../dist/host/object-assets.js'
import { parseObjectAssetVersion, parseObjectAssetRequest, parseObjectAssetResult, OBJECT_ASSET_REMOTE } from '../dist/shared/object-assets.js'
import { TopicToolsService } from '../dist/host/topic-tools.js'
import { mkdtemp, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const digest = 'a'.repeat(64), ownerId = 'synthetic-main', topicId = 'synthetic-topic'
const placement = { ownerId, topicId, translationSessionId: 'synthetic-translation', unitId: 'unit-1', side: 'source', revisionId: null, offset: 0, kind: 'image', receiptId: 'receipt-1' }
function fixture() {
  const agent = { id: ownerId, session: { id: ownerId }, ctx: {} }, records = new Map(), opened = [], read = [], writes = []
  const state = { peer: 'operator-1', connected: true, corrupt: false, saveFailed: false, nativeOpen: true, openFailed: false }
  const receipts = new Map([['receipt-1', { attachmentId: `sha256:${digest}`, name: 'original.png', bytes: 3 }], ['receipt-2', { attachmentId: `sha256:${'b'.repeat(64)}`, name: 'result.png', bytes: 4 }]])
  const storage = { async read(id) { return structuredClone(records.get(id)) }, async write(record) { writes.push(record.asset.assetId); if (state.saveFailed) throw new Error('private-path'); records.set(record.asset.assetId, structuredClone(record)) } }
  const ctx = { provide() {}, get invocation() { return { peer: { id: state.peer } } }, get(name) {
    return { translationTopics: { ownsConnection(owner, peer) { return state.connected && owner === ownerId && peer === 'operator-1' } },
      agents: { get(id) { return id === ownerId ? agent : undefined } },
      attachments: { async *readFileStream(ref) { read.push(ref.attachmentId); yield new Uint8Array([1]); if (state.corrupt) throw new Error('ATTACHMENT_CORRUPT') }, fileHostPath(ref) { return `/fixture-managed/${ref.name}` } },
      fileUploads: { resolve(exactAgent, receipt) { assert.equal(exactAgent, agent); return receipts.get(receipt) } },
      sessionController: { async resolveAgent() { return agent }, canOpenWorkspacePath() { return state.nativeOpen }, async openWorkspacePath({ path }) { if (state.openFailed) throw new Error('private-path'); opened.push(path); return { opened: true } } },
    }[name]
  } }
  const service = () => new ObjectAssetsService(ctx, { storage })
  return { service: service(), restart: service, ctx, state, storage, records, opened, read, writes }
}
const signal = () => new AbortController().signal
function openRequest(asset, patch = {}) { return { ownerId, topicId, objectId: asset.objectId, assetId: asset.assetId, version: asset.version, ...patch } }

test('受管原件协议只允许scoped IDs/receipt，不接受path、fileRef或篡改版本meta', () => {
  assert.deepEqual(parseObjectAssetRequest('register', placement), placement)
  assert.throws(() => parseObjectAssetRequest('register', { ...placement, path: '/private' }))
  assert.throws(() => parseObjectAssetRequest('register', { ...placement, persist: false }))
  assert.throws(() => parseObjectAssetRequest('register', { ...placement, file: { attachmentId: 'forged' } }))
  assert.throws(() => parseObjectAssetRequest('register', { ...placement, side: 'source', revisionId: 'revision-1' }))
  assert.throws(() => parseObjectAssetRequest('register', { ...placement, side: 'revision', revisionId: null }))
  assert.throws(() => parseObjectAssetRequest('register', { ...placement, offset: -1 }))
  assert.throws(() => parseObjectAssetVersion({ objectId: 'object-00000000-0000-0000-0000-000000000001', assetId: 'asset-00000000-0000-0000-0000-000000000002', version: 2, kind: 'image', name: 'x.png', bytes: 3 }))
  assert.deepEqual(OBJECT_ASSET_REMOTE.descriptors.map(item => item.method), ['capabilities', 'register', 'open'])
  assert.throws(() => parseObjectAssetResult('open', { ok: true, value: { opened: true, path: '/private' } }))
})
test('主会话收据登记→完整校验→Host系统打开，长期回执不暴露path/receipt/fileRef', async () => {
  const f = fixture(), registered = await f.service.register(placement, signal())
  assert.equal(registered.ok, true); assert.equal(registered.value.persistence, 'saved')
  assert.equal(registered.value.version, 1); assert.equal(registered.value.name, 'original.png')
  assert.ok(!JSON.stringify(registered).includes(digest)); assert.ok(!JSON.stringify(registered).includes('receipt'))
  assert.doesNotThrow(() => parseObjectAssetResult('register', registered))
  assert.deepEqual(await f.service.open(openRequest(registered.value), signal()), { ok: true, value: { opened: true } })
  assert.deepEqual(f.read, [`sha256:${digest}`]); assert.deepEqual(f.opened, ['/fixture-managed/original.png'])
  const stored = [...f.records.values()][0]
  assert.deepEqual(Object.keys(stored).sort(), ['asset', 'file', 'ownerId', 'schemaVersion', 'topicId'])
  assert.equal(stored.unitId, undefined); assert.equal(stored.offset, undefined, 'Host does not duplicate Client placement facts')
})
test('固定旧asset与独立结果分别打开；同object/kind不替换原件', async () => {
  const f = fixture(), original = (await f.service.register(placement, signal())).value
  const result = (await f.service.register({ ...placement, receiptId: 'receipt-2', side: 'revision', revisionId: 'revision-1', existingObjectId: original.objectId }, signal())).value
  assert.equal(result.objectId, original.objectId); assert.notEqual(result.assetId, original.assetId); assert.equal(result.version, 1)
  assert.equal((await f.service.register({ ...placement, receiptId: 'receipt-2', kind: 'table', existingObjectId: original.objectId }, signal())).error.code, 'not_found')
  await f.service.open(openRequest(original), signal()); await f.service.open(openRequest(result), signal())
  assert.deepEqual(f.opened, ['/fixture-managed/original.png', '/fixture-managed/result.png'])
  assert.equal((await f.service.open(openRequest(original, { version: 2 }), signal())).error.code, 'not_found')
})
test('跨owner/topic/object/peer拒绝；已断开或未ready连接不登记/打开', async () => {
  const f = fixture(), asset = (await f.service.register(placement, signal())).value
  for (const patch of [{ ownerId: 'other-main' }, { topicId: 'other-topic' }, { objectId: 'object-00000000-0000-0000-0000-000000000001' }]) assert.equal((await f.service.open(openRequest(asset, patch), signal())).ok, false)
  assert.equal((await f.service.register({ ...placement, ownerId: 'other-main' }, signal())).error.code, 'scope_mismatch')
  assert.equal((await f.service.register({ ...placement, existingObjectId: asset.objectId, topicId: 'other-topic' }, signal())).error.code, 'not_found')
  f.state.peer = 'operator-2'
  assert.equal((await f.service.open(openRequest(asset), signal())).error.code, 'scope_mismatch')
  f.state.peer = 'operator-1'; f.state.connected = false
  assert.equal((await f.service.register(placement, signal())).error.code, 'scope_mismatch')
  assert.equal(f.opened.length, 0)
})
test('用户明确关联的原件索引总持久保存，后续历史开关变化或重启不失去固定目标', async () => {
  const f = fixture(), saved = (await f.service.register(placement, signal())).value
  assert.equal(saved.persistence, 'saved'); assert.equal(f.writes.length, 1)
  assert.equal((await f.restart().open(openRequest(saved), signal())).ok, true)
  const duplicate = (await f.service.register(placement, signal())).value
  assert.equal(duplicate.assetId, saved.assetId); assert.equal(f.writes.length, 1)
})
test('未知收据不登记，mapping保存失败明确可重试且不暴露私有失败path', async () => {
  const f = fixture()
  assert.equal((await f.service.register({ ...placement, receiptId: 'other-agent-receipt' }, signal())).error.code, 'receipt_not_found')
  f.state.saveFailed = true
  const failure = await f.service.register(placement, signal())
  assert.equal(failure.error.code, 'storage_failed'); assert.ok(!JSON.stringify(failure).includes('private-path'))
  f.state.saveFailed = false
  const asset = (await f.service.register(placement, signal())).value
  assert.equal(f.writes[0], asset.assetId); assert.equal(f.writes[1], asset.assetId)
})
test('缺原件或完整读取后校验失败不打开、不自动换版本；native失败可明确重试', async () => {
  const f = fixture(), asset = (await f.service.register(placement, signal())).value
  f.state.corrupt = true
  assert.equal((await f.service.open(openRequest(asset), signal())).error.code, 'integrity_failed'); assert.equal(f.opened.length, 0)
  f.state.corrupt = false; f.state.openFailed = true
  assert.equal((await f.service.open(openRequest(asset), signal())).error.code, 'open_failed')
  f.state.openFailed = false; assert.equal((await f.service.open(openRequest(asset), signal())).ok, true)
  f.state.nativeOpen = false; assert.equal((await f.service.open(openRequest(asset), signal())).error.code, 'unavailable')
})
test('校验期间连接关闭不打开；调用取消保留Abort失败', async () => {
  const f = fixture(), asset = (await f.service.register(placement, signal())).value, originalGet = f.ctx.get
  f.ctx.get = function(name) { const value = originalGet(name); return name === 'attachments' ? { ...value, async *readFileStream() { yield new Uint8Array([1]); f.state.connected = false } } : value }
  assert.equal((await f.service.open(openRequest(asset), signal())).error.code, 'scope_mismatch'); assert.equal(f.opened.length, 0)
  f.state.connected = true
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.service.open(openRequest(asset), controller.signal), { name: 'AbortError' })
})
test('TopicTools ownsConnection须metadata授权、tools成功与ready，冷启动阶段或断开拒绝', async () => {
  let releaseList, releaseTools
  const list = new Promise(done => { releaseList = done }), tools = new Promise(done => { releaseTools = done }), controller = new AbortController()
  const ctx = { provide() {}, invocation: { peer: { id: 'operator-1' }, uplink: () => ({ async *[Symbol.asyncIterator]() {} }) }, get(name) {
    return { agents: { get() {} }, tools: {}, sessionController: { async list() { await list; return { items: [{ sessionId: ownerId }] } } } }[name]
  } }
  const service = new TopicToolsService(ctx, async () => { await tools; return { defineTool() {} } })
  const stream = service.connect({ ownerId, mainSessionId: ownerId }, controller.signal), ready = stream.next()
  assert.equal(service.ownsConnection(ownerId, 'operator-1'), false)
  releaseList(); await new Promise(done => setImmediate(done)); assert.equal(service.ownsConnection(ownerId, 'operator-1'), false)
  releaseTools(); assert.equal((await ready).value.kind, 'ready'); assert.equal(service.ownsConnection(ownerId, 'operator-1'), true)
  assert.equal(service.ownsConnection(ownerId, 'operator-2'), false)
  controller.abort(); assert.equal(service.ownsConnection(ownerId, 'operator-1'), false); await stream.return(); service.dispose()
})
test('公开data root只保存受管metadata且atomic写；私有temproot可重载，损坏拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'translation-objects-'))
  try {
    const ctx = { provide() {}, baseUrl: 'file:///synthetic/profile/', get() { return { internal: { async import(name) {
      if (name.endsWith('dsh-home-paths')) return { dshHomePath: (...parts) => join(root, ...parts) }
      if (name.endsWith('dsh-atomic-write')) return { async writeFileAtomic(path, data, options) { assert.equal(options.mode, 0o600); await mkdir(join(path, '..'), { recursive: true }); await writeFile(`${path}.tmp`, data); await rename(`${path}.tmp`, path) } }
      throw new Error(name)
    } } } } }
    const storage = await loadObjectAssetStorage(ctx), f = fixture(), asset = (await f.service.register(placement, signal())).value, record = f.records.get(asset.assetId)
    await storage.write(record); assert.deepEqual(await storage.read(asset.assetId), record)
    const path = join(root, 'translation-plugin/objects/v1', `${asset.assetId}.json`)
    assert.ok(!(await readFile(path, 'utf8')).includes('unit-1'))
    await writeFile(path, JSON.stringify({ ...record, file: { ...record.file, attachmentId: 'forged' } }))
    await assert.rejects(storage.read(asset.assetId), /Invalid object mapping/)
    assert.equal(await storage.read('asset-00000000-0000-0000-0000-000000000003'), undefined)
    await assert.rejects(storage.read('../private'), /Invalid asset identity/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
