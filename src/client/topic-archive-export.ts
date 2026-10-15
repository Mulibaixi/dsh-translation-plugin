import type { TopicArchiveEntry, TopicArchiveSnapshot } from '../memory/topic-archive.js'
import type { TermEvidenceRef, TopicTermSnapshot } from '../memory/topic-terms.js'
import type { HistoryStatus } from './session-store.js'
import { buildTopicTermsMarkdownExport, type TopicEvidenceAvailability } from './topic-terms-export.js'

export interface TopicArchiveExport { readonly content: string; readonly fileName: string; readonly mimeType: string }
export interface TopicArchiveExportSnapshot {
  readonly topicName: string; readonly terms: TopicTermSnapshot; readonly archive: TopicArchiveSnapshot; readonly exportedAt: string
  readonly rememberHistory: boolean; readonly termsStorageStatus: HistoryStatus; readonly archiveStorageStatus: HistoryStatus
  readonly termEvidenceAvailability: readonly TopicEvidenceAvailability[]; readonly archiveEvidenceAvailability: readonly TopicEvidenceAvailability[]
}
const statusLabels = { proposal: '待确认', active: '生效', review_required: '待复核', disabled: '已停用' } as const
const originLabels = { inferred: '模型提案', source_checked: '原文依据', reference_derived: '参考资料（主模型解读）', user_explicit: '用户采用' } as const
const kindLabels = { entity: '实体', fact: '事实', relation: '关系' } as const
const storageLabels = { memory: '仅本次运行', saved: '已保存', conflict: '存在存储冲突，当前快照可能与已保存副本不同', error: '保存失败，当前快照不代表已可靠落盘' } as const
function scope(input: TopicArchiveExportSnapshot): void {
  if (input.terms.ownerId !== input.archive.ownerId || input.terms.topicId !== input.archive.topicId) throw new Error('Topic export scope mismatch')
}
function fileName(input: TopicArchiveExportSnapshot, extension: string): string {
  const safe = input.topicName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '')
  return `${[...safe].slice(0, 100).join('') || 'topic'}-archive-${input.exportedAt.replace(/[^0-9TZ]/g, '')}.${extension}`
}
/** The frozen inputs include entry content and reference labels, never referenced evidence bodies. */
export function buildTopicArchiveJsonExport(input: TopicArchiveExportSnapshot): TopicArchiveExport {
  scope(input)
  return { fileName: fileName(input, 'json'), mimeType: 'application/json;charset=utf-8', content: JSON.stringify({
    format: 'dsh-translation-topic-archive', schemaVersion: 1, exportedAt: input.exportedAt,
    ownerId: input.archive.ownerId, topicId: input.archive.topicId, topicName: input.topicName,
    scope: 'existing_topic_structured_snapshots', automaticExtractionTriggered: false, organizationTriggered: false,
    excludes: ['evidence_bodies', 'main_chat', 'complete_topic_backup'],
    storage: { rememberHistory: input.rememberHistory, terms: input.termsStorageStatus, archive: input.archiveStorageStatus },
    terms: input.terms, archive: input.archive,
    evidenceAvailability: { terms: input.termEvidenceAvailability, archive: input.archiveEvidenceAvailability },
  }, null, 2) }
}
function md(value: string): string { return value.replace(/[\\`*_{}\[\]()<>#+!|~\-]/g, '\\$&').replace(/\r?\n/g, '  \n  ') }
function entityLabel(snapshot: TopicArchiveSnapshot, id: string): string {
  const entry = snapshot.entries.find(entry => entry.id === id)
  return entry?.kind === 'entity' ? `${md(entry.name)}（ID：${md(id)}；${statusLabels[entry.status]}）` : `实体不可用（ID：${md(id)}）`
}
function entryTitle(snapshot: TopicArchiveSnapshot, entry: TopicArchiveEntry): string {
  return entry.kind === 'entity' ? md(entry.name) : entry.kind === 'fact' ? md(entry.title) : `${entityLabel(snapshot, entry.sourceEntityId)} → ${md(entry.relation)} → ${entityLabel(snapshot, entry.targetEntityId)}`
}
function semanticLines(snapshot: TopicArchiveSnapshot, entry: TopicArchiveEntry): readonly string[] {
  return entry.kind === 'entity' ? [`- 名称：${md(entry.name)}`, `- 别名：${entry.aliases.map(md).join('、') || '无'}`, `- 描述：${md(entry.description) || '未提供'}`] :
    entry.kind === 'fact' ? [`- 标题：${md(entry.title)}`, `- 正文：${md(entry.body)}`, `- 关联实体：${entry.entityIds.map(id => entityLabel(snapshot, id)).join('、') || '无'}`] :
      [`- 源实体：${entityLabel(snapshot, entry.sourceEntityId)}`, `- 关系：${md(entry.relation)}`, `- 目标实体：${entityLabel(snapshot, entry.targetEntityId)}`, `- 描述：${md(entry.description) || '未提供'}`]
}
function referenceLines(ref: TermEvidenceRef): readonly string[] {
  if (ref.kind === 'reference') return ['- 参考资料：' + md(ref.referenceId), '- 片段：' + md(ref.segmentId) + '；来源为主模型解读；不等于用户确认']
  return [`- 类型：${ref.kind === 'source' ? '原文' : '最终译文'}；用途：${ref.role === 'basis' ? '依据' : '示例'}`,
    `- 会话 ID：${md(ref.sessionId)}；单元 ID：${md(ref.unitId)}`,
    `- 版本 ID：${ref.revisionId === null ? '无' : md(ref.revisionId)}；最终选择事件 ID：${ref.selectionEventId === null ? '无' : md(ref.selectionEventId)}`,
    `- 范围：${ref.range === null ? '完整引用' : `[${ref.range.start}, ${ref.range.end})（Unicode 码点）`}`]
}
export function buildTopicArchiveMarkdownExport(input: TopicArchiveExportSnapshot): TopicArchiveExport {
  scope(input)
  const { archive } = input
  const lines = [`# ${md(input.topicName)} · 主题结构化档案快照`, '',
    '导出现有术语、实体、事实和关系的所有状态与版本，未触发自动提炼或整理。不包含证据正文、主聊天或完整主题备份。', '',
    `- 导出时间：${md(input.exportedAt)}`, `- 主题创建来源 ID：${md(archive.ownerId)}`, `- 主题 ID：${md(archive.topicId)}`,
    `- 历史保存开关：${input.rememberHistory ? '开启' : '关闭'}`,
    `- 术语实际保存状态：${storageLabels[input.termsStorageStatus]}`, `- 档案实际保存状态：${storageLabels[input.archiveStorageStatus]}`,
    '- 本文件记录冻结时的内存快照，不提供导入。', '',
    buildTopicTermsMarkdownExport({ topicName: input.topicName, snapshot: input.terms, exportedAt: input.exportedAt,
      rememberHistory: input.rememberHistory, storageStatus: input.termsStorageStatus, evidenceAvailability: input.termEvidenceAvailability }).content.replace(/^(#{1,4}) /gm, '$1# '), '',
    '## 实体、事实和关系', '', `- 档案版本：${archive.version}；生效集版本：${archive.activeVersion}`, `- 档案更新时间：${md(archive.updatedAt)}`, '']
  if (!archive.entries.length) lines.push('暂无实体、事实或关系。', '')
  for (const entry of archive.entries) {
    lines.push(`### ${kindLabels[entry.kind]} · ${entryTitle(archive, entry)}`, '', `- 条目 ID：${md(entry.id)}；版本：${entry.version}`,
      `- 状态：${statusLabels[entry.status]}（${entry.status}）；来源：${originLabels[entry.origin]}（${entry.origin}）`, ...semanticLines(archive, entry),
      `- 创建：${md(entry.createdAt)}；更新：${md(entry.updatedAt)}`,
      entry.confirmation ? `- 用户确认：事件 ${md(entry.confirmation.eventId)}；时间 ${md(entry.confirmation.at)}；采用前条目版本 ${entry.confirmation.adoptedEntryVersion}` : '- 用户确认：无', '', '#### 证据引用', '')
    if (!entry.evidence.length) lines.push('无证据引用。', '')
    entry.evidence.forEach((ref, index) => {
      const availability = input.archiveEvidenceAvailability.find(item => item.entryId === entry.id && item.evidenceIndex === index)
      const label = availability?.sourceLabel ?? (availability ? `${availability.sessionName ?? '会话不可用'} · ${availability.unitOrder === null ? '单元不可用' : `文本 ${availability.unitOrder}`}${availability.revisionOrder === null ? '' : ` · 版本 ${availability.revisionOrder}`}` : '来源标签未提供')
      lines.push(`##### 引用 ${index + 1}`, '', `- 来源：${md(label)}`,
        `- 冻结时可读性：${availability?.readability === 'not_loaded' ? '本次未读取参考片段，未确认可读性（正文未导出）' : availability ? availability.readable ? '可读（正文未导出）' : '依据已变化或不可用（正文未导出）' : '未提供，无法确认来源是否可读'}`,
        ...referenceLines(ref), '')
    })
  }
  return { content: lines.join('\n'), fileName: fileName(input, 'md'), mimeType: 'text/markdown;charset=utf-8' }
}
