import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTopicTermsJsonExport, buildTopicTermsMarkdownExport } from '../dist/client/topic-terms-export.js'

const at = '2026-10-06T10:00:00.000Z'
const statuses = ['proposal', 'active', 'conflict', 'review_required', 'disabled']
function fixture() {
  return {
    topicName: 'Synthetic/topic *档案*', exportedAt: at, rememberHistory: false, storageStatus: 'memory',
    snapshot: { schemaVersion: 1, ownerId: 'owner', topicId: 'topic', version: 9, activeVersion: 4, updatedAt: at,
      entries: statuses.map((status, index) => ({
        id: `term${index}`, version: index + 1, sourceLanguage: index ? 'English' : null, targetLanguage: '中文',
        sourceForms: [`API${index}`], aliases: ['alias|form'], sense: 'sense\n# second line', preferred: `接口${index}`, forbidden: ['interface'],
        status, origin: index === 1 ? 'user_explicit' : 'inferred',
        evidence: [{ kind: index === 1 ? 'final' : 'source', role: index === 1 ? 'example' : 'basis', sessionId: 'session', unitId: 'unit',
          revisionId: index === 1 ? 'revision' : null, selectionEventId: index === 1 ? 'event' : null, range: { start: 2, end: 5 } }],
        confirmation: index === 1 ? { eventId: 'adoption', at, adoptedEntryVersion: 1 } : null, createdAt: at, updatedAt: at,
      })),
    },
    evidenceAvailability: statuses.map((_, index) => ({ entryId: `term${index}`, evidenceIndex: 0,
      sessionName: index < 2 ? 'Synthetic session' : null, unitOrder: index < 2 ? 1 : null, revisionOrder: index === 1 ? 2 : null, readable: index < 2 })),
  }
}

test('主题术语JSON保留所有状态/版本/确认/引用与保存实际状态，仅投影现有快照', () => {
  const input = fixture(), before = structuredClone(input)
  const output = buildTopicTermsJsonExport(input), data = JSON.parse(output.content)
  assert.deepEqual(input, before)
  assert.equal(data.format, 'dsh-translation-topic-terms'); assert.equal(data.schemaVersion, 1)
  assert.equal(data.ownerId, 'owner'); assert.equal(data.topicId, 'topic'); assert.equal(data.exportedAt, at)
  assert.equal(data.topicName, input.topicName); assert.deepEqual(data.snapshot, input.snapshot)
  assert.deepEqual(data.snapshot.entries.map(entry => entry.status), statuses)
  assert.deepEqual(data.evidenceAvailability, input.evidenceAvailability)
  assert.deepEqual(data.storage, { rememberHistory: false, status: 'memory' })
  assert.equal(data.automaticExtractionTriggered, false); assert.equal(data.organizationTriggered, false)
  assert.deepEqual(data.excludes, ['evidence_bodies', 'main_chat', 'complete_topic_backup'])
  assert.equal(output.mimeType, 'application/json;charset=utf-8'); assert.match(output.fileName, /^Synthetic_topic _档案_-terms-.*\.json$/)
  input.snapshot.entries[0].preferred = 'later edit'
  assert.equal(JSON.parse(output.content).snapshot.entries[0].preferred, '接口0')
})

test('主题术语Markdown保留状态与确认，引用标签/身份/范围及失效说明；不伪造整理或落盘', () => {
  const input = fixture(), before = JSON.stringify(input), output = buildTopicTermsMarkdownExport(input)
  assert.equal(JSON.stringify(input), before)
  for (const status of statuses) assert.ok(output.content.includes(`（${status}）`))
  assert.match(output.content, /事件 adoption/); assert.match(output.content, /采用前条目版本 1/)
  assert.match(output.content, /档案版本：9；生效集版本：4/)
  assert.match(output.content, /会话 ID：session；单元 ID：unit/)
  assert.match(output.content, /版本 ID：revision；最终选择事件 ID：event/)
  assert.match(output.content, /\[2, 5\)（Unicode 码点）/)
  assert.match(output.content, /Synthetic session · 文本 1 · 版本 2/)
  assert.match(output.content, /可读（正文未导出）/); assert.match(output.content, /依据已变化或不可用/)
  assert.match(output.content, /未触发自动提炼或整理/); assert.match(output.content, /不包含来源正文、主聊天或完整主题备份/)
  assert.match(output.content, /实际保存状态：仅本次运行/)
  assert.match(output.content, /\\\*档案\\\*/); assert.match(output.content, /alias\\\|form/)
  assert.equal(output.mimeType, 'text/markdown;charset=utf-8'); assert.match(output.fileName, /\.md$/)
})

test('空档案可导出；缺失可读性不假定可读；保存错误/冲突与enabled分开说明', () => {
  const input = fixture(); input.rememberHistory = true; input.storageStatus = 'error'; input.evidenceAvailability = []
  assert.match(buildTopicTermsMarkdownExport(input).content, /保存失败.*不代表已可靠落盘/)
  assert.match(buildTopicTermsMarkdownExport(input).content, /未提供，无法确认来源是否可读/)
  input.storageStatus = 'conflict'
  assert.match(buildTopicTermsMarkdownExport(input).content, /当前快照可能与已保存副本不同/)
  input.snapshot.entries = []; input.snapshot.version = 0; input.snapshot.activeVersion = 0
  assert.match(buildTopicTermsMarkdownExport(input).content, /暂无术语/)
  assert.deepEqual(JSON.parse(buildTopicTermsJsonExport(input).content).snapshot.entries, [])
})

test('主题导出文件名按Unicode码点截取，不切断UTF16代理对，替换非法字符', () => {
  const input = fixture(); input.topicName = `${'A'.repeat(99)}😀ending`
  for (const build of [buildTopicTermsJsonExport, buildTopicTermsMarkdownExport]) {
    const output = build(input)
    assert.ok(output.fileName.startsWith(`${'A'.repeat(99)}😀-terms-`))
    assert.equal([...output.fileName].some(character => character.length === 1 && /[\uD800-\uDFFF]/.test(character)), false)
  }
  input.topicName = 'Synthetic<>:"/\\|?*.'
  assert.match(buildTopicTermsJsonExport(input).fileName, /^Synthetic_________-terms-/)
})
