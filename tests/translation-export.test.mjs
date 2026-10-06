import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFinalTextExport, buildBilingualExport, buildTopicFinalTextExport, buildTopicBilingualExport, buildFullRecordExport } from '../dist/client/translation-export.js'
import { emptyTranslationHistory, appendTextUnit, appendTextRevision, appendManualRevision, finalizeLastUnit, selectFinalRevision } from '../dist/client/translation-history.js'
import { DEFAULT_SESSION_SETTINGS, newSession } from '../dist/client/sessions.js'
import { QUICK_SYSTEM_PROMPT, reconstructTranslationContext } from '../dist/shared/translation-call.js'

const at = '2026-10-06T08:00:00.000Z'
const session = { ...newSession(DEFAULT_SESSION_SETTINGS, 'synthetic-owner', 'synthetic-session'), name: 'Synthetic/translation', input: 'Synthetic remaining draft' }
const model = { provider: 'synthetic', model: 'translator' }
const metadata = { promptVersion: 'text-runtime-v1', model: { ...model, reasoningEffort: null }, configVersion: null, maxOutputTokens: null, usage: { inputTokens: 7, outputTokens: null } }
function add(history, n, patch = {}) { return appendTextUnit(history, { id: `unit:${n}`, source: `Synthetic source ${n}`, targetLanguage: 'English', instruction: 'Keep synthetic terms', createdAt: at },
  { id: `revision:${n}`, operationId: `op:${n}`, model, draftVersion: n, createdAt: at, updatedAt: at, accepted: true, status: 'completed', text: `Synthetic final ${n}`, message: null, ...patch }) }
function first() { return add(emptyTranslationHistory(), 1) }

test('TXT只复制final指向正文并按单元顺序，不收尾或变更候选', () => {
  let history = add(first(), 2)
  history = appendManualRevision(history, 'unit:1', { id: 'manual:1', baseRevisionId: 'revision:1', text: 'Synthetic candidate', at })
  history = finalizeLastUnit(history, at)
  const before = JSON.stringify(history), result = buildFinalTextExport(session, history, at)
  assert.equal(result.content, 'Synthetic final 1\n\nSynthetic final 2')
  assert.equal(result.complete, true); assert.deepEqual(result.exportedUnitIds, ['unit:1', 'unit:2']); assert.deepEqual(result.missingUnits, [])
  assert.equal(result.mimeType, 'text/plain;charset=utf-8'); assert.match(result.fileName, /^Synthetic_translation-.*\.txt$/)
  assert.equal(JSON.stringify(history), before)
})

test('缺最终列编号与末状态，未授权部分时不生成内容，部分文件有明确标记', () => {
  const history = add(first(), 2, { status: 'failed', text: 'Synthetic partial' })
  const result = buildFinalTextExport(session, history, at)
  assert.equal(result.content, null); assert.equal(result.complete, false)
  assert.deepEqual(result.missingUnits, [{ unitId: 'unit:2', order: 2, latestStatus: 'failed' }])
  const partial = buildFinalTextExport(session, history, at, { allowPartial: true })
  assert.equal(partial.content, 'Synthetic final 1'); assert.match(partial.fileName, /-partial\.txt$/)
  assert.deepEqual(partial.exportedUnitIds, ['unit:1']); assert.equal(partial.complete, false)
})

test('无任何final即使允许部分也不制造空全文，最新失败不采用旧成功', () => {
  const history = appendTextRevision(first(), 'unit:1', { id: 'revision:2', operationId: 'op:2', model, draftVersion: 2, createdAt: at, updatedAt: at,
    accepted: true, status: 'failed', text: 'Synthetic partial', message: null })
  assert.equal(buildFinalTextExport(session, finalizeLastUnit(history, at), at, { allowPartial: true }).content, null)
  assert.equal(buildFinalTextExport(session, emptyTranslationHistory(), at).content, null)
})

test('用户固定版维持，人工候选仅通过明确收尾转换成为自动最终', () => {
  const manual = appendManualRevision(first(), 'unit:1', { id: 'manual:1', baseRevisionId: 'revision:1', text: 'Synthetic manual final', at })
  assert.equal(buildFinalTextExport(session, manual, at).content, null)
  assert.equal(buildFinalTextExport(session, finalizeLastUnit(manual, at), at).content, 'Synthetic manual final')
  const fixed = selectFinalRevision(manual, 'unit:1', 'revision:1', at)
  assert.equal(buildFinalTextExport(session, finalizeLastUnit(fixed, at), at).content, 'Synthetic final 1')
})

test('完整JSON冻结浏览器来源与时间/全部版本事件/安全调用证据，已知prompt仅一份', () => {
  let history = add(emptyTranslationHistory(), 1, { callRecord: metadata })
  history = appendManualRevision(history, 'unit:1', { id: 'manual:1', baseRevisionId: 'revision:1', text: 'Synthetic manual', at })
  const result = buildFullRecordExport(session, history, at), json = JSON.parse(result.content)
  assert.equal(json.format, 'dsh-translation-session'); assert.equal(json.schemaVersion, 1); assert.equal(json.exportedAt, at)
  assert.deepEqual(json.session, session); assert.deepEqual(json.history, history)
  assert.equal(json.history.units[0].revisions.length, 2); assert.equal(json.history.units[0].revisions[1].callRecord, null)
  assert.equal(json.history.units[0].revisions[0].callRecord.usage.inputTokens, 7); assert.equal(json.history.units[0].revisions[0].callRecord.usage.outputTokens, null)
  assert.equal(json.promptDefinitions.length, 1); assert.equal(json.promptDefinitions[0].systemPrompt, QUICK_SYSTEM_PROMPT)
  assert.deepEqual(json.promptDefinitions[0].userMessageFields, { target_language: 'unit.targetLanguage', translation_requirements: 'unit.instruction', source_text: 'unit.source' })
  assert.deepEqual(JSON.parse(reconstructTranslationContext(json.history.units[0]).userMessage), { target_language: 'English', translation_requirements: 'Keep synthetic terms', source_text: 'Synthetic source 1' })
  assert.equal(json.summary.complete, false); assert.equal(json.summary.missingUnits[0].order, 1)
  assert.ok(!result.content.includes('sessionKey')); assert.ok(!result.content.includes('credentials'))
})

test('旧call=null不凭当前prompt猜测旧真实调用，JSON保留失败及缺final', () => {
  const history = add(first(), 2, { status: 'failed', text: 'Synthetic partial' })
  const result = buildFullRecordExport(session, history, at), json = JSON.parse(result.content)
  assert.deepEqual(json.promptDefinitions, []); assert.equal(json.history.units[0].revisions[0].callRecord, null)
  assert.equal(json.history.units[1].revisions[0].status, 'failed'); assert.equal(json.summary.complete, false)
  assert.match(result.fileName, /-records\.json$/); assert.equal(result.mimeType, 'application/json;charset=utf-8')
})

test('对照JSON只成对投影原文与已选最终，排除草稿、其余版本及调用元数据', () => {
  let history = add(emptyTranslationHistory(), 1, { callRecord: metadata })
  history = appendManualRevision(history, 'unit:1', { id: 'manual:1', baseRevisionId: 'revision:1', text: 'Synthetic selected manual', at })
  history = selectFinalRevision(history, 'unit:1', 'manual:1', at)
  history = appendTextRevision(history, 'unit:1', { id: 'revision:later', operationId: 'op:later', model, draftVersion: 2, createdAt: at, updatedAt: at,
    accepted: true, status: 'failed', text: 'Synthetic later failed candidate', message: null })
  const before = JSON.stringify({ session, history }), result = buildBilingualExport(session, history, at), json = JSON.parse(result.content)
  assert.equal(json.format, 'dsh-translation-bilingual'); assert.equal(json.schemaVersion, 1); assert.equal(json.scope, 'session'); assert.equal(json.exportedAt, at)
  assert.deepEqual(json.topic, { ownerId: session.ownerId, topicId: session.topicId, topicName: session.topicName })
  assert.deepEqual(json.sessions, [{ id: session.id, name: session.name, remark: session.remark, sequence: session.sequence, units: [{
    unitId: 'unit:1', order: 1, source: 'Synthetic source 1', targetLanguage: 'English', status: 'final', translation: 'Synthetic selected manual',
  }] }])
  assert.equal(result.complete, true); assert.deepEqual(result.exportedUnitIds, ['unit:1']); assert.deepEqual(result.missingUnits, [])
  assert.equal(result.mimeType, 'application/json;charset=utf-8'); assert.match(result.fileName, /-bilingual\.json$/)
  for (const forbidden of ['Synthetic remaining draft', 'Synthetic later failed candidate', 'Synthetic final 1', 'Keep synthetic terms', 'callRecord', 'promptDefinitions', 'revisions', 'operationId', 'draftVersion']) assert.ok(!result.content.includes(forbidden), forbidden)
  assert.equal(JSON.stringify({ session, history }), before)
})

function topicSession(n, patch = {}) {
  return { ...newSession(DEFAULT_SESSION_SETTINGS, 'synthetic-owner', `topic-session:${n}`, 'Synthetic shared topic', null, 'topic:shared', 'sequence:shared', n), ...patch }
}
const topic = { ownerId: 'synthetic-owner', topicId: 'topic:shared', topicName: 'Synthetic shared topic' }

test('主题导出按固定会话序号和单元编号排序，包含归档，空会话不生成正文', () => {
  const primary = topicSession(0, { remark: 'Synthetic primary remark' }), archived = topicSession(7, { remark: 'Synthetic archived remark', archivedAt: at }), empty = topicSession(2)
  const primaryHistory = finalizeLastUnit(add(first(), 2), at)
  const reordered = { ...primaryHistory, units: [...primaryHistory.units].reverse() }
  const entries = [{ session: archived, history: finalizeLastUnit(add(emptyTranslationHistory(), 3), at) },
    { session: empty, history: emptyTranslationHistory() }, { session: primary, history: reordered }]
  const before = JSON.stringify(entries), txt = buildTopicFinalTextExport(topic, entries, at), paired = buildTopicBilingualExport(topic, entries, at), json = JSON.parse(paired.content)
  assert.equal(txt.content, 'Synthetic final 1\n\nSynthetic final 2\n\nSynthetic final 3')
  assert.ok(!txt.content.includes('remark')); assert.ok(!txt.content.includes('topic'))
  assert.deepEqual(txt.exportedUnitIds, ['unit:1', 'unit:2', 'unit:3']); assert.equal(txt.complete, true)
  assert.match(txt.fileName, /-topic\.txt$/); assert.match(paired.fileName, /-topic-bilingual\.json$/)
  assert.equal(json.scope, 'topic'); assert.deepEqual(json.topic, topic)
  assert.deepEqual(json.sessions.map(entry => [entry.id, entry.sequence, entry.remark]), [[primary.id, 0, primary.remark], [empty.id, 2, ''], [archived.id, 7, archived.remark]])
  assert.deepEqual(json.sessions[0].units.map(unit => unit.order), [1, 2]); assert.deepEqual(json.sessions[1].units, [])
  assert.equal(JSON.stringify(entries), before)
})

test('两格式缺项需明确允许部分，主题缺项携带会话归属且JSON保留missing', () => {
  const primary = topicSession(0), secondary = topicSession(4)
  const entries = [{ session: secondary, history: add(emptyTranslationHistory(), 1, { status: 'failed', text: 'Synthetic failed partial' }) },
    { session: primary, history: add(first(), 2, { status: 'unknown', text: 'Synthetic unknown partial' }) }]
  const missing = [{ unitId: 'unit:2', order: 2, latestStatus: 'unknown', sessionId: primary.id, sessionName: primary.name, sessionSequence: 0 },
    { unitId: 'unit:1', order: 1, latestStatus: 'failed', sessionId: secondary.id, sessionName: secondary.name, sessionSequence: 4 }]
  const before = JSON.stringify(entries)
  for (const build of [buildTopicFinalTextExport, buildTopicBilingualExport]) {
    const denied = build(topic, entries, at), allowed = build(topic, entries, at, { allowPartial: true })
    assert.equal(denied.content, null); assert.equal(denied.complete, false); assert.deepEqual(denied.missingUnits, missing)
    assert.notEqual(allowed.content, null); assert.equal(allowed.complete, false); assert.deepEqual(allowed.missingUnits, missing)
    assert.deepEqual(allowed.exportedUnitIds, ['unit:1']); assert.match(allowed.fileName, /-partial\.(txt|json)$/)
  }
  const json = JSON.parse(buildTopicBilingualExport(topic, entries, at, { allowPartial: true }).content)
  assert.deepEqual(json.sessions[0].units[1], { unitId: 'unit:2', order: 2, source: 'Synthetic source 2', targetLanguage: 'English', status: 'missing', translation: null })
  assert.deepEqual(json.sessions[1].units[0], { unitId: 'unit:1', order: 1, source: 'Synthetic source 1', targetLanguage: 'English', status: 'missing', translation: null })
  assert.deepEqual(json.summary.missingUnits, missing); assert.ok(!JSON.stringify(json).includes('Synthetic failed partial'))
  const single = buildBilingualExport(primary, entries[1].history, at)
  assert.equal(single.content, null); assert.deepEqual(single.missingUnits, missing.slice(0, 1))
  assert.notEqual(buildBilingualExport(primary, entries[1].history, at, { allowPartial: true }).content, null)
  assert.equal(JSON.stringify(entries), before)
})

test('缺最终、失败、不完整和未受理正文的资格与TXT一致，全缺即使允许部分也无文件', () => {
  for (const patch of [{}, { status: 'failed' }, { status: 'running' }, { status: 'unknown' }, { status: 'completed', accepted: false }, { text: '  ' }]) {
    const raw = first(), revision = { ...raw.units[0].revisions[0], ...patch }
    const history = { ...raw, units: [{ ...raw.units[0], revisions: [revision], final: Object.keys(patch).length ? { revisionId: revision.id, selection: 'automatic', selectedAt: at } : null }] }
    const scopedSession = topicSession(0), entries = [{ session: scopedSession, history }]
    assert.equal(buildFinalTextExport(scopedSession, history, at, { allowPartial: true }).content, null)
    for (const build of [buildTopicFinalTextExport, buildTopicBilingualExport]) {
      const result = build(topic, entries, at, { allowPartial: true })
      assert.equal(result.content, null); assert.equal(result.complete, false); assert.equal(result.missingUnits.length, 1)
    }
    assert.equal(buildBilingualExport(scopedSession, history, at, { allowPartial: true }).content, null)
  }
  for (const entries of [[], [{ session: topicSession(0), history: emptyTranslationHistory() }]]) {
    assert.equal(buildTopicFinalTextExport(topic, entries, at, { allowPartial: true }).content, null)
    assert.equal(buildTopicBilingualExport(topic, entries, at, { allowPartial: true }).content, null)
  }
})

test('主题范围只认owner/topic标识，同名跨范围或重复会话拒绝合并', () => {
  const scopedSession = topicSession(0), history = finalizeLastUnit(first(), at)
  for (const build of [buildTopicFinalTextExport, buildTopicBilingualExport]) {
    for (const patch of [{ ownerId: 'another-owner' }, { topicId: 'another-topic' }]) {
      assert.throws(() => build(topic, [{ session: { ...scopedSession, ...patch }, history }], at), /outside the topic scope/)
    }
    assert.throws(() => build(topic, [{ session: scopedSession, history }, { session: { ...scopedSession }, history }], at), /Duplicate translation export session/)
    const renamed = build({ ...topic, topicName: 'Frozen renamed topic' }, [{ session: scopedSession, history }], at)
    assert.notEqual(renamed.content, null)
  }
})
