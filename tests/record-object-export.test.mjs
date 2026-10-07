import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRecordObjectExport } from '../dist/client/record-object-export.js'
import { buildBilingualExport } from '../dist/client/translation-export.js'
import { newSession, DEFAULT_SESSION_SETTINGS } from '../dist/client/sessions.js'
import { appendTextUnit, emptyTranslationHistory, selectFinalRevision } from '../dist/client/translation-history.js'
const at = '2026-10-07T00:00:00.000Z', session = newSession(DEFAULT_SESSION_SETTINGS, 'synthetic-export-owner', 'synthetic-export-session')
let history = appendTextUnit(emptyTranslationHistory(), { id: 'unit', source: 'S😀[图片1]', targetLanguage: '中文', instruction: '', createdAt: at },
  { id: 'revision', operationId: 'operation', model: { provider: 'synthetic', model: 'translator' }, draftVersion: 1, createdAt: at, updatedAt: at, accepted: true, status: 'completed', text: 'T😀[图片1]', message: null })
history = selectFinalRevision(history, 'unit', 'revision', at)
const topic = { ownerId: session.ownerId, topicId: session.topicId, topicName: session.topicName }
const asset = { objectId: 'object-00000000-0000-4000-8000-000000000001', assetId: 'asset-00000000-0000-4000-8000-000000000001', version: 1, kind: 'image', name: 'synthetic.png', bytes: 3 }
const ref = { ...topic, sessionId: session.id, unitId: 'unit', side: 'revision', revisionId: 'revision', offset: 2, asset, refId: 'record-object-ref:synthetic', objectOrdinal: 1, createdAt: at }; delete ref.topicName
const request = format => ({ topic, entries: [{ session, history }], scope: 'session', format, exportedAt: at, references: [ref] })
test('TXT与复制投影用Unicode位置且literal marker保持普通文本；正文不变', () => {
  const before = JSON.stringify(history)
  assert.equal(buildRecordObjectExport(request('txt')).content, 'T😀[图片1][图片1]')
  assert.equal(JSON.stringify(history), before)
})
test('JSON对象schema2保持canonical正文与稳定sidecar；无对象shape仍schema1', () => {
  const json = JSON.parse(buildRecordObjectExport(request('json')).content)
  assert.equal(json.schemaVersion, 2); assert.equal(json.sessions[0].units[0].translation, 'T😀[图片1]'); assert.deepEqual(json.objectReferences, [ref])
  assert.equal('binary' in json.objectReferences[0].asset, false); assert.equal('path' in json.objectReferences[0].asset, false)
  assert.equal(buildRecordObjectExport({ ...request('json'), references: [] }).content, buildBilingualExport(session, history, at).content)
})
test('scope校验拒绝串owner/topic及多session单会话，引用只含source与有效final不含旧版本', () => {
  assert.throws(() => buildRecordObjectExport({ ...request('txt'), topic: { ...topic, ownerId: 'other' } }), /scope/)
  assert.throws(() => buildRecordObjectExport({ ...request('txt'), entries: [{ session, history }, { session: { ...session, id: 'other' }, history }] }), /scope/)
  const json = JSON.parse(buildRecordObjectExport({ ...request('json'), references: [ref, { ...ref, refId: 'old', revisionId: 'old' }, { ...ref, refId: 'source', side: 'source', revisionId: null }] }).content)
  assert.deepEqual(json.objectReferences.map(ref => ref.refId), [ref.refId, 'source'])
})
test('缺最终不通过对象使空译文变有效，冻结引用快照不会追随后加对象', () => {
  const frozen = structuredClone(request('txt')); const before = buildRecordObjectExport(frozen).content
  const later = { ...ref, refId: 'later', offset: 0, objectOrdinal: 2 }
  assert.notEqual(buildRecordObjectExport({ ...request('txt'), references: [ref, later] }).content, before)
  assert.equal(buildRecordObjectExport(frozen).content, before)
  const missing = { ...history, units: history.units.map(unit => ({ ...unit, final: null })) }
  assert.equal(buildRecordObjectExport({ ...request('txt'), entries: [{ session, history: missing }] }, true).content, null)
})
