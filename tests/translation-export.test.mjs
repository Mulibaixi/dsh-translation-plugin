import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFinalTextExport, buildFullRecordExport } from '../dist/client/translation-export.js'
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
