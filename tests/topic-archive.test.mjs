import assert from 'node:assert/strict'
import test from 'node:test'
import {
  emptyTopicArchive, putTopicArchive, putUserTopicArchive, adoptTopicArchive, disableTopicArchive, deleteTopicArchiveEntry,
  reconcileTopicArchive, queryTopicArchive, decodeTopicArchivePut, decodeTopicArchiveUserInput,
  decodeTopicArchiveSnapshot, decodeTopicArchiveQuerySnapshot,
} from '../dist/memory/topic-archive.js'

const at = '2026-10-07T00:00:00.000Z'
const source = { kind: 'source', sessionId: 'session', unitId: 'unit', revisionId: null, selectionEventId: null, range: null, role: 'basis' }
const final = { ...source, kind: 'final', revisionId: 'revision', selectionEventId: 'selection' }
const fact = { ownerId: 'owner', topicId: 'topic', sourceVersion: 1, source: 'Synthetic source 😀', final: { revisionId: 'revision', selectionEventId: 'selection', sourceVersion: 1, text: 'Synthetic final' } }
const resolver = () => fact
const action = { eventId: 'user-event', at }
const empty = () => emptyTopicArchive('owner', 'topic', at)
const entity = (edits = {}) => ({ kind: 'entity', name: 'Alice', aliases: ['A'], description: 'Synthetic entity', id: 'alice', expectedEntryVersion: null, origin: 'source_checked', status: 'active', evidence: [source], ...edits })
const query = (snapshot, edits = {}, resolve = resolver) => queryTopicArchive(snapshot, { mode: 'normal', ownerId: 'owner', topicId: 'topic', kinds: ['entity', 'fact', 'relation'], forms: ['Alice'], ...edits }, resolve)
function graph() {
  let snapshot = putTopicArchive(empty(), entity(), resolver, at).snapshot
  snapshot = putTopicArchive(snapshot, entity({ id: 'bob', name: 'Bob', aliases: [] }), resolver, at).snapshot
  snapshot = putTopicArchive(snapshot, { kind: 'fact', id: 'fact', title: 'Birthplace', body: 'Synthetic fact', entityIds: ['alice'], evidence: [source], expectedEntryVersion: null, status: 'active', origin: 'source_checked' }, resolver, at).snapshot
  snapshot = putTopicArchive(snapshot, { kind: 'relation', id: 'relation', sourceEntityId: 'alice', relation: 'knows', targetEntityId: 'bob', description: 'Synthetic relation', evidence: [source], expectedEntryVersion: null, status: 'active', origin: 'source_checked' }, resolver, at).snapshot
  return snapshot
}

test('三类档案稳定ID、版本与精确检索；Quick、跨owner/topic及任意子串为空', () => {
  const snapshot = graph()
  assert.deepEqual(query(snapshot).map(entry => entry.id), ['alice', 'fact', 'relation'])
  assert.deepEqual(query(snapshot, { kinds: ['relation'], forms: ['knows'] }).map(entry => entry.id), ['relation'])
  assert.deepEqual(query(snapshot, { kinds: ['fact'], forms: ['Birthplace'] }).map(entry => entry.id), ['fact'])
  for (const edits of [{ mode: 'quick' }, { ownerId: 'other' }, { topicId: 'other' }, { forms: ['Ali'] }, { forms: [] }, { kinds: [] }]) assert.deepEqual(query(snapshot, edits), [])
  const unchanged = putTopicArchive(snapshot, entity({ expectedEntryVersion: 1 }), resolver, at)
  assert.equal(unchanged.status, 'unchanged'); assert.equal(unchanged.snapshot, snapshot)
  const proposal = putTopicArchive(empty(), entity({ status: 'proposal', origin: 'inferred' }), resolver, at).snapshot
  assert.equal(proposal.version, 1); assert.equal(proposal.activeVersion, 0); assert.deepEqual(query(proposal), [])
})

test('来源核对active需要有效source依据、同owner/topic、有效Unicode半开范围', () => {
  for (const edits of [{ origin: 'inferred' }, { evidence: [] }, { evidence: [final] }, { evidence: [{ ...source, range: { start: 0, end: 999 } }] }]) assert.equal(putTopicArchive(empty(), entity(edits), resolver, at).status, 'invalid')
  assert.equal(putTopicArchive(empty(), entity(), () => ({ ...fact, ownerId: 'other' }), at).status, 'invalid')
  assert.equal(putTopicArchive(empty(), entity(), () => ({ ...fact, topicId: 'other' }), at).status, 'invalid')
  const range = { start: Array.from(fact.source).length - 1, end: Array.from(fact.source).length }
  assert.equal(putTopicArchive(empty(), entity({ evidence: [{ ...source, range }] }), resolver, at).status, 'updated')
})

test('实体引用只在同topic且实际kind为entity时写入；active必须引用有效实体', () => {
  const input = { kind: 'fact', id: 'f', title: 'Synthetic', body: 'Synthetic', entityIds: ['missing'], evidence: [source], expectedEntryVersion: null, status: 'proposal', origin: 'inferred' }
  assert.equal(putTopicArchive(empty(), input, resolver, at).status, 'invalid')
  const snapshot = graph()
  assert.equal(putTopicArchive(snapshot, { ...input, entityIds: ['fact'] }, resolver, at).status, 'invalid')
  const disabled = disableTopicArchive(snapshot, 'alice', 1, at).snapshot
  assert.equal(putTopicArchive(disabled, { ...input, entityIds: ['alice'], status: 'active', origin: 'source_checked' }, resolver, at).status, 'invalid')
  assert.equal(putTopicArchive(disabled, { ...input, entityIds: ['alice'] }, resolver, at).status, 'updated')
  assert.equal(putUserTopicArchive(disabled, { kind: 'fact', id: 'new', expectedEntryVersion: null, title: 'Synthetic', body: 'Synthetic', entityIds: ['alice'] }, resolver, action).status, 'invalid')
})

test('用户一次保存建立active/user_explicit及程序采用事实；模型不能覆盖或改kind', () => {
  const saved = putUserTopicArchive(empty(), { kind: 'entity', id: 'alice', expectedEntryVersion: null, name: 'Alice', aliases: [], description: 'User entity' }, resolver, action)
  assert.equal(saved.status, 'updated'); assert.equal(saved.entry.version, 2); assert.equal(saved.entry.origin, 'user_explicit'); assert.equal(saved.entry.status, 'active')
  assert.deepEqual(saved.entry.confirmation, { ...action, adoptedEntryVersion: 1 }); assert.ok(decodeTopicArchiveSnapshot(saved.snapshot))
  assert.equal(putTopicArchive(saved.snapshot, entity({ expectedEntryVersion: 2 }), resolver, at).status, 'requires_user_action')
  assert.equal(putUserTopicArchive(saved.snapshot, { kind: 'fact', id: 'alice', expectedEntryVersion: 2, title: 'Change kind', body: 'Body', entityIds: [] }, resolver, action).status, 'invalid')
  assert.equal(putUserTopicArchive(saved.snapshot, { kind: 'entity', id: 'alice', expectedEntryVersion: 2, name: 'Alice', aliases: [], description: 'User entity' }, resolver, action).status, 'unchanged')
})

test('最终依据变化立即复核并排除检索；选回旧版也不会自动复活', () => {
  const snapshot = putTopicArchive(empty(), entity({ evidence: [source, final] }), resolver, at).snapshot
  const changed = () => ({ ...fact, final: { ...fact.final, selectionEventId: 'new-selection' } })
  assert.deepEqual(query(snapshot, {}, changed), [])
  const reviewed = reconcileTopicArchive(snapshot, changed, at)
  assert.equal(reviewed.entries[0].status, 'review_required'); assert.equal(reviewed.activeVersion, snapshot.activeVersion + 1)
  assert.equal(reviewed.entries[0].description, snapshot.entries[0].description)
  assert.equal(reconcileTopicArchive(reviewed, resolver, at), reviewed); assert.deepEqual(query(reviewed), [])
  assert.equal(adoptTopicArchive(reviewed, 'alice', reviewed.entries[0].version, resolver, action).entry.status, 'active')
})

test('档案共用source版本resolver；source2同字串也复核，source2依据可重新核对', () => {
  const current2 = () => ({ ...fact, sourceVersion: 2, final: { ...fact.final, sourceVersion: 1 } })
  const legacy = putTopicArchive(empty(), entity(), resolver, at).snapshot
  const rawLegacy = structuredClone(legacy)
  assert.deepEqual(decodeTopicArchiveSnapshot(rawLegacy), rawLegacy, 'legacy archive ref remains readable without rewrite')
  assert.deepEqual(query(legacy, {}, current2), [])
  const reviewed = reconcileTopicArchive(legacy, current2, at)
  assert.equal(reviewed.entries[0].status, 'review_required')
  assert.equal(reviewed.entries[0].description, legacy.entries[0].description)
  assert.equal(reconcileTopicArchive(reviewed, resolver, at), reviewed, 'old archive evidence cannot silently revive')

  const source2 = { ...source, sourceVersion: 2 }
  const current2Final2 = () => ({ ...fact, sourceVersion: 2, final: { ...fact.final, sourceVersion: 2 } })
  const newBasis = putTopicArchive(empty(), entity({ id: 'version-two', evidence: [source2] }), current2, at)
  assert.equal(newBasis.status, 'updated')
  assert.equal(newBasis.entry.evidence[0].sourceVersion, 2)
  assert.equal(query(newBasis.snapshot, { forms: ['Alice'] }, current2).length, 1)

  const withOldFinal = putTopicArchive(empty(), entity({ id: 'old-final', evidence: [source2, final] }), current2Final2, at).snapshot
  const staleFinal = () => ({ ...fact, sourceVersion: 2, final: { ...fact.final, sourceVersion: 1 } })
  assert.deepEqual(query(withOldFinal, { forms: ['Alice'] }, staleFinal), [])
  assert.equal(reconcileTopicArchive(withOldFinal, staleFinal, at).entries[0].status, 'review_required')
})

test('来源删除使模型依据复核，用户独立采用不受示例失效撤销', () => {
  const snapshot = putTopicArchive(empty(), entity({ evidence: [source, final] }), resolver, at).snapshot
  const adopted = adoptTopicArchive(snapshot, 'alice', 1, resolver, action).snapshot
  assert.ok(adopted.entries[0].evidence.every(ref => ref.role === 'example'))
  assert.equal(reconcileTopicArchive(adopted, () => undefined, at), adopted); assert.equal(query(adopted, {}, () => undefined).length, 1)
  assert.equal(reconcileTopicArchive(snapshot, () => undefined, at).entries[0].status, 'review_required')
})

test('用户规则仍明确复核实体改动；实体停用/删除保留关联ID而排除有效检索', () => {
  let snapshot = graph()
  snapshot = adoptTopicArchive(snapshot, 'fact', 1, resolver, action).snapshot
  const renamed = putUserTopicArchive(snapshot, { kind: 'entity', id: 'alice', expectedEntryVersion: 1, name: 'Alice renamed', aliases: ['Alice'], description: 'Updated' }, resolver, action).snapshot
  assert.equal(renamed.entries.find(entry => entry.id === 'fact').status, 'review_required')
  assert.equal(renamed.entries.find(entry => entry.id === 'fact').origin, 'user_explicit')
  assert.equal(renamed.entries.find(entry => entry.id === 'relation').status, 'review_required')
  const restored = adoptTopicArchive(renamed, 'fact', renamed.entries.find(entry => entry.id === 'fact').version, resolver, action).snapshot
  assert.equal(query(restored, { kinds: ['fact'] }).length, 1)
  const removed = deleteTopicArchiveEntry(restored, 'alice', restored.entries.find(entry => entry.id === 'alice').version, at).snapshot
  assert.equal(removed.entries.find(entry => entry.id === 'fact').status, 'review_required')
  assert.deepEqual(removed.entries.find(entry => entry.id === 'fact').entityIds, ['alice']); assert.ok(decodeTopicArchiveSnapshot(removed))
  assert.equal(adoptTopicArchive(removed, 'fact', removed.entries.find(entry => entry.id === 'fact').version, resolver, action).status, 'invalid')
  const disabled = disableTopicArchive(snapshot, 'alice', 1, at).snapshot
  assert.equal(disabled.entries.find(entry => entry.id === 'relation').status, 'review_required'); assert.deepEqual(query(disabled), [])
})

test('失效实体自身依据使所有active关联待复核，用户采用的关联也需复核', () => {
  let snapshot = graph(); snapshot = adoptTopicArchive(snapshot, 'fact', 1, resolver, action).snapshot
  const reviewed = reconcileTopicArchive(snapshot, () => undefined, at)
  assert.ok(reviewed.entries.every(entry => entry.status === 'review_required')); assert.deepEqual(query(reviewed), [])
  assert.equal(reconcileTopicArchive(reviewed, resolver, at), reviewed)
})

test('公开边界拒绝伪造采用事件、额外字段、不完整语义、无效引用和陈旧版本', () => {
  assert.ok(decodeTopicArchivePut(entity()))
  for (const value of [{ ...entity(), confirmation: action }, { ...entity(), evidence: [{ ...source, revisionId: 'forged' }] }, { ...entity(), kind: 'other' }, { ...entity(), status: 'active', origin: 'user_explicit' }]) assert.equal(decodeTopicArchivePut(value), undefined)
  assert.ok(decodeTopicArchiveUserInput({ kind: 'fact', id: null, expectedEntryVersion: null, title: 'Title', body: 'Body', entityIds: [] }))
  assert.equal(decodeTopicArchiveUserInput({ kind: 'entity', id: null, expectedEntryVersion: null, name: 'Alice', aliases: [], description: '', evidence: [] }), undefined)
  assert.equal(putTopicArchive(graph(), entity(), resolver, at).status, 'stale')
})

test('完整快照验证引用图，active查询投影允许关联实体未被返回', () => {
  const snapshot = graph(), projected = { ...snapshot, entries: query(snapshot, { kinds: ['relation'], forms: ['knows'] }) }
  assert.equal(decodeTopicArchiveSnapshot(projected), undefined); assert.ok(decodeTopicArchiveQuerySnapshot(projected))
  assert.equal(decodeTopicArchiveQuerySnapshot({ ...projected, entries: [{ ...projected.entries[0], status: 'proposal' }] }), undefined)
  assert.ok(decodeTopicArchiveSnapshot(snapshot))
  assert.equal(decodeTopicArchiveSnapshot({ ...snapshot, entries: snapshot.entries.map(entry => entry.id === 'alice' ? { ...entry, confirmation: action } : entry) }), undefined)
})
