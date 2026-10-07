import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTopicArchiveJsonExport, buildTopicArchiveMarkdownExport } from '../dist/client/topic-archive-export.js'
import { emptyTopicArchive, putUserTopicArchive, putTopicArchive, deleteTopicArchiveEntry } from '../dist/memory/topic-archive.js'
import { emptyTopicTerms, putTopicTerm } from '../dist/memory/topic-terms.js'

const at = '2026-10-07T00:00:00.000Z'
const evidence = { kind: 'source', role: 'basis', sessionId: 'session', unitId: 'unit', revisionId: null, selectionEventId: null, range: { start: 1, end: 3 } }
const resolver = () => ({ ownerId: 'owner', topicId: 'topic', source: 'SECRET SYNTHETIC EVIDENCE BODY', final: null })
function fixture() {
  let archive = emptyTopicArchive('owner', 'topic', at)
  archive = putUserTopicArchive(archive, { kind: 'entity', id: 'alice', expectedEntryVersion: null, name: 'Alice *entity*', aliases: ['A'], description: 'Synthetic entity description' }, resolver, { eventId: 'adopt', at }).snapshot
  archive = putTopicArchive(archive, { kind: 'fact', id: 'fact', expectedEntryVersion: null, title: 'Synthetic fact', body: 'Archive fact body', entityIds: ['alice'], evidence: [evidence], origin: 'inferred', status: 'proposal' }, resolver, at).snapshot
  archive = putTopicArchive(archive, { kind: 'relation', id: 'relation', expectedEntryVersion: null, sourceEntityId: 'alice', relation: 'knows', targetEntityId: 'alice', description: 'Synthetic relation description', evidence: [evidence], origin: 'source_checked', status: 'active' }, resolver, at).snapshot
  const terms = putTopicTerm(emptyTopicTerms('owner', 'topic', at), { id: 'term', expectedEntryVersion: null, sourceLanguage: 'English', targetLanguage: '中文', sourceForms: ['API'], aliases: [], sense: '', preferred: '接口', forbidden: [], evidence: [evidence], origin: 'source_checked', status: 'active' }, resolver, at).snapshot
  return { topicName: 'Synthetic/topic *档案*', terms, archive, exportedAt: at, rememberHistory: false, termsStorageStatus: 'saved', archiveStorageStatus: 'memory',
    termEvidenceAvailability: [{ entryId: 'term', evidenceIndex: 0, sessionName: 'Synthetic session', unitOrder: 1, revisionOrder: null, readable: true }],
    archiveEvidenceAvailability: [{ entryId: 'fact', evidenceIndex: 0, sessionName: 'Synthetic session', unitOrder: 1, revisionOrder: null, readable: true },
      { entryId: 'relation', evidenceIndex: 0, sessionName: null, unitOrder: null, revisionOrder: null, readable: false }] }
}

test('组合JSON冻结术语及档案所有内容/状态/版本/采用/引用，各自保留实际保存状态', () => {
  const input = fixture(), before = structuredClone(input), result = buildTopicArchiveJsonExport(input), data = JSON.parse(result.content)
  assert.deepEqual(input, before); assert.deepEqual(data.terms, input.terms); assert.deepEqual(data.archive, input.archive)
  assert.deepEqual(data.storage, { rememberHistory: false, terms: 'saved', archive: 'memory' })
  assert.deepEqual(data.evidenceAvailability, { terms: input.termEvidenceAvailability, archive: input.archiveEvidenceAvailability })
  assert.equal(data.format, 'dsh-translation-topic-archive'); assert.equal(data.automaticExtractionTriggered, false); assert.equal(data.organizationTriggered, false)
  assert.equal(result.content.includes('SECRET SYNTHETIC EVIDENCE BODY'), false)
  assert.deepEqual(data.excludes, ['evidence_bodies', 'main_chat', 'complete_topic_backup'])
  assert.equal(result.mimeType, 'application/json;charset=utf-8'); assert.match(result.fileName, /^Synthetic_topic _档案_-archive-.*\.json$/)
  input.archive.entries[0].name = 'Later edit'; assert.equal(data.archive.entries[0].name, 'Alice *entity*')
})

test('Markdown按实体名称+ID显示事实和关系引用，完整保留术语及档案引用标签', () => {
  const input = fixture(), before = structuredClone(input), result = buildTopicArchiveMarkdownExport(input)
  assert.deepEqual(input, before)
  for (const value of ['API', '接口', 'Alice', 'Synthetic fact', 'Archive fact body', 'Synthetic relation description', 'knows', '（proposal）', '（active）', '采用前条目版本 1', '档案版本：']) assert.ok(result.content.includes(value), value)
  assert.match(result.content, /Alice \\\*entity\\\*（ID：alice；生效）/)
  assert.match(result.content, /Synthetic session · 文本 1/); assert.match(result.content, /依据已变化或不可用/)
  assert.match(result.content, /会话 ID：session；单元 ID：unit/); assert.match(result.content, /\[1, 3\)（Unicode 码点）/)
  assert.match(result.content, /术语实际保存状态：已保存/); assert.match(result.content, /档案实际保存状态：仅本次运行/)
  assert.equal(result.content.includes('SECRET SYNTHETIC EVIDENCE BODY'), false)
})

test('删除实体的关联明确显示不可用ID与待复核，不伪造来源正文或实体名称', () => {
  const input = fixture()
  input.archive = deleteTopicArchiveEntry(input.archive, 'alice', 2, at).snapshot
  const result = buildTopicArchiveMarkdownExport(input)
  assert.match(result.content, /实体不可用（ID：alice）/); assert.match(result.content, /（review_required）/)
  assert.equal(result.content.includes('Alice'), false)
  input.archiveEvidenceAvailability = []; assert.match(buildTopicArchiveMarkdownExport(input).content, /未提供，无法确认来源是否可读/)
})

test('拒绝不同owner/topic组合，不修改输入；空主题可明确导出', () => {
  const input = fixture()
  for (const build of [buildTopicArchiveJsonExport, buildTopicArchiveMarkdownExport]) {
    assert.throws(() => build({ ...input, archive: { ...input.archive, ownerId: 'other' } }), /scope mismatch/)
    assert.throws(() => build({ ...input, archive: { ...input.archive, topicId: 'other' } }), /scope mismatch/)
  }
  input.terms = emptyTopicTerms('owner', 'topic', at); input.archive = emptyTopicArchive('owner', 'topic', at)
  assert.deepEqual(JSON.parse(buildTopicArchiveJsonExport(input).content).archive.entries, [])
  assert.match(buildTopicArchiveMarkdownExport(input).content, /暂无实体、事实或关系/)
})

test('导出保留disabled/review_required；history on与保存error/conflict分别说明，Unicode文件名不截断字符', () => {
  const input = fixture(); input.rememberHistory = true; input.termsStorageStatus = 'conflict'; input.archiveStorageStatus = 'error'
  input.archive.entries[1].status = 'disabled'; input.archive.entries[2].status = 'review_required'
  const result = buildTopicArchiveMarkdownExport(input)
  assert.match(result.content, /（disabled）/); assert.match(result.content, /（review_required）/)
  assert.match(result.content, /当前快照可能与已保存副本不同/); assert.match(result.content, /不代表已可靠落盘/)
  input.topicName = `${'A'.repeat(99)}😀tail`
  assert.ok(buildTopicArchiveJsonExport(input).fileName.startsWith(`${'A'.repeat(99)}😀-archive-`))
})
