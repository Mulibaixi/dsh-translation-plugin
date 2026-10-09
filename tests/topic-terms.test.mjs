import assert from 'node:assert/strict'
import test from 'node:test'
import {
  emptyTopicTerms, decodeTopicTermSnapshot, decodeTopicTermPut, putTopicTerm, adoptTopicTerm, disableTopicTerm,
  resolveTermEvidence, reconcileTopicTerms, queryTopicTerms,
} from '../dist/memory/topic-terms.js'

const at = '2026-10-06T01:00:00.000Z', later = '2026-10-06T02:00:00.000Z'
const ownerId = 'synthetic-owner', topicId = 'synthetic-topic'
const source = { kind: 'source', sessionId: 'synthetic-session', unitId: 'unit:1', revisionId: null, selectionEventId: null, range: null, role: 'basis' }
const final = { ...source, kind: 'final', revisionId: 'revision:1', selectionEventId: 'text-event:1' }
const fact = { ownerId, topicId, sourceVersion: 1, source: '合成 source 😀 API', final: { revisionId: 'revision:1', selectionEventId: 'text-event:1', sourceVersion: 1, text: '合成最终 API' } }
const resolver = (sessionId, unitId) => sessionId === source.sessionId && unitId === source.unitId ? fact : undefined
const empty = () => emptyTopicTerms(ownerId, topicId, at)
function input(id = 'term:1', edits = {}) {
  return { id, expectedEntryVersion: null, sourceLanguage: 'English', targetLanguage: '中文', sourceForms: ['API'], aliases: ['application programming interface'],
    sense: '合成接口范围', preferred: '接口', forbidden: ['应用'], evidence: [source], origin: 'source_checked', status: 'active', ...edits }
}
function put(snapshot = empty(), edits = {}, id = 'term:1') { return putTopicTerm(snapshot, input(id, edits), resolver, at) }
function query(snapshot, edits = {}, evidenceResolver = resolver) {
  return queryTopicTerms(snapshot, { mode: 'normal', ownerId, topicId, sourceLanguage: 'English', targetLanguage: '中文', forms: ['API'], ...edits }, evidenceResolver)
}

test('术语边界只接受引用和合法语义，不接凭据、正文副本或模型伪造确认', () => {
  assert.deepEqual(decodeTopicTermSnapshot(empty()), empty())
  assert.deepEqual(decodeTopicTermPut(input()), input())
  for (const extra of [{ credentials: 'synthetic' }, { confirmation: { eventId: 'fake', at } }, { user_confirmed: true }, { quote: 'copied body' }]) {
    assert.equal(decodeTopicTermPut({ ...input(), ...extra }), undefined)
  }
  assert.equal(decodeTopicTermPut(input('term:1', { origin: 'user_explicit' })), undefined)
  assert.equal(decodeTopicTermPut(input('term:1', { origin: 'inferred' })), undefined)
  assert.equal(decodeTopicTermPut(input('term:1', { evidence: [final] })), undefined)
  assert.equal(decodeTopicTermPut(input('term:1', { evidence: [{ ...source, sourceVersion: 0 }] })), undefined)
  assert.equal(decodeTopicTermPut(input('term:1', { evidence: [{ ...final, sourceVersion: 2 }] })), undefined)
  assert.equal(decodeTopicTermPut(input('term:1', { evidence: [{ ...source, range: { start: -1, end: 2 } }] })), undefined)
  assert.equal(decodeTopicTermPut(input('term:1', { evidence: [{ ...final, selectionEventId: null }] })), undefined)
  assert.equal(decodeTopicTermPut(input('term:1', { forbidden: ['接口'] })), undefined)
})

test('档案边界校验条目版本、身份、确认事件和active来源，读取不改写输入', () => {
  const snapshot = put().snapshot, raw = structuredClone(snapshot)
  const decoded = decodeTopicTermSnapshot(raw)
  assert.deepEqual(decoded, raw); assert.notEqual(decoded.entries[0], raw.entries[0])
  for (const patch of [{ activeVersion: snapshot.version + 1 }, { schemaVersion: 2 }, { ownerId: '' }, { credentials: 'synthetic' }]) {
    assert.equal(decodeTopicTermSnapshot({ ...raw, ...patch }), undefined)
  }
  for (const patch of [{ origin: 'inferred' }, { origin: 'user_explicit', confirmation: null }, { evidence: [final] }, { version: snapshot.version + 1 }, { sourceCopy: 'synthetic' }]) {
    assert.equal(decodeTopicTermSnapshot({ ...raw, entries: [{ ...raw.entries[0], ...patch }] }), undefined)
  }
  const adopted = adoptTopicTerm(snapshot, 'term:1', 1, { eventId: 'user-adopt:1', at: later }).snapshot
  assert.ok(decodeTopicTermSnapshot(adopted)); assert.deepEqual(raw, snapshot)
})

test('提案变化不改activeVersion，相同内容和单纯时间变化不增版本', () => {
  const first = put(empty(), { origin: 'inferred', status: 'proposal' })
  assert.equal(first.status, 'updated'); assert.equal(first.snapshot.version, 1); assert.equal(first.snapshot.activeVersion, 0)
  const second = putTopicTerm(first.snapshot, input('term:1', { expectedEntryVersion: 1, origin: 'inferred', status: 'proposal', preferred: '程序接口' }), resolver, later)
  assert.equal(second.snapshot.version, 2); assert.equal(second.snapshot.activeVersion, 0); assert.equal(second.entry.version, 2)
  const same = putTopicTerm(second.snapshot, input('term:1', { expectedEntryVersion: 2, origin: 'inferred', status: 'proposal', preferred: '程序接口' }), resolver, later)
  assert.equal(same.status, 'unchanged'); assert.equal(same.snapshot, second.snapshot); assert.equal(same.entry.updatedAt, later)
})

test('有效条目变化增加activeVersion，读取和查询不改变时间或版本', () => {
  const first = put().snapshot
  assert.equal(first.activeVersion, 1)
  const second = put(first, { expectedEntryVersion: 1, preferred: '程序接口' }).snapshot
  assert.equal(second.activeVersion, 2); assert.equal(second.version, 2)
  const before = structuredClone(second)
  assert.equal(query(second).length, 1); assert.ok(decodeTopicTermSnapshot(second)); assert.deepEqual(second, before)
  assert.equal(reconcileTopicTerms(second, resolver, later), second)
  const disabled = disableTopicTerm(second, 'term:1', 2, later)
  assert.equal(disabled.snapshot.activeVersion, 3); assert.equal(query(disabled.snapshot).length, 0)
  assert.equal(disableTopicTerm(disabled.snapshot, 'term:1', 3, later).snapshot, disabled.snapshot)
})

test('来源核对active必须有可读原文basis，推断始终只能proposal', () => {
  for (const evidence of [[], [final], [{ ...source, role: 'example' }]]) {
    assert.equal(put(empty(), { evidence }).status, 'invalid')
  }
  assert.equal(putTopicTerm(empty(), input(), () => undefined, at).status, 'invalid')
  assert.equal(put(empty(), { origin: 'inferred' }).status, 'invalid')
  const inferred = put(empty(), { origin: 'inferred', status: 'proposal', evidence: [] }).snapshot
  assert.equal(query(inferred).length, 0)
  assert.equal(put().entry.status, 'active')
})

test('证据按Unicode码点半开范围解析，不复制正文且严格核对owner/topic', () => {
  const selected = { ...source, range: { start: 10, end: 11 } }
  assert.equal(resolveTermEvidence(empty(), selected, resolver), '😀')
  assert.equal(resolveTermEvidence(empty(), { ...source, range: { start: 10, end: 100 } }, resolver), undefined)
  assert.equal(resolveTermEvidence(empty(), source, () => ({ ...fact, ownerId: 'other' })), undefined)
  assert.equal(resolveTermEvidence(empty(), source, () => ({ ...fact, topicId: 'other' })), undefined)
  assert.equal(resolveTermEvidence(empty(), source, () => undefined), undefined)
  const stored = put(empty(), { evidence: [selected] }).snapshot
  assert.equal(JSON.stringify(stored).includes(fact.source), false)
  assert.equal(resolveTermEvidence(stored, final, resolver), fact.final.text)
})

test('来源证据绑定source版本；同字串的source2不复活旧basis，source2与旧final均按版拒绝', () => {
  const current2 = () => ({ ...fact, sourceVersion: 2, final: { ...fact.final, sourceVersion: 1 } })
  const source2 = { ...source, sourceVersion: 2 }
  assert.equal(resolveTermEvidence(empty(), source, current2), undefined, 'legacy source ref means version 1')
  assert.equal(resolveTermEvidence(empty(), { ...source, sourceVersion: 1 }, current2), undefined)
  assert.equal(resolveTermEvidence(empty(), source2, current2), fact.source, 'explicit version 2 resolves the same current text')
  assert.equal(resolveTermEvidence(empty(), final, current2), undefined, 'a selected revision from source 1 is not current on source 2')
  assert.equal(resolveTermEvidence(empty(), final, () => ({ ...fact, sourceVersion: 2, final: { ...fact.final, sourceVersion: 2 } })), fact.final.text)

  const old = put().snapshot
  assert.equal(old.entries[0].evidence[0].sourceVersion, undefined, 'legacy snapshot stays in its original shape')
  assert.deepEqual(decodeTopicTermSnapshot(structuredClone(old)), old)
  const reviewed = reconcileTopicTerms(old, current2, later)
  assert.equal(reviewed.entries[0].status, 'review_required')
  assert.equal(reviewed.entries[0].sourceForms[0], old.entries[0].sourceForms[0])
  assert.equal(query(old, {}, current2).length, 0)
  assert.equal(reconcileTopicTerms(reviewed, resolver, later), reviewed, 'invalidated basis does not silently revive')

  const newBasis = putTopicTerm(empty(), input('term:source2', { evidence: [source2] }), current2, at)
  assert.equal(newBasis.status, 'updated')
  assert.equal(newBasis.entry.evidence[0].sourceVersion, 2, 'explicit source version survives domain copying')
  assert.equal(query(newBasis.snapshot, {}, current2).length, 1)

  const adopted = adoptTopicTerm(old, old.entries[0].id, old.entries[0].version, { eventId: 'user-adopt:source2', at: later }).snapshot
  assert.equal(reconcileTopicTerms(adopted, current2, later), adopted, 'independently adopted rules remain active')
  assert.equal(query(adopted, {}, current2).length, 1)
})

test('normal精确forms/aliases命中，Quick和不同owner/topic/语言为空', () => {
  const snapshot = put().snapshot
  assert.equal(query(snapshot, { forms: ['application programming interface'] }).length, 1)
  for (const changes of [{ mode: 'quick' }, { ownerId: 'other' }, { topicId: 'other' }, { sourceLanguage: null }, { sourceLanguage: '英语' }, { targetLanguage: 'Chinese' },
    { forms: ['合成 API 正文'] }, { forms: ['api'] }, { forms: ['APIs'] }, { forms: ['API.call()'] }]) assert.equal(query(snapshot, changes).length, 0)
  const unknown = put(empty(), { sourceLanguage: null }).snapshot
  assert.equal(query(unknown, { sourceLanguage: null }).length, 1)
  assert.equal(query(unknown).length, 0)
})

test('失去basis立即检索不到并转待复核，重复失效不增加版本', () => {
  const snapshot = put().snapshot
  assert.equal(query(snapshot, {}, () => undefined).length, 0)
  const invalidated = reconcileTopicTerms(snapshot, () => undefined, later)
  assert.equal(invalidated.entries[0].status, 'review_required'); assert.equal(invalidated.version, 2); assert.equal(invalidated.activeVersion, 2)
  assert.equal(reconcileTopicTerms(invalidated, () => undefined, later), invalidated)
  assert.equal(reconcileTopicTerms(invalidated, resolver, later), invalidated)
  assert.equal(query(invalidated).length, 0)
})

test('final依据含selection事件身份，r1→r2→r1不能复活旧事实', () => {
  const snapshot = put(empty(), { evidence: [source, final] }).snapshot
  const replaced = () => ({ ...fact, final: { revisionId: 'revision:2', selectionEventId: 'text-event:2', sourceVersion: 1, text: '新合成最终' } })
  assert.equal(query(snapshot, {}, replaced).length, 0)
  const returned = () => ({ ...fact, final: { ...fact.final, selectionEventId: 'text-event:3' } })
  assert.equal(resolveTermEvidence(snapshot, final, returned), undefined)
  assert.equal(query(snapshot, {}, returned).length, 0)
  const invalidated = reconcileTopicTerms(snapshot, returned, later)
  assert.equal(invalidated.entries[0].status, 'review_required')
  assert.equal(query(snapshot, {}, () => ({ ...fact, final: null })).length, 0)
})

test('用户明确采用记录事件并把依据变例证，例证删除不撤独立用户规则', () => {
  const proposal = put(empty(), { origin: 'inferred', status: 'proposal', evidence: [source, final] }).snapshot
  const adopted = adoptTopicTerm(proposal, 'term:1', 1, { eventId: 'synthetic-ui-adopt:1', at: later })
  assert.equal(adopted.entry.origin, 'user_explicit'); assert.equal(adopted.entry.status, 'active')
  assert.deepEqual(adopted.entry.confirmation, { eventId: 'synthetic-ui-adopt:1', at: later, adoptedEntryVersion: 1 })
  assert.ok(adopted.entry.evidence.every(ref => ref.role === 'example'))
  assert.equal(adopted.snapshot.activeVersion, 1)
  assert.equal(query(adopted.snapshot, {}, () => undefined).length, 1)
  assert.equal(reconcileTopicTerms(adopted.snapshot, () => undefined, later), adopted.snapshot)
  assert.equal(adoptTopicTerm(adopted.snapshot, 'term:1', 2, { eventId: 'synthetic-ui-adopt:2', at: later }).snapshot, adopted.snapshot)
})

test('主模型不能覆盖已采用用户规则，停用后仍需另提新ID', () => {
  const adopted = adoptTopicTerm(put().snapshot, 'term:1', 1, { eventId: 'ui:1', at: later }).snapshot
  const updated = put(adopted, { expectedEntryVersion: 2, preferred: '新版接口' })
  assert.equal(updated.status, 'requires_user_action'); assert.equal(updated.snapshot, adopted)
  const disabled = disableTopicTerm(adopted, 'term:1', 2, later).snapshot
  assert.equal(put(disabled, { expectedEntryVersion: 3 }).status, 'requires_user_action')
  const proposal = put(disabled, { origin: 'inferred', status: 'proposal' }, 'term:2')
  assert.equal(proposal.status, 'updated'); assert.equal(proposal.snapshot.entries[0].origin, 'user_explicit')
})

test('同义同语言交叠形式的冲突不得最新wins，停用旧项后可明确采用', () => {
  const first = put().snapshot
  const next = put(first, { sourceForms: ['other'], aliases: ['API'], preferred: '矛盾译法' }, 'term:2')
  assert.equal(next.status, 'updated'); assert.equal(next.entry.status, 'conflict')
  assert.equal(next.snapshot.activeVersion, first.activeVersion); assert.equal(query(next.snapshot)[0].id, 'term:1')
  const adopt = adoptTopicTerm(next.snapshot, 'term:2', 1, { eventId: 'ui:2', at: later })
  assert.equal(adopt.status, 'conflict'); assert.equal(adopt.snapshot, next.snapshot)
  const disabled = disableTopicTerm(next.snapshot, 'term:1', 1, later).snapshot
  const resolved = adoptTopicTerm(disabled, 'term:2', 1, { eventId: 'ui:3', at: later })
  assert.equal(resolved.status, 'updated'); assert.equal(query(resolved.snapshot)[0].id, 'term:2')
  for (const edits of [{ sense: '其他义项' }, { sourceLanguage: 'French' }, { targetLanguage: '英文' }, { sourceForms: ['unrelated'], aliases: [] }]) {
    assert.equal(put(first, { ...edits, preferred: '不同译法' }, 'term:2').entry.status, 'active')
  }
})

test('写入和采用严格检查expected条目版本，失败不改变任何事实', () => {
  const snapshot = put().snapshot
  for (const change of [put(snapshot, { expectedEntryVersion: null }), put(snapshot, { expectedEntryVersion: 9 }),
    adoptTopicTerm(snapshot, 'term:1', 9, { eventId: 'ui:1', at: later }), disableTopicTerm(snapshot, 'missing', 1, later)]) {
    assert.equal(change.status, 'stale'); assert.equal(change.snapshot, snapshot)
  }
  assert.equal(adoptTopicTerm(snapshot, 'term:1', 1, { eventId: '', at: later }).status, 'invalid')
  assert.equal(disableTopicTerm(snapshot, 'term:1', 1, 'invalid').status, 'invalid')
  assert.equal(putTopicTerm(snapshot, input('term:1', { expectedEntryVersion: 1 }), resolver, 'invalid').status, 'invalid')
})

test('可信转换只复制明确字段，输入数组后续变化不污染档案', () => {
  const request = input(), saved = putTopicTerm(empty(), { ...request, credentials: 'synthetic-unaccepted' }, resolver, at).snapshot
  request.sourceForms.push('later'); request.evidence[0] = { ...source, role: 'example' }
  assert.deepEqual(saved.entries[0].sourceForms, ['API']); assert.equal(saved.entries[0].evidence[0].role, 'basis')
  assert.equal(JSON.stringify(saved).includes('credentials'), false)
  const reordered = Object.fromEntries(Object.entries(saved.entries[0]).reverse())
  const decoded = decodeTopicTermSnapshot({ ...saved, entries: [reordered] })
  assert.equal(put(decoded, { expectedEntryVersion: 1 }).status, 'unchanged')
})
