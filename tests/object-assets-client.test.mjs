import assert from 'node:assert/strict'
import test from 'node:test'
import { ObjectAssetsClient, adaptObjectAssetsRemote } from '../dist/client/object-assets-client.js'
import { SessionStore } from '../dist/client/session-store.js'
import { RecordObjectStore } from '../dist/client/record-object-store.js'
import { appendTextUnit, appendTextRevision } from '../dist/client/translation-history.js'

const at = '2026-10-07T00:00:00.000Z'
const asset = { objectId: 'object-00000000-0000-4000-8000-000000000001', assetId: 'asset-00000000-0000-4000-8000-000000000001', version: 1, kind: 'image', name: 'synthetic.png', bytes: 3 }
const receipt = value => ({ ok: true, value: { ok: true, value } })
function fixture() {
  const sessions = new SessionStore(undefined, undefined, null), session = sessions.createSession('synthetic-object-client')
  sessions.updateTranslationHistory(session.id, history => appendTextUnit(history, { id: 'unit', source: 'S😀', targetLanguage: '中文', instruction: '', createdAt: at },
    { id: 'revision', operationId: 'operation', model: { provider: 'synthetic', model: 'translator' }, draftVersion: 1, createdAt: at, updatedAt: at, accepted: true, status: 'completed', text: 'T😀', message: null }))
  const references = new RecordObjectStore(sessions, undefined, undefined, null), uploads = [], registers = [], opens = []
  const native = { async upload(...args) { uploads.push(args); return { ok: true, value: { receiptId: 'receipt:synthetic', file: { attachmentId: 'synthetic', name: 'synthetic.png', bytes: 3 } } } } }
  const remote = { capabilities: async () => receipt({ ready: true, nativeOpen: true }), register: async request => { registers.push(request); return receipt({ ...asset, kind: request.kind, persistence: 'saved' }) }, open: async request => { opens.push(request); return receipt({ opened: true }) } }
  let ready = true
  const client = new ObjectAssetsClient(adaptObjectAssetsRemote(remote), native, sessions, references, () => ({ ready, reason: ready ? undefined : '主题连接未就绪' }))
  const target = { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: 'unit', side: 'source', revisionId: null }
  const file = Object.assign(new Blob(['abc']), { name: 'synthetic.png' })
  return { sessions, session, references, uploads, registers, opens, native, remote, client, target, file, setReady(value) { ready = value }, close() { client.dispose(); references.dispose(); sessions.dispose() } }
}
test('Client真实上传签名、双封套登记与六字段sidecar；Host请求仅传receipt不含file/path/persist', async t => {
  const f = fixture(); t.after(() => f.close())
  const result = await f.client.attachFile(f.target, 2, 'image', f.file)
  assert.equal(result.result.status, 'updated'); assert.equal(result.result.reference.offset, 2)
  assert.equal(f.uploads[0][0], f.session.ownerId); assert.equal(f.uploads[0][1], f.file); assert.equal(f.uploads[0][2], 'synthetic.png'); assert.ok(f.uploads[0][3] instanceof AbortSignal); assert.equal(typeof f.uploads[0][4], 'function')
  assert.deepEqual(Object.keys(f.registers[0]).sort(), ['kind', 'offset', 'ownerId', 'receiptId', 'revisionId', 'side', 'topicId', 'translationSessionId', 'unitId'])
  assert.deepEqual(result.input.asset, asset); assert.equal('persistence' in result.input.asset, false)
  await f.client.open(f.target.ownerId, f.target.topicId, asset)
  assert.deepEqual(f.opens[0], { ownerId: f.target.ownerId, topicId: f.target.topicId, objectId: asset.objectId, assetId: asset.assetId, version: 1 })
})
test('Client上传前拒绝未ready、超出Unicode位置、运行中及空正文修订；await后归档不落引用', async t => {
  const f = fixture(); t.after(() => f.close()); f.setReady(false)
  await assert.rejects(f.client.attachFile(f.target, 0, 'image', f.file), /主题连接/); f.setReady(true)
  await assert.rejects(f.client.attachFile(f.target, 3, 'image', f.file), /关联位置/)
  f.sessions.updateTranslationHistory(f.session.id, history => appendTextRevision(history, 'unit', { id: 'running', operationId: 'running', model: { provider: 'synthetic', model: 'translator' }, draftVersion: 1, createdAt: at, updatedAt: at, accepted: true, status: 'running', text: 'partial', message: null }))
  await assert.rejects(f.client.attachFile({ ...f.target, side: 'revision', revisionId: 'running' }, 0, 'image', f.file), /关联位置/)
  assert.equal(f.uploads.length, 0)
  f.native.upload = async () => { f.sessions.archiveSession(f.session.ownerId, f.session.id); return { ok: true, value: { receiptId: 'receipt:late' } } }
  await assert.rejects(f.client.attachFile(f.target, 0, 'image', f.file), /关联位置/)
  assert.equal(f.registers.length, 0); assert.equal(f.references.getSnapshot(f.target.ownerId, f.target.topicId, f.target.sessionId).references.length, 0)
})
test('Gateway外层成功不等于打开成功，单层/无效回执和Host明确失败均保留失败', async () => {
  for (const response of [{ ok: true, value: { opened: true } }, { ok: false, error: { message: 'carrier failed' } }, { ok: true, value: { ok: true, value: { opened: false } } }]) {
    const port = adaptObjectAssetsRemote({ open: async () => response })
    await assert.rejects(port.open({ ownerId: 'o', topicId: 't', ...asset }, new AbortController().signal))
  }
  const port = adaptObjectAssetsRemote({ open: async () => ({ ok: true, value: { ok: false, error: { code: 'open_failed', message: 'synthetic open rejected' } } }) })
  assert.deepEqual(await port.open({}, new AbortController().signal), { ok: false, error: { code: 'open_failed', message: 'synthetic open rejected' } })
})
test('结果文件existingObjectId只定对象身份，可靠formulaSource仅sidecar持久', async t => {
  const f = fixture(); t.after(() => f.close())
  const result = await f.client.attachFile({ ...f.target, side: 'revision', revisionId: 'revision' }, 1, 'formula', f.file, asset.objectId, 'E=mc^2')
  assert.equal(result.result.status, 'updated'); assert.equal(f.registers[0].existingObjectId, asset.objectId)
  assert.equal('formulaSource' in f.registers[0], false); assert.equal(result.input.formulaSource, 'E=mc^2')
})
