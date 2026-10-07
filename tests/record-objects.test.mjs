import assert from 'node:assert/strict'
import test from 'node:test'
import { appendRecordObjectReference, decodeRecordObjectReferenceInput, decodeRecordObjectSnapshot, emptyRecordObjects } from '../dist/shared/record-objects.js'
import { projectRecordObjects, recordObjectLabel } from '../dist/client/record-object-projection.js'

const at = '2026-10-07T00:00:00.000Z'
const uuid = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const asset = (value = 1, edits = {}) => ({ objectId: `object-${uuid(value)}`, assetId: `asset-${uuid(value)}`, version: 1, kind: 'image', name: `synthetic-${value}.png`, bytes: 12, ...edits })
const target = { ownerId: 'owner', topicId: 'topic', sessionId: 'session', unitId: 'unit', side: 'source', revisionId: null }
const input = (edits = {}) => ({ ...target, offset: 0, asset: asset(), ...edits })
const empty = () => emptyRecordObjects('owner', 'topic', 'session', at)
let refSequence = 0
const add = (snapshot, edits = {}) => appendRecordObjectReference(snapshot, input(edits), { refId: `ref-${++refSequence}`, at })

test('唯一object按kind在同unit首绑定编号，两侧及独立asset版本共享编号', () => {
  let snapshot = add(empty()).snapshot
  snapshot = add(snapshot, { asset: asset(2) }).snapshot
  snapshot = add(snapshot, { side: 'revision', revisionId: 'revision-1', asset: asset(1, { assetId: `asset-${uuid(3)}`, name: 'independent-result.png' }) }).snapshot
  snapshot = add(snapshot, { asset: asset(4, { kind: 'table', name: 'synthetic.csv' }) }).snapshot
  assert.deepEqual(snapshot.references.map(recordObjectLabel), ['图片1', '图片2', '图片1', '表格1'])
  assert.equal(snapshot.references[0].asset.assetId, `asset-${uuid(1)}`)
  assert.equal(snapshot.references[2].asset.version, 1); assert.equal(snapshot.references[0].offset, 0)
  assert.ok(decodeRecordObjectSnapshot(snapshot))
  const otherUnit = add(snapshot, { unitId: 'unit-2', asset: asset(2) }).reference
  assert.equal(recordObjectLabel(otherUnit), '图片1')
})

test('only-add重复binding不制造新ref/version，不允许同位置偷换独立asset', () => {
  const first = add(empty()), same = add(first.snapshot)
  assert.equal(same.status, 'unchanged'); assert.equal(same.snapshot, first.snapshot); assert.equal(same.reference, first.reference)
  assert.equal(add(first.snapshot, { asset: asset(1, { assetId: `asset-${uuid(3)}` }) }).status, 'invalid')
  const secondPosition = add(first.snapshot, { offset: 2 })
  assert.equal(secondPosition.status, 'updated'); assert.equal(secondPosition.reference.objectOrdinal, 1)
  assert.equal(secondPosition.snapshot.references[0].offset, 0)
})

test('scope/kind/asset metadata在边界约束，副本中不接受正文、路径、binary或混合revision身份', () => {
  assert.ok(decodeRecordObjectReferenceInput(input()))
  for (const value of [input({ offset: -1 }), input({ offset: 0.5 }), input({ revisionId: 'wrong-source-revision' }), input({ side: 'revision', revisionId: null }),
    { ...input(), text: 'must not duplicate body' }, input({ asset: { ...asset(), path: '/hidden/native/path' } }), input({ asset: { ...asset(), bytes: -1 } }), input({ asset: asset(1, { version: 2 }) })]) assert.equal(decodeRecordObjectReferenceInput(value), undefined)
  const snapshot = add(empty()).snapshot
  assert.equal(add(snapshot, { ownerId: 'other' }).status, 'invalid'); assert.equal(add(snapshot, { topicId: 'other' }).status, 'invalid'); assert.equal(add(snapshot, { sessionId: 'other' }).status, 'invalid')
  assert.equal(add(snapshot, { offset: 1, asset: asset(1, { kind: 'document', name: 'synthetic.pdf' }) }).status, 'invalid')
  assert.equal(add(snapshot, { offset: 1, asset: asset(1, { name: 'changed-name.png' }) }).status, 'invalid')
})

test('存储decoder验证唯一ref、ordinal与object kind一致及快照完整归属', () => {
  const snapshot = add(add(empty()).snapshot, { asset: asset(2) }).snapshot
  assert.equal(decodeRecordObjectSnapshot({ ...snapshot, references: [snapshot.references[0], snapshot.references[0]] }), undefined)
  assert.equal(decodeRecordObjectSnapshot({ ...snapshot, references: snapshot.references.map((ref, i) => i ? { ...ref, objectOrdinal: 1 } : ref) }), undefined)
  assert.equal(decodeRecordObjectSnapshot({ ...snapshot, references: [{ ...snapshot.references[0], topicId: 'other' }] }), undefined)
  assert.equal(decodeRecordObjectSnapshot({ ...snapshot, source: 'duplicate body' }), undefined)
  assert.equal(decodeRecordObjectSnapshot({ ...snapshot, references: [{ ...snapshot.references[0], createdAt: 'not a time' }] }), undefined)
})

test('纯投影按Unicode码点分段，0/正文末尾位置有效，普通占位字符从不变对象', () => {
  const text = '甲😀乙[图片1]尾'
  let snapshot = add(empty(), { offset: 0 }).snapshot
  snapshot = add(snapshot, { offset: 2, asset: asset(2) }).snapshot
  snapshot = add(snapshot, { offset: Array.from(text).length, asset: asset(3) }).snapshot
  const before = structuredClone(snapshot), projection = projectRecordObjects(text, target, snapshot.references)
  assert.deepEqual(snapshot, before)
  assert.deepEqual(projection.segments.map(segment => segment.kind === 'text' ? segment.text : segment.label), ['图片1', '甲😀', '图片2', '乙[图片1]尾', '图片3'])
  assert.equal(projection.segments.filter(segment => segment.kind === 'text').map(segment => segment.text).join(''), text)
  assert.deepEqual(projectRecordObjects('正文[图片1] [表格2]', target, []).segments, [{ kind: 'text', text: '正文[图片1] [表格2]' }])
  assert.deepEqual(projectRecordObjects('', target, snapshot.references.slice(0, 1)).segments.map(segment => segment.label), ['图片1'])
})

test('不同owner/topic/session/unit/source/具体revision完全隔离，不将旧ref迁移到新人工版本', () => {
  const source = add(empty()).reference
  const revision = { ...source, side: 'revision', revisionId: 'revision-1' }
  for (const scope of [{ ...target, ownerId: 'other' }, { ...target, topicId: 'other' }, { ...target, sessionId: 'other' }, { ...target, unitId: 'other' }, { ...target, side: 'revision', revisionId: 'revision-2' }]) {
    assert.deepEqual(projectRecordObjects('合成正文', scope, [source, revision]).segments, [{ kind: 'text', text: '合成正文' }])
  }
  assert.equal(projectRecordObjects('合成正文', { ...target, side: 'revision', revisionId: 'revision-1' }, [source, revision]).segments[0].reference, revision)
})

test('无效offset仅报告不可用，不clamp到错误正文；同点多对象按固定绑定顺序', () => {
  const snapshot = add(add(empty(), { offset: 1 }).snapshot, { offset: 1, asset: asset(2) }).snapshot
  const wrong = { ...snapshot.references[0], refId: 'out-of-range', offset: 3 }
  const projection = projectRecordObjects('😀', target, [...snapshot.references, wrong])
  assert.deepEqual(projection.unavailableRefs, [wrong])
  assert.deepEqual(projection.segments.map(segment => segment.kind === 'text' ? segment.text : segment.label), ['😀', '图片1', '图片2'])
})

test('可靠公式source只接受formula显式元数据，投影原样携带且不识别正文TeX', () => {
  const formulaSource = String.raw`\\sqrt{x}`
  const value = input({ asset: asset(1, { kind: 'formula', name: 'synthetic.tex' }), formulaSource })
  assert.equal(decodeRecordObjectReferenceInput(value).formulaSource, formulaSource)
  assert.equal(decodeRecordObjectReferenceInput(input({ formulaSource })), undefined)
  assert.equal(decodeRecordObjectReferenceInput({ ...value, formulaSource: '' }), undefined)
  const saved = add(empty(), { asset: value.asset, formulaSource })
  assert.equal(decodeRecordObjectSnapshot(saved.snapshot).references[0].formulaSource, formulaSource)
  assert.equal(add(saved.snapshot, { asset: value.asset, formulaSource: 'different' }).status, 'invalid')
  const projection = projectRecordObjects(String.raw`body \\sqrt{untrusted}`, target, saved.snapshot.references)
  assert.equal(projection.segments[0].reference.formulaSource, formulaSource)
  assert.equal(projection.segments[0].label, '公式1'); assert.equal(projection.segments[1].text, String.raw`body \\sqrt{untrusted}`)
})
